import { randomUUID } from 'node:crypto';
import {
  computeSessionHash,
  countInlineImages,
} from '../gemini/protocol';
import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  GeminiPart,
  GeminiUsageMetadata,
} from '../types';

export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error';

export class OpenAiProtocolError extends Error {
  readonly statusCode: number;
  readonly errorType: OpenAiErrorType;
  readonly code: string | null;
  readonly param: string | null;

  constructor(
    statusCode: number,
    errorType: OpenAiErrorType,
    message: string,
    code: string | null = null,
    param: string | null = null
  ) {
    super(message);
    this.name = 'OpenAiProtocolError';
    this.statusCode = statusCode;
    this.errorType = errorType;
    this.code = code;
    this.param = param;
  }
}

export function getOpenAiErrorInfo(statusCode: number): {
  type: OpenAiErrorType;
  code: string;
} {
  switch (statusCode) {
    case 400:
      return { type: 'invalid_request_error', code: 'invalid_request' };
    case 401:
      return { type: 'authentication_error', code: 'invalid_api_key' };
    case 403:
      return { type: 'permission_error', code: 'permission_denied' };
    case 404:
      return { type: 'not_found_error', code: 'not_found' };
    case 429:
      return { type: 'rate_limit_error', code: 'rate_limit_exceeded' };
    case 503:
    case 529:
      return { type: 'server_error', code: 'service_unavailable' };
    default:
      return { type: 'server_error', code: 'internal_error' };
  }
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAiFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter';

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface OpenAiChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason: OpenAiFinishReason;
  }>;
  usage: OpenAiUsage;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readHeaderCaseInsensitive(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  targetName: string
): string {
  if (!headers) return '';
  if (typeof (headers as Headers).get === 'function') {
    return ((headers as Headers).get(targetName) ?? '').trim();
  }
  const lowerTarget = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerTarget && typeof v === 'string') {
      return v.trim();
    }
  }
  return '';
}

function extractTextFromContent(content: unknown, fieldPath: string): string {
  if (content === undefined || content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
        chunks.push(item.text);
      } else if (typeof item === 'string') {
        chunks.push(item);
      } else {
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `${fieldPath}[${i}] must be a text content part`,
          'invalid_request'
        );
      }
    }
    return chunks.join('\n');
  }
  throw new OpenAiProtocolError(
    400,
    'invalid_request_error',
    `${fieldPath} must be a string or an array of content parts`,
    'invalid_request'
  );
}

function extractToolMessageContent(content: unknown): string {
  if (content === undefined || content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
        chunks.push(item.text);
      } else if (typeof item === 'string') {
        chunks.push(item);
      } else if (item !== null && item !== undefined) {
        chunks.push(JSON.stringify(item));
      }
    }
    return chunks.join('\n');
  }
  return JSON.stringify(content);
}

function parseBase64DataUrl(
  url: string,
  fieldPath: string
): { mimeType: string; data: string } {
  const match = /^data:([a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+)(?:;[^,]*)?;base64,(.+)$/s.exec(
    url.trim()
  );
  if (!match || !match[1] || !match[2] || match[2].trim() === '') {
    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      `${fieldPath}.image_url.url must be a valid base64 data URL (data:<mime>;base64,<data>)`,
      'invalid_image_url'
    );
  }
  return {
    mimeType: match[1].trim(),
    data: match[2].trim(),
  };
}

export interface ConvertedOpenAiRequest {
  requestedModel: string;
  stream: boolean;
  includeUsage: boolean;
  promptCacheKey: string;
  userField: string;
  geminiRequest: GeminiGenerateRequest;
}

export function convertOpenAiToGeminiRequest(
  raw: unknown,
  options: { maxImagesPerRequest?: number } = {}
): ConvertedOpenAiRequest {
  const maxImagesPerRequest = options.maxImagesPerRequest ?? 200;

  if (!isPlainObject(raw)) {
    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      'Request body must be a JSON object',
      'invalid_request'
    );
  }

  if (typeof raw.model !== 'string' || raw.model.trim() === '') {
    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      'model must be a non-empty string',
      'invalid_request',
      'model'
    );
  }
  const requestedModel = raw.model.trim();

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      'messages must be a non-empty array',
      'invalid_request',
      'messages'
    );
  }

  const systemParts: GeminiPart[] = [];
  const toolNameMap = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (let i = 0; i < raw.messages.length; i++) {
    const msg = raw.messages[i];
    if (!isPlainObject(msg) || typeof msg.role !== 'string') {
      throw new OpenAiProtocolError(
        400,
        'invalid_request_error',
        `messages[${i}] must be an object with a role`,
        'invalid_request'
      );
    }

    if (msg.role === 'system' || msg.role === 'developer') {
      const sysText = extractTextFromContent(msg.content, `messages[${i}].content`);
      if (sysText.length > 0) {
        systemParts.push({ text: sysText });
      }
      continue;
    }

    if (msg.role === 'user') {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j];
          if (!isPlainObject(block) || typeof block.type !== 'string') {
            throw new OpenAiProtocolError(
              400,
              'invalid_request_error',
              `messages[${i}].content[${j}] must be an object with a type`,
              'invalid_request'
            );
          }
          if (block.type === 'text') {
            if (typeof block.text !== 'string') {
              throw new OpenAiProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}].text must be a string`,
                'invalid_request'
              );
            }
            parts.push({ text: block.text });
          } else if (block.type === 'image_url') {
            const imgObj = block.image_url;
            const url =
              typeof imgObj === 'string'
                ? imgObj
                : isPlainObject(imgObj) && typeof imgObj.url === 'string'
                  ? imgObj.url
                  : '';
            if (!url) {
              throw new OpenAiProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}].image_url.url must be a non-empty string`,
                'invalid_image_url'
              );
            }
            const parsedImg = parseBase64DataUrl(url, `messages[${i}].content[${j}]`);
            parts.push({ inlineData: parsedImg });
          } else {
            throw new OpenAiProtocolError(
              400,
              'invalid_request_error',
              `Unsupported user content block type: ${block.type}`,
              'invalid_request'
            );
          }
        }
      } else {
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `messages[${i}].content must be a string or an array`,
          'invalid_request'
        );
      }

      contents.push({
        role: 'user',
        parts: parts.length > 0 ? parts : [{ text: '' }],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
        parts.push({ text: msg.reasoning_content, thought: true });
      }
      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          parts.push({ text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j];
          if (!isPlainObject(block) || typeof block.type !== 'string') {
            throw new OpenAiProtocolError(
              400,
              'invalid_request_error',
              `messages[${i}].content[${j}] must be an object with a type`,
              'invalid_request'
            );
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push({ text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            parts.push({ text: block.thinking, thought: true });
          } else {
            throw new OpenAiProtocolError(
              400,
              'invalid_request_error',
              `Unsupported assistant content block type: ${block.type}`,
              'invalid_request'
            );
          }
        }
      } else if (msg.content !== undefined && msg.content !== null) {
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `messages[${i}].content must be a string, array, or null`,
          'invalid_request'
        );
      }

      if (msg.tool_calls !== undefined) {
        if (!Array.isArray(msg.tool_calls)) {
          throw new OpenAiProtocolError(
            400,
            'invalid_request_error',
            `messages[${i}].tool_calls must be an array`,
            'invalid_request'
          );
        }
        for (let j = 0; j < msg.tool_calls.length; j++) {
          const tc = msg.tool_calls[j];
          if (!isPlainObject(tc) || !isPlainObject(tc.function)) {
            throw new OpenAiProtocolError(
              400,
              'invalid_request_error',
              `messages[${i}].tool_calls[${j}] must include a function object`,
              'invalid_request'
            );
          }
          const fnName =
            typeof tc.function.name === 'string' ? tc.function.name.trim() : '';
          if (!fnName) {
            throw new OpenAiProtocolError(
              400,
              'invalid_request_error',
              `messages[${i}].tool_calls[${j}].function.name must be a non-empty string`,
              'invalid_request'
            );
          }
          const tcId =
            typeof tc.id === 'string' && tc.id.trim() !== ''
              ? tc.id.trim()
              : `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

          let args: Record<string, unknown> = {};
          if (typeof tc.function.arguments === 'string') {
            const rawArgs = tc.function.arguments.trim();
            if (rawArgs.length > 0) {
              try {
                const parsed = JSON.parse(rawArgs);
                if (!isPlainObject(parsed)) {
                  throw new Error('Tool arguments must be a JSON object');
                }
                args = parsed;
              } catch {
                throw new OpenAiProtocolError(
                  400,
                  'invalid_request_error',
                  `messages[${i}].tool_calls[${j}].function.arguments must be valid JSON object`,
                  'invalid_request'
                );
              }
            }
          } else if (isPlainObject(tc.function.arguments)) {
            args = tc.function.arguments;
          }

          toolNameMap.set(tcId, fnName);
          parts.push({
            functionCall: {
              id: tcId,
              name: fnName,
              args,
            },
          });
        }
      }

      contents.push({
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }],
      });
      continue;
    }

    if (msg.role === 'tool') {
      const toolCallId =
        typeof msg.tool_call_id === 'string' ? msg.tool_call_id.trim() : '';
      if (!toolCallId) {
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `messages[${i}].tool_call_id must be a non-empty string`,
          'invalid_request'
        );
      }
      const fnName = toolNameMap.get(toolCallId) ?? toolCallId;
      const resultContent = extractToolMessageContent(msg.content);
      const fnRespPart: GeminiPart = {
        functionResponse: {
          id: toolCallId,
          name: fnName,
          response: {
            content: resultContent,
          },
        },
      };

      // Merge consecutive tool responses into the same user turn when possible
      const prev = contents[contents.length - 1];
      if (
        prev &&
        prev.role === 'user' &&
        prev.parts.every((p) => Boolean(p.functionResponse))
      ) {
        prev.parts.push(fnRespPart);
      } else {
        contents.push({
          role: 'user',
          parts: [fnRespPart],
        });
      }
      continue;
    }

    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      `Unsupported message role: ${msg.role}`,
      'invalid_request'
    );
  }

  if (contents.length === 0) {
    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      'messages must contain at least one non-system message',
      'invalid_request',
      'messages'
    );
  }

  let tools: GeminiGenerateRequest['tools'];
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      throw new OpenAiProtocolError(
        400,
        'invalid_request_error',
        'tools must be an array',
        'invalid_request',
        'tools'
      );
    }
    const functionDeclarations: GeminiFunctionDeclaration[] = [];
    for (let i = 0; i < raw.tools.length; i++) {
      const tool = raw.tools[i];
      if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) {
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `tools[${i}] must be a function tool`,
          'invalid_request'
        );
      }
      const fn = tool.function;
      if (typeof fn.name !== 'string' || fn.name.trim() === '') {
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `tools[${i}].function.name must be a non-empty string`,
          'invalid_request'
        );
      }
      const decl: GeminiFunctionDeclaration = {
        name: fn.name.trim(),
      };
      if (typeof fn.description === 'string') {
        decl.description = fn.description;
      }
      if (isPlainObject(fn.parameters)) {
        decl.parameters = fn.parameters;
      }
      functionDeclarations.push(decl);
    }
    if (functionDeclarations.length > 0) {
      tools = [{ functionDeclarations }];
    }
  }

  const generationConfig: Record<string, unknown> = {};
  const maxTokensRaw = raw.max_completion_tokens ?? raw.max_tokens;
  if (maxTokensRaw !== undefined && maxTokensRaw !== null) {
    if (
      typeof maxTokensRaw !== 'number' ||
      !Number.isSafeInteger(maxTokensRaw) ||
      maxTokensRaw <= 0
    ) {
      throw new OpenAiProtocolError(
        400,
        'invalid_request_error',
        'max_tokens / max_completion_tokens must be a positive integer',
        'invalid_request'
      );
    }
    generationConfig.maxOutputTokens = maxTokensRaw;
  }

  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    generationConfig.temperature = raw.temperature;
  }
  if (typeof raw.top_p === 'number' && Number.isFinite(raw.top_p)) {
    generationConfig.topP = raw.top_p;
  }

  if (raw.stop !== undefined && raw.stop !== null) {
    if (typeof raw.stop === 'string') {
      if (raw.stop.length > 0) {
        generationConfig.stopSequences = [raw.stop];
      }
    } else if (
      Array.isArray(raw.stop) &&
      raw.stop.every((s) => typeof s === 'string')
    ) {
      const nonEmpty = raw.stop.filter((s) => s.length > 0);
      if (nonEmpty.length > 0) {
        generationConfig.stopSequences = nonEmpty;
      }
    } else {
      throw new OpenAiProtocolError(
        400,
        'invalid_request_error',
        'stop must be a string or an array of strings',
        'invalid_request',
        'stop'
      );
    }
  }

  if (raw.reasoning_effort !== undefined && raw.reasoning_effort !== null) {
    if (typeof raw.reasoning_effort !== 'string') {
      throw new OpenAiProtocolError(
        400,
        'invalid_request_error',
        'reasoning_effort must be a string',
        'invalid_request',
        'reasoning_effort'
      );
    }
    const effort = raw.reasoning_effort.trim().toLowerCase();
    switch (effort) {
      case 'none':
        generationConfig.thinkingConfig = { includeThoughts: false };
        break;
      case 'minimal':
        generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 512 };
        break;
      case 'low':
        generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 1024 };
        break;
      case 'medium':
        generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 8192 };
        break;
      case 'high':
      case 'xhigh':
        generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 24576 };
        break;
      default:
        throw new OpenAiProtocolError(
          400,
          'invalid_request_error',
          `Unsupported reasoning_effort: ${raw.reasoning_effort}`,
          'invalid_request',
          'reasoning_effort'
        );
    }
  }

  const geminiRequest: GeminiGenerateRequest = {
    contents,
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    ...(tools ? { tools } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };

  const imageCount = countInlineImages(geminiRequest);
  if (imageCount > maxImagesPerRequest) {
    throw new OpenAiProtocolError(
      400,
      'invalid_request_error',
      `Too many images in request (${imageCount} > max ${maxImagesPerRequest})`,
      'invalid_request'
    );
  }

  const stream = raw.stream === true;
  const includeUsage =
    stream && isPlainObject(raw.stream_options) && raw.stream_options.include_usage === true;

  const promptCacheKey =
    typeof raw.prompt_cache_key === 'string' ? raw.prompt_cache_key.trim() : '';
  const userField = typeof raw.user === 'string' ? raw.user.trim() : '';

  return {
    requestedModel,
    stream,
    includeUsage,
    promptCacheKey,
    userField,
    geminiRequest,
  };
}

export function resolveOpenAiSessionKey(
  geminiReq: GeminiGenerateRequest,
  headers?: Headers | Record<string, string | undefined> | null,
  promptCacheKey?: string,
  userField?: string
): string {
  const headerSessionId =
    readHeaderCaseInsensitive(headers, 'x-session-id') ||
    readHeaderCaseInsensitive(headers, 'x-thread-id');
  const agentId = readHeaderCaseInsensitive(headers, 'x-claude-code-agent-id');

  if (headerSessionId) {
    return agentId ? `${headerSessionId}:agent:${agentId}` : headerSessionId;
  }
  if (promptCacheKey && promptCacheKey.trim()) {
    return promptCacheKey.trim();
  }
  if (userField && userField.trim()) {
    return userField.trim();
  }
  return computeSessionHash(geminiReq);
}

export function mapGeminiFinishReasonToOpenAi(
  finishReason: string | undefined,
  hasToolCalls: boolean
): OpenAiFinishReason {
  if (hasToolCalls) {
    return 'tool_calls';
  }
  switch ((finishReason ?? '').toUpperCase()) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    case 'STOP':
    case 'STOP_SEQUENCE':
    default:
      return 'stop';
  }
}

export function extractOpenAiUsage(usage?: GeminiUsageMetadata): OpenAiUsage {
  const promptTokens = Math.max(0, usage?.promptTokenCount ?? 0);
  const candidatesTokens = Math.max(0, usage?.candidatesTokenCount ?? 0);
  const thoughtsTokens = Math.max(0, usage?.thoughtsTokenCount ?? 0);
  const completionTokens = candidatesTokens + thoughtsTokens;
  const totalTokens = promptTokens + completionTokens;
  const cachedTokensRaw = usage?.cachedContentTokenCount;
  const cachedTokens =
    typeof cachedTokensRaw === 'number' && Number.isFinite(cachedTokensRaw) && cachedTokensRaw >= 0
      ? cachedTokensRaw
      : undefined;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(cachedTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
    ...(thoughtsTokens > 0
      ? { completion_tokens_details: { reasoning_tokens: thoughtsTokens } }
      : {}),
  };
}

export function convertGeminiToOpenAiResponse(
  geminiRes: GeminiGenerateResponse,
  options: { completionId?: string; model: string; created?: number }
): OpenAiChatCompletionResponse {
  const completionId =
    options.completionId ?? `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const candidate = geminiRes.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  let textContent = '';
  let reasoningContent = '';
  const toolCalls: OpenAiToolCall[] = [];

  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      if (part.thought) {
        reasoningContent += part.text;
      } else {
        textContent += part.text;
      }
    } else if (part.functionCall) {
      const id =
        typeof part.functionCall.id === 'string' && part.functionCall.id.trim() !== ''
          ? part.functionCall.id.trim()
          : `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const finishReason = mapGeminiFinishReasonToOpenAi(
    candidate?.finishReason,
    toolCalls.length > 0
  );
  const usage = extractOpenAiUsage(geminiRes.usageMetadata);

  const message: OpenAiChatCompletionResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: textContent.length > 0 ? textContent : toolCalls.length > 0 ? null : '',
    ...(reasoningContent.length > 0 ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id: completionId,
    object: 'chat.completion',
    created,
    model: options.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export function formatOpenAiSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export class OpenAiStreamSerializer {
  readonly completionId: string;
  readonly model: string;
  readonly created: number;
  private sentRole = false;
  private hasToolCalls = false;
  private toolCallIndex = 0;
  private finished = false;
  private thoughtChars = 0;
  private textChars = 0;
  private toolChars = 0;

  constructor(completionId: string, model: string, created = Math.floor(Date.now() / 1000)) {
    this.completionId = completionId;
    this.model = model;
    this.created = created;
  }

  private nextDeltaRole(): { role?: 'assistant' } {
    if (!this.sentRole) {
      this.sentRole = true;
      return { role: 'assistant' };
    }
    return {};
  }

  private buildChunk(
    delta: Record<string, unknown>,
    finishReason: OpenAiFinishReason | null = null
  ): string {
    return formatOpenAiSseData({
      id: this.completionId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    });
  }

  processChunk(chunk: GeminiGenerateResponse): string {
    let out = '';
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        if (part.thought) {
          this.thoughtChars += part.text.length;
          out += this.buildChunk({
            ...this.nextDeltaRole(),
            reasoning_content: part.text,
          });
        } else {
          this.textChars += part.text.length;
          out += this.buildChunk({
            ...this.nextDeltaRole(),
            content: part.text,
          });
        }
      } else if (part.functionCall) {
        this.hasToolCalls = true;
        const idx = this.toolCallIndex++;
        const id =
          typeof part.functionCall.id === 'string' && part.functionCall.id.trim() !== ''
            ? part.functionCall.id.trim()
            : `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const argsJson = JSON.stringify(part.functionCall.args ?? {});
        this.toolChars += part.functionCall.name.length + argsJson.length;
        out += this.buildChunk({
          ...this.nextDeltaRole(),
          tool_calls: [
            {
              index: idx,
              id,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: argsJson,
              },
            },
          ],
        });
      }
    }

    return out;
  }

  finishStream(
    finishReason: string | undefined,
    usageMetadata?: GeminiUsageMetadata,
    includeUsage = false
  ): string {
    if (this.finished) return '';
    this.finished = true;

    let out = '';
    if (!this.sentRole) {
      out += this.buildChunk({ ...this.nextDeltaRole(), content: '' });
    }

    const mappedReason = mapGeminiFinishReasonToOpenAi(finishReason, this.hasToolCalls);
    out += this.buildChunk({}, mappedReason);

    if (includeUsage) {
      const usage = extractOpenAiUsage(usageMetadata);
      out += formatOpenAiSseData({
        id: this.completionId,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage,
      });
    }

    out += 'data: [DONE]\n\n';
    return out;
  }

  getMeasuredLengths(): {
    thoughtChars: number;
    textChars: number;
    toolChars: number;
  } {
    return {
      thoughtChars: this.thoughtChars,
      textChars: this.textChars,
      toolChars: this.toolChars,
    };
  }
}
