import crypto from 'node:crypto';
import { plainObject, protocolError, compileToolPolicy } from './tool-protocol.mjs';
import { stripSchemaAnnotations } from './prompt-tool-schema.mjs';
import { canonicalModel, NATIVE_MODELS } from './openai-contract.mjs';
import { normalizeImageUrl } from './image-input.mjs';
import { estimateUsage } from './openai-usage.mjs';

const fail = (code, status = 400, param = null) => {
  throw protocolError(code, status, param);
};

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

function normalizeSystem(system) {
  if (system === undefined || system === null) return null;
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) fail('INVALID_REQUEST', 400, 'system');
  const texts = [];
  for (const block of system) {
    if (!plainObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
      fail('INVALID_REQUEST', 400, 'system');
    }
    texts.push(block.text);
  }
  return texts.join('\n');
}

function normalizeToolResultContent(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) fail('INVALID_MESSAGE_CONTENT', 400, 'messages.content');
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (plainObject(item) && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join('\n');
}

function normalizeGoogleTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) fail('INVALID_REQUEST', 400, 'tools');
  return tools.map((tool, index) => {
    if (!plainObject(tool) || typeof tool.name !== 'string' || !tool.name.trim()) {
      fail('INVALID_TOOL_DEFINITION', 400, `tools[${index}]`);
    }
    const parameters = tool.input_schema !== undefined
      ? stripSchemaAnnotations(tool.input_schema)
      : { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters,
      },
    };
  });
}

function normalizeGoogleToolChoice(choice) {
  if (choice === undefined || choice === null) return 'auto';
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none') return choice;
    if (choice === 'any') return 'required';
    fail('INVALID_TOOL_CHOICE', 400, 'tool_choice');
  }
  if (!plainObject(choice)) fail('INVALID_TOOL_CHOICE', 400, 'tool_choice');
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name.trim()) {
    return { type: 'function', function: { name: choice.name } };
  }
  fail('INVALID_TOOL_CHOICE', 400, 'tool_choice');
}

function normalizeThinkingLevel(thinking) {
  if (thinking === undefined || thinking === null) return 2;
  if (!plainObject(thinking)) fail('INVALID_THINKING_LEVEL', 400, 'thinking');
  if (thinking.type === 'disabled') return 0;
  if (thinking.type === 'enabled' || thinking.type === 'adaptive') return 2;
  fail('INVALID_THINKING_LEVEL', 400, 'thinking');
}

export function normalizeGoogleRequest(payload) {
  if (!plainObject(payload)) fail('INVALID_REQUEST');
  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    fail('MODEL_REQUIRED', 400, 'model');
  }
  const model = canonicalModel(payload.model.trim());
  if (!NATIVE_MODELS.includes(model)) fail('UNSUPPORTED_MODEL', 400, 'model');
  if (payload.stream !== undefined && typeof payload.stream !== 'boolean') {
    fail('INVALID_REQUEST', 400, 'stream');
  }
  if (payload.max_tokens !== undefined && (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1)) {
    fail('INVALID_REQUEST', 400, 'max_tokens');
  }

  const tools = normalizeGoogleTools(payload.tools);
  const tool_choice = normalizeGoogleToolChoice(payload.tool_choice);
  compileToolPolicy(tools, tool_choice);

  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    fail('MESSAGES_REQUIRED', 400, 'messages');
  }

  const messages = [];
  const systemText = normalizeSystem(payload.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  for (const msg of payload.messages) {
    if (!plainObject(msg) || !['user', 'assistant'].includes(msg.role)) {
      fail('UNSUPPORTED_ROLE', 400, 'messages.role');
    }
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content) || !msg.content.length) {
      fail('INVALID_MESSAGE_CONTENT', 400, 'messages.content');
    }

    if (msg.role === 'user') {
      const userParts = [];
      for (const block of msg.content) {
        if (!plainObject(block) || typeof block.type !== 'string') {
          fail('INVALID_MESSAGE_CONTENT', 400, 'messages.content');
        }
        if (block.type === 'tool_result') {
          if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) {
            fail('INVALID_TOOL_CALL_ID', 400, 'messages.content.tool_use_id');
          }
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: normalizeToolResultContent(block.content),
          });
        } else if (block.type === 'text') {
          if (typeof block.text !== 'string') fail('INVALID_TEXT', 400, 'messages.content.text');
          userParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          const src = block.source;
          if (!plainObject(src)) fail('INVALID_IMAGE_URL', 400, 'messages.content.source');
          let url;
          if (src.type === 'base64') {
            if (typeof src.media_type !== 'string' || typeof src.data !== 'string') {
              fail('INVALID_IMAGE_URL', 400, 'messages.content.source');
            }
            url = `data:${src.media_type};base64,${src.data}`;
          } else if (src.type === 'url' && typeof src.url === 'string') {
            url = src.url;
          } else {
            fail('INVALID_IMAGE_URL', 400, 'messages.content.source');
          }
          userParts.push({
            type: 'image_url',
            image_url: { url: normalizeImageUrl(url), detail: 'auto' },
          });
        } else {
          fail('UNSUPPORTED_CONTENT_TYPE', 400, 'messages.content');
        }
      }
      if (userParts.length) {
        const hasImages = userParts.some(p => p.type === 'image_url');
        messages.push({
          role: 'user',
          content: hasImages ? userParts : userParts.map(p => p.text).join(''),
        });
      }
    } else {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (!plainObject(block) || typeof block.type !== 'string') {
          fail('INVALID_MESSAGE_CONTENT', 400, 'messages.content');
        }
        if (block.type === 'thinking') {
          continue;
        } else if (block.type === 'text') {
          if (typeof block.text !== 'string') fail('INVALID_TEXT', 400, 'messages.content.text');
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
            fail('INVALID_TOOL_CALL', 400, 'messages.content');
          }
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(plainObject(block.input) ? block.input : {}),
            },
          });
        } else {
          fail('UNSUPPORTED_CONTENT_TYPE', 400, 'messages.content');
        }
      }
      const assistantMsg = {
        role: 'assistant',
        content: textParts.length ? textParts.join('') : (toolCalls.length ? null : ''),
      };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
    }
  }

  return {
    model,
    messages,
    tools,
    tool_choice,
    thinking_level: normalizeThinkingLevel(payload.thinking),
    parallel_tool_calls: payload.tool_choice?.disable_parallel_tool_use === true ? false : true,
    stream: payload.stream === true,
  };
}

export function countGoogleTokens(payload) {
  const canonical = normalizeGoogleRequest(payload);
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
  return { input_tokens: usage.prompt_tokens };
}

export function buildGoogleMessagePayload(result) {
  const calls = Array.isArray(result.calls) ? result.calls : [];
  const content = [];
  if (typeof result.thinking === 'string' && result.thinking.length > 0) {
    content.push({ type: 'thinking', thinking: result.thinking });
  }
  const text = typeof result.content === 'string' ? result.content : '';
  if (text.length > 0 || calls.length === 0) {
    content.push({ type: 'text', text });
  }
  for (const call of calls) {
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
      name: call.function?.name ?? call.name ?? '',
      input: parseToolArgs(call.function?.arguments ?? call.arguments),
    });
  }
  const msgId = typeof result.id === 'string' && result.id.startsWith('msg_')
    ? result.id
    : `msg_${crypto.randomBytes(12).toString('hex')}`;
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content,
    stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? 0,
    },
  };
}

export function buildGoogleErrorPayload(error, status = 502) {
  const errType = error?.type === 'rate_limit_error' || status === 429
    ? 'rate_limit_error'
    : error?.type === 'authentication_error' || status === 401
      ? 'authentication_error'
      : error?.type === 'invalid_request_error' || (status >= 400 && status < 500)
        ? 'invalid_request_error'
        : 'api_error';
  const message = typeof error?.message === 'string' && error.message.length
    ? error.message
    : typeof error?.code === 'string' && error.code.length
      ? error.code
      : 'Upstream generation interrupted';
  return {
    type: 'error',
    error: {
      type: errType,
      message,
    },
  };
}

export function writeGoogleResponse(res, result) {
  if (result?.incomplete || result?.outputError) {
    const errStatus = Number.isInteger(result?.outputError?.status) &&
      result.outputError.status >= 400 &&
      result.outputError.status <= 599
      ? result.outputError.status
      : 502;
    const errPayload = buildGoogleErrorPayload(result.outputError ?? result, errStatus);
    if (!res.headersSent) {
      res.writeHead(errStatus, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    res.end(JSON.stringify(errPayload));
    return;
  }
  const payload = buildGoogleMessagePayload(result);
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Gemini-Usage': 'estimated',
    });
  }
  res.end(JSON.stringify(payload));
}
