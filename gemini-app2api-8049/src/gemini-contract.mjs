import crypto from 'node:crypto';
import { plainObject, protocolError, compileToolPolicy } from './tool-protocol.mjs';
import { stripSchemaAnnotations } from './prompt-tool-schema.mjs';
import { canonicalModel, NATIVE_MODELS } from './openai-contract.mjs';
import { normalizeImageUrl } from './image-input.mjs';
import { estimateUsage } from './openai-usage.mjs';

const fail = (code, status = 400, param = null) => {
  throw protocolError(code, status, param);
};

const MODEL_META = Object.freeze({
  'gemini-neon': {
    displayName: 'Gemini Neon',
    description: 'Native Gemini 4 Neon model (512K context)',
    inputTokenLimit: 512000,
    outputTokenLimit: 65536,
  },
  'gemini-hydrogen': {
    displayName: 'Gemini Hydrogen',
    description: 'Native Gemini 4 Hydrogen fast model (512K context)',
    inputTokenLimit: 512000,
    outputTokenLimit: 65536,
  },
  'gemini-flash-lite': {
    displayName: 'Gemini Flash Lite',
    description: 'Native Gemini Flash Lite model',
    inputTokenLimit: 512000,
    outputTokenLimit: 65536,
  },
});

export function describeGeminiModel(id) {
  const canonical = canonicalModel(id);
  if (!NATIVE_MODELS.includes(canonical)) return null;
  const meta = MODEL_META[canonical] ?? {
    displayName: canonical,
    description: canonical,
    inputTokenLimit: 512000,
    outputTokenLimit: 65536,
  };
  return {
    name: `models/${canonical}`,
    version: '001',
    displayName: meta.displayName,
    description: meta.description,
    inputTokenLimit: meta.inputTokenLimit,
    outputTokenLimit: meta.outputTokenLimit,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
  };
}

export function listGeminiModels() {
  return {
    models: NATIVE_MODELS.map(id => describeGeminiModel(id)),
  };
}

function parseToolArgs(raw) {
  if (plainObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return plainObject(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

function extractTextParts(parts) {
  if (!Array.isArray(parts)) return '';
  const texts = [];
  for (const part of parts) {
    if (plainObject(part) && typeof part.text === 'string' && !part.thought) {
      texts.push(part.text);
    }
  }
  return texts.join('\n');
}

function normalizeGeminiTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) fail('INVALID_REQUEST', 400, 'tools');
  const out = [];
  for (let i = 0; i < tools.length; i++) {
    const entry = tools[i];
    if (!plainObject(entry)) fail('INVALID_TOOL_DEFINITION', 400, `tools[${i}]`);
    const decls = Array.isArray(entry.functionDeclarations)
      ? entry.functionDeclarations
      : Array.isArray(entry.function_declarations)
        ? entry.function_declarations
        : null;
    if (!decls) continue;
    for (let j = 0; j < decls.length; j++) {
      const fn = decls[j];
      if (!plainObject(fn) || typeof fn.name !== 'string' || !fn.name.trim()) {
        fail('INVALID_TOOL_DEFINITION', 400, `tools[${i}].functionDeclarations[${j}]`);
      }
      const parameters = fn.parameters !== undefined
        ? stripSchemaAnnotations(fn.parameters)
        : { type: 'object', properties: {} };
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
          parameters,
        },
      });
    }
  }
  return out;
}

function normalizeGeminiToolChoice(toolConfig) {
  if (toolConfig === undefined || toolConfig === null) return 'auto';
  if (!plainObject(toolConfig)) fail('INVALID_TOOL_CHOICE', 400, 'toolConfig');
  const cfg = toolConfig.functionCallingConfig ?? toolConfig.function_calling_config;
  if (!cfg) return 'auto';
  if (!plainObject(cfg)) fail('INVALID_TOOL_CHOICE', 400, 'toolConfig.functionCallingConfig');
  const mode = String(cfg.mode ?? 'AUTO').toUpperCase();
  if (mode === 'AUTO') return 'auto';
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const allowed = cfg.allowedFunctionNames ?? cfg.allowed_function_names;
    if (Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === 'string') {
      return { type: 'function', function: { name: allowed[0] } };
    }
    return 'required';
  }
  fail('INVALID_TOOL_CHOICE', 400, 'toolConfig.functionCallingConfig.mode');
}

function normalizeGeminiThinking(generationConfig) {
  if (!plainObject(generationConfig)) return 2;
  const tc = generationConfig.thinkingConfig ?? generationConfig.thinking_config;
  if (!plainObject(tc)) return 2;
  if (tc.thinkingBudget === 0 || tc.thinking_budget === 0) return 0;
  if (typeof tc.thinkingLevel === 'string') {
    const lvl = tc.thinkingLevel.toUpperCase();
    if (lvl === 'NONE' || lvl === 'MINIMAL') return 0;
    if (lvl === 'LOW') return 1;
    if (lvl === 'MEDIUM' || lvl === 'HIGH') return 2;
  }
  return 2;
}

export function normalizeGeminiRequest(modelParam, payload, { stream = false } = {}) {
  if (!plainObject(payload)) fail('INVALID_REQUEST');
  const model = canonicalModel(String(modelParam ?? '').trim());
  if (!NATIVE_MODELS.includes(model)) fail('UNSUPPORTED_MODEL', 400, 'model');

  const tools = normalizeGeminiTools(payload.tools);
  const tool_choice = normalizeGeminiToolChoice(payload.toolConfig ?? payload.tool_config);
  compileToolPolicy(tools, tool_choice);

  if (!Array.isArray(payload.contents) || !payload.contents.length) {
    fail('MESSAGES_REQUIRED', 400, 'contents');
  }

  const messages = [];
  const sys = payload.systemInstruction ?? payload.system_instruction;
  if (sys !== undefined && sys !== null) {
    if (typeof sys === 'string') {
      if (sys) messages.push({ role: 'system', content: sys });
    } else if (plainObject(sys) && Array.isArray(sys.parts)) {
      const sysText = extractTextParts(sys.parts);
      if (sysText) messages.push({ role: 'system', content: sysText });
    } else {
      fail('INVALID_REQUEST', 400, 'systemInstruction');
    }
  }

  const pendingCallIds = new Map();
  let callSeq = 0;

  for (const contentItem of payload.contents) {
    if (!plainObject(contentItem) || !Array.isArray(contentItem.parts) || !contentItem.parts.length) {
      fail('INVALID_MESSAGE_CONTENT', 400, 'contents');
    }
    const rawRole = contentItem.role ?? 'user';
    if (!['user', 'model', 'function'].includes(rawRole)) {
      fail('UNSUPPORTED_ROLE', 400, 'contents.role');
    }

    if (rawRole === 'model') {
      const textParts = [];
      const toolCalls = [];
      for (const part of contentItem.parts) {
        if (!plainObject(part)) fail('INVALID_MESSAGE_CONTENT', 400, 'contents.parts');
        if (part.thought === true && typeof part.text === 'string') {
          continue;
        }
        if (typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (plainObject(part.functionCall)) {
          const fc = part.functionCall;
          if (typeof fc.name !== 'string' || !fc.name) {
            fail('INVALID_TOOL_CALL', 400, 'contents.parts.functionCall');
          }
          const callId = `call_${++callSeq}_${fc.name}`;
          const queue = pendingCallIds.get(fc.name) ?? [];
          queue.push(callId);
          pendingCallIds.set(fc.name, queue);
          toolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: fc.name,
              arguments: JSON.stringify(plainObject(fc.args) ? fc.args : {}),
            },
          });
        }
      }
      const msg = {
        role: 'assistant',
        content: textParts.length ? textParts.join('') : (toolCalls.length ? null : ''),
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      const userParts = [];
      for (const part of contentItem.parts) {
        if (!plainObject(part)) fail('INVALID_MESSAGE_CONTENT', 400, 'contents.parts');
        if (typeof part.text === 'string') {
          userParts.push({ type: 'text', text: part.text });
        } else if (plainObject(part.inlineData) || plainObject(part.inline_data)) {
          const inline = part.inlineData ?? part.inline_data;
          if (typeof inline.mimeType !== 'string' && typeof inline.mime_type !== 'string') {
            fail('INVALID_IMAGE_URL', 400, 'contents.parts.inlineData');
          }
          if (typeof inline.data !== 'string') {
            fail('INVALID_IMAGE_URL', 400, 'contents.parts.inlineData');
          }
          const mime = inline.mimeType ?? inline.mime_type;
          const url = `data:${mime};base64,${inline.data}`;
          userParts.push({
            type: 'image_url',
            image_url: { url: normalizeImageUrl(url), detail: 'auto' },
          });
        } else if (plainObject(part.fileData) || plainObject(part.file_data)) {
          const fd = part.fileData ?? part.file_data;
          const uri = fd.fileUri ?? fd.file_uri;
          if (typeof uri !== 'string' || !uri) fail('INVALID_IMAGE_URL', 400, 'contents.parts.fileData');
          userParts.push({
            type: 'image_url',
            image_url: { url: normalizeImageUrl(uri), detail: 'auto' },
          });
        } else if (plainObject(part.functionResponse) || plainObject(part.function_response)) {
          const fr = part.functionResponse ?? part.function_response;
          if (typeof fr.name !== 'string' || !fr.name) {
            fail('INVALID_TOOL_CALL', 400, 'contents.parts.functionResponse');
          }
          const queue = pendingCallIds.get(fr.name);
          const callId = queue?.length ? queue.shift() : `call_${++callSeq}_${fr.name}`;
          const respText = typeof fr.response === 'string'
            ? fr.response
            : JSON.stringify(fr.response ?? {});
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: respText,
          });
        }
      }
      if (userParts.length) {
        const hasImages = userParts.some(p => p.type === 'image_url');
        messages.push({
          role: 'user',
          content: hasImages ? userParts : userParts.map(p => p.text).join(''),
        });
      }
    }
  }

  const genCfg = payload.generationConfig ?? payload.generation_config;
  let response_format;
  if (plainObject(genCfg)) {
    const mime = genCfg.responseMimeType ?? genCfg.response_mime_type;
    const schema = genCfg.responseSchema ?? genCfg.response_schema;
    if (mime === 'application/json') {
      if (plainObject(schema)) {
        response_format = {
          type: 'json_schema',
          json_schema: { name: 'gemini_response_schema', schema },
        };
      } else {
        response_format = { type: 'json_object' };
      }
    }
  }

  return {
    model,
    messages,
    tools,
    tool_choice,
    thinking_level: normalizeGeminiThinking(genCfg),
    parallel_tool_calls: true,
    ...(response_format ? { response_format } : {}),
    stream,
  };
}

export function countGeminiTokens(modelParam, payload) {
  const inner = plainObject(payload?.generateContentRequest)
    ? payload.generateContentRequest
    : payload;
  const canonical = normalizeGeminiRequest(modelParam, inner, { stream: false });
  let chars = 0;
  let imageCount = 0;
  for (const m of canonical.messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length;
        else if (part.type === 'image_url') imageCount++;
      }
    }
    if (Array.isArray(m.tool_calls)) {
      chars += JSON.stringify(m.tool_calls).length;
    }
  }
  if (canonical.tools.length) {
    chars += JSON.stringify(canonical.tools).length;
  }
  const usage = estimateUsage({ promptChars: chars, imageCount, outputBytes: 0 });
  return { totalTokens: usage.prompt_tokens };
}

function grpcStatusForHttp(httpStatus) {
  if (httpStatus === 400) return 'INVALID_ARGUMENT';
  if (httpStatus === 401) return 'UNAUTHENTICATED';
  if (httpStatus === 403) return 'PERMISSION_DENIED';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 429) return 'RESOURCE_EXHAUSTED';
  if (httpStatus === 503) return 'UNAVAILABLE';
  if (httpStatus === 504) return 'DEADLINE_EXCEEDED';
  return 'INTERNAL';
}

export function buildGeminiErrorPayload(error, status = 502) {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  const message = typeof error?.message === 'string' && error.message.length
    ? error.message
    : typeof error?.code === 'string' && error.code.length
      ? error.code
      : 'Upstream generation interrupted';
  return {
    error: {
      code,
      message,
      status: grpcStatusForHttp(code),
    },
  };
}

export function buildGeminiResponsePayload(result, { includeFinish = true, finishReason = 'STOP' } = {}) {
  const calls = Array.isArray(result.calls) ? result.calls : [];
  const parts = [];
  if (typeof result.thinking === 'string' && result.thinking.length > 0) {
    parts.push({ thought: true, text: result.thinking });
  }
  const text = typeof result.content === 'string' ? result.content : '';
  if (text.length > 0 || (calls.length === 0 && includeFinish)) {
    parts.push({ text });
  }
  for (const call of calls) {
    parts.push({
      functionCall: {
        name: call.function?.name ?? call.name ?? '',
        args: parseToolArgs(call.function?.arguments ?? call.arguments),
      },
    });
  }
  const promptTokens = result.usage?.prompt_tokens ?? 0;
  const candidateTokens = result.usage?.completion_tokens ?? 0;
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts,
        },
        ...(includeFinish ? { finishReason } : {}),
        index: 0,
      },
    ],
    ...(includeFinish ? {
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: candidateTokens,
        totalTokenCount: promptTokens + candidateTokens,
      },
    } : {}),
    modelVersion: result.model,
  };
}

export function writeGeminiResponse(res, result) {
  if (result?.incomplete || result?.outputError) {
    const errStatus = Number.isInteger(result?.outputError?.status) &&
      result.outputError.status >= 400 &&
      result.outputError.status <= 599
      ? result.outputError.status
      : 502;
    const errPayload = buildGeminiErrorPayload(result.outputError ?? result, errStatus);
    if (!res.headersSent) {
      res.writeHead(errStatus, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    res.end(JSON.stringify(errPayload));
    return;
  }
  const payload = buildGeminiResponsePayload(result, { includeFinish: true });
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Gemini-Usage': 'estimated',
    });
  }
  res.end(JSON.stringify(payload));
}
