import { randomUUID } from 'node:crypto';
import {
  computeSessionHash,
  countInlineImages,
  estimateTokens,
} from '../gemini/protocol';
import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  GeminiPart,
} from '../types';

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'overloaded_error'
  | 'api_error';

export class AnthropicProtocolError extends Error {
  readonly statusCode: number;
  readonly errorType: AnthropicErrorType;

  constructor(
    statusCode: number,
    errorType: AnthropicErrorType,
    message: string
  ) {
    super(message);
    this.name = 'AnthropicProtocolError';
    this.statusCode = statusCode;
    this.errorType = errorType;
  }
}

export function getAnthropicErrorType(statusCode: number): AnthropicErrorType {
  switch (statusCode) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limit_error';
    case 503:
    case 529:
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface AnthropicThinkingConfig {
  type: 'enabled' | 'adaptive' | 'disabled';
  budget_tokens?: number;
}

export interface AnthropicToolDefinition {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens?: number;
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicToolDefinition[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  thinking?: AnthropicThinkingConfig;
  metadata?: {
    user_id?: string;
    [key: string]: unknown;
  };
}

export type AnthropicResponseBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: null;
  usage: AnthropicUsage;
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

function extractToolResultContent(content: unknown): string {
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

export interface ConvertedAnthropicRequest {
  requestedModel: string;
  stream: boolean;
  metadataUserId: string;
  geminiRequest: GeminiGenerateRequest;
}

export function convertAnthropicToGeminiRequest(
  raw: unknown,
  options: { maxImagesPerRequest?: number; requireMaxTokens?: boolean } = {}
): ConvertedAnthropicRequest {
  const maxImagesPerRequest = options.maxImagesPerRequest ?? 200;
  const requireMaxTokens = options.requireMaxTokens ?? true;

  if (!isPlainObject(raw)) {
    throw new AnthropicProtocolError(
      400,
      'invalid_request_error',
      'Request body must be a JSON object'
    );
  }

  if (typeof raw.model !== 'string' || raw.model.trim() === '') {
    throw new AnthropicProtocolError(
      400,
      'invalid_request_error',
      'model must be a non-empty string'
    );
  }
  const requestedModel = raw.model.trim();

  if (requireMaxTokens) {
    if (
      typeof raw.max_tokens !== 'number' ||
      !Number.isSafeInteger(raw.max_tokens) ||
      raw.max_tokens <= 0
    ) {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'max_tokens must be a positive integer'
      );
    }
  } else if (raw.max_tokens !== undefined) {
    if (
      typeof raw.max_tokens !== 'number' ||
      !Number.isSafeInteger(raw.max_tokens) ||
      raw.max_tokens <= 0
    ) {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'max_tokens must be a positive integer'
      );
    }
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new AnthropicProtocolError(
      400,
      'invalid_request_error',
      'messages must be a non-empty array'
    );
  }

  let systemInstruction: { parts: GeminiPart[] } | undefined;
  if (raw.system !== undefined) {
    if (typeof raw.system === 'string') {
      if (raw.system.length > 0) {
        systemInstruction = { parts: [{ text: raw.system }] };
      }
    } else if (Array.isArray(raw.system)) {
      const sysParts: GeminiPart[] = [];
      for (let i = 0; i < raw.system.length; i++) {
        const block = raw.system[i];
        if (!isPlainObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
          throw new AnthropicProtocolError(
            400,
            'invalid_request_error',
            `system[${i}] must be a text block`
          );
        }
        if (block.text.length > 0) {
          sysParts.push({ text: block.text });
        }
      }
      if (sysParts.length > 0) {
        systemInstruction = { parts: sysParts };
      }
    } else {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'system must be a string or an array of text blocks'
      );
    }
  }

  const toolNameMap = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (let i = 0; i < raw.messages.length; i++) {
    const msg = raw.messages[i];
    if (!isPlainObject(msg)) {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        `messages[${i}] must be an object`
      );
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        `messages[${i}].role must be "user" or "assistant"`
      );
    }
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!isPlainObject(block) || typeof block.type !== 'string') {
          throw new AnthropicProtocolError(
            400,
            'invalid_request_error',
            `messages[${i}].content[${j}] must be an object with a type`
          );
        }

        switch (block.type) {
          case 'text': {
            if (typeof block.text !== 'string') {
              throw new AnthropicProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}].text must be a string`
              );
            }
            parts.push({ text: block.text });
            break;
          }
          case 'thinking': {
            if (typeof block.thinking !== 'string') {
              throw new AnthropicProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}].thinking must be a string`
              );
            }
            parts.push({ text: block.thinking, thought: true });
            break;
          }
          case 'redacted_thinking': {
            // Safely skip redacted_thinking blocks
            break;
          }
          case 'image': {
            if (!isPlainObject(block.source) || block.source.type !== 'base64') {
              throw new AnthropicProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}].source.type must be "base64"`
              );
            }
            if (
              typeof block.source.media_type !== 'string' ||
              block.source.media_type.trim() === '' ||
              typeof block.source.data !== 'string' ||
              block.source.data.trim() === ''
            ) {
              throw new AnthropicProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}].source must include non-empty media_type and data`
              );
            }
            parts.push({
              inlineData: {
                mimeType: block.source.media_type.trim(),
                data: block.source.data,
              },
            });
            break;
          }
          case 'tool_use': {
            if (
              typeof block.id !== 'string' ||
              block.id.trim() === '' ||
              typeof block.name !== 'string' ||
              block.name.trim() === ''
            ) {
              throw new AnthropicProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}] tool_use must include id and name`
              );
            }
            const args = isPlainObject(block.input) ? block.input : {};
            toolNameMap.set(block.id, block.name);
            parts.push({
              functionCall: {
                id: block.id,
                name: block.name,
                args,
              },
            });
            break;
          }
          case 'tool_result': {
            if (typeof block.tool_use_id !== 'string' || block.tool_use_id.trim() === '') {
              throw new AnthropicProtocolError(
                400,
                'invalid_request_error',
                `messages[${i}].content[${j}] tool_result must include tool_use_id`
              );
            }
            const resultContent = extractToolResultContent(block.content);
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: toolNameMap.get(block.tool_use_id) ?? block.tool_use_id,
                response: {
                  content: resultContent,
                  ...(block.is_error === true ? { is_error: true } : {}),
                },
              },
            });
            break;
          }
          default:
            throw new AnthropicProtocolError(
              400,
              'invalid_request_error',
              `Unsupported content block type: ${block.type}`
            );
        }
      }
    } else {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        `messages[${i}].content must be a string or an array`
      );
    }

    contents.push({
      role: geminiRole,
      parts: parts.length > 0 ? parts : [{ text: '' }],
    });
  }

  let tools: GeminiGenerateRequest['tools'];
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'tools must be an array'
      );
    }
    const functionDeclarations: GeminiFunctionDeclaration[] = [];
    for (let i = 0; i < raw.tools.length; i++) {
      const tool = raw.tools[i];
      if (!isPlainObject(tool)) {
        throw new AnthropicProtocolError(
          400,
          'invalid_request_error',
          `tools[${i}] must be an object`
        );
      }
      // Ignore Anthropic built-in non-function tools (e.g., bash_*, text_editor_*, web_search_*)
      if (typeof tool.type === 'string' && tool.type !== 'custom') {
        continue;
      }
      if (typeof tool.name !== 'string' || tool.name.trim() === '') {
        throw new AnthropicProtocolError(
          400,
          'invalid_request_error',
          `tools[${i}].name must be a non-empty string`
        );
      }
      const decl: GeminiFunctionDeclaration = {
        name: tool.name,
      };
      if (typeof tool.description === 'string') {
        decl.description = tool.description;
      }
      if (isPlainObject(tool.input_schema)) {
        decl.parameters = tool.input_schema;
      }
      functionDeclarations.push(decl);
    }
    if (functionDeclarations.length > 0) {
      tools = [{ functionDeclarations }];
    }
  }

  let toolConfig: GeminiGenerateRequest['toolConfig'];
  if (raw.tool_choice !== undefined && raw.tool_choice !== null) {
    if (!isPlainObject(raw.tool_choice) || typeof raw.tool_choice.type !== 'string') {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'tool_choice must be an object with a type'
      );
    }
    switch (raw.tool_choice.type) {
      case 'none':
        toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        break;
      case 'auto':
        toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        break;
      case 'any':
        toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        break;
      case 'tool': {
        if (typeof raw.tool_choice.name !== 'string' || raw.tool_choice.name.trim() === '') {
          throw new AnthropicProtocolError(
            400,
            'invalid_request_error',
            'tool_choice.name must be a non-empty string when type="tool"'
          );
        }
        toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [raw.tool_choice.name.trim()],
          },
        };
        break;
      }
      default:
        throw new AnthropicProtocolError(
          400,
          'invalid_request_error',
          `Unsupported tool_choice.type: ${raw.tool_choice.type}`
        );
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof raw.max_tokens === 'number') {
    generationConfig.maxOutputTokens = raw.max_tokens;
  }
  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    generationConfig.temperature = raw.temperature;
  }
  if (typeof raw.top_p === 'number' && Number.isFinite(raw.top_p)) {
    generationConfig.topP = raw.top_p;
  }
  if (typeof raw.top_k === 'number' && Number.isFinite(raw.top_k)) {
    generationConfig.topK = raw.top_k;
  }
  if (raw.stop_sequences !== undefined) {
    if (
      !Array.isArray(raw.stop_sequences) ||
      !raw.stop_sequences.every((s) => typeof s === 'string')
    ) {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'stop_sequences must be an array of strings'
      );
    }
    if (raw.stop_sequences.length > 0) {
      generationConfig.stopSequences = raw.stop_sequences;
    }
  }
  if (raw.thinking !== undefined) {
    if (!isPlainObject(raw.thinking) || typeof raw.thinking.type !== 'string') {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        'thinking must be an object with a type'
      );
    }
    if (raw.thinking.type === 'enabled' || raw.thinking.type === 'adaptive') {
      const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
      if (
        typeof raw.thinking.budget_tokens === 'number' &&
        Number.isFinite(raw.thinking.budget_tokens) &&
        raw.thinking.budget_tokens > 0
      ) {
        thinkingConfig.thinkingBudget = raw.thinking.budget_tokens;
      }
      generationConfig.thinkingConfig = thinkingConfig;
    } else if (raw.thinking.type === 'disabled') {
      generationConfig.thinkingConfig = { includeThoughts: false };
    } else {
      throw new AnthropicProtocolError(
        400,
        'invalid_request_error',
        `Unsupported thinking.type: ${raw.thinking.type}`
      );
    }
  }

  const geminiRequest: GeminiGenerateRequest = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };

  const imageCount = countInlineImages(geminiRequest);
  if (imageCount > maxImagesPerRequest) {
    throw new AnthropicProtocolError(
      400,
      'invalid_request_error',
      `Too many images: ${imageCount} exceeds limit of ${maxImagesPerRequest}`
    );
  }

  const metadataUserId =
    isPlainObject(raw.metadata) && typeof raw.metadata.user_id === 'string'
      ? raw.metadata.user_id.trim()
      : '';

  return {
    requestedModel,
    stream: raw.stream === true,
    metadataUserId,
    geminiRequest,
  };
}

export function resolveAnthropicSessionKey(
  req: GeminiGenerateRequest,
  headers?: Headers | Record<string, string | undefined> | null,
  metadataUserId?: string
): string {
  const sessionId = readHeaderCaseInsensitive(headers, 'x-session-id');
  const threadId = readHeaderCaseInsensitive(headers, 'x-thread-id');
  const subagentId = readHeaderCaseInsensitive(headers, 'x-claude-code-agent-id');
  const metaUser = typeof metadataUserId === 'string' ? metadataUserId.trim() : '';
  const baseKey = sessionId || threadId || metaUser || computeSessionHash(req);
  return subagentId ? `${baseKey}|agent:${subagentId}` : baseKey;
}

export function mapFinishReasonToStopReason(
  finishReason: string | undefined,
  hasToolUse: boolean
): AnthropicStopReason {
  if (hasToolUse) return 'tool_use';
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  if (finishReason === 'STOP_SEQUENCE') return 'stop_sequence';
  return 'end_turn';
}

export function extractAnthropicUsage(
  req: GeminiGenerateRequest,
  usage?: GeminiGenerateResponse['usageMetadata'],
  outputTextLength = 0,
  thoughtTextLength = 0
): AnthropicUsage {
  const totalPromptTokens = usage?.promptTokenCount ?? estimateTokens(req);
  const candidatesTokens =
    usage?.candidatesTokenCount ??
    (outputTextLength > 0 ? Math.max(1, Math.ceil(outputTextLength / 4)) : 0);
  const thoughtsTokens =
    usage?.thoughtsTokenCount ??
    (thoughtTextLength > 0 ? Math.ceil(thoughtTextLength / 4) : 0);
  const outputTokens = candidatesTokens + thoughtsTokens;
  const cacheRead =
    typeof usage?.cachedContentTokenCount === 'number' && usage.cachedContentTokenCount > 0
      ? Math.min(usage.cachedContentTokenCount, totalPromptTokens)
      : 0;
  const cacheCreation =
    typeof usage?.cacheCreationTokenCount === 'number' && usage.cacheCreationTokenCount > 0
      ? usage.cacheCreationTokenCount
      : 0;
  const inputTokens = Math.max(0, totalPromptTokens - cacheRead);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cache_creation_input_tokens: cacheCreation } : {}),
  };
}

export function convertGeminiToAnthropicResponse(
  geminiResp: GeminiGenerateResponse,
  req: GeminiGenerateRequest,
  model: string,
  messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
): AnthropicMessageResponse {
  const content: AnthropicResponseBlock[] = [];
  let outputTextLength = 0;
  let thoughtTextLength = 0;
  let hasToolUse = false;

  const candidate = geminiResp.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    if (!part) continue;
    if (part.thought === true && typeof part.text === 'string') {
      if (part.text.length === 0) continue;
      thoughtTextLength += part.text.length;
      const last = content[content.length - 1];
      if (last && last.type === 'thinking') {
        last.thinking += part.text;
      } else {
        content.push({ type: 'thinking', thinking: part.text });
      }
      continue;
    }
    if (!part.thought && typeof part.text === 'string') {
      if (part.text.length === 0) continue;
      outputTextLength += part.text.length;
      const last = content[content.length - 1];
      if (last && last.type === 'text') {
        last.text += part.text;
      } else {
        content.push({ type: 'text', text: part.text });
      }
      continue;
    }
    if (part.functionCall) {
      hasToolUse = true;
      const id =
        part.functionCall.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      content.push({
        type: 'tool_use',
        id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReasonToStopReason(candidate?.finishReason, hasToolUse),
    stop_sequence: null,
    usage: extractAnthropicUsage(
      req,
      geminiResp.usageMetadata,
      outputTextLength,
      thoughtTextLength
    ),
  };
}

export function formatAnthropicSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class AnthropicStreamSerializer {
  private readonly messageId: string;
  private readonly model: string;
  private activeBlockType: 'thinking' | 'text' | null = null;
  private activeBlockIndex = -1;
  private sawToolUse = false;
  private outputTextLength = 0;
  private thoughtTextLength = 0;
  private started = false;
  private finished = false;

  constructor(messageId: string, model: string) {
    this.messageId = messageId;
    this.model = model;
  }

  startMessage(inputTokens = 0): string {
    if (this.started) return '';
    this.started = true;
    return formatAnthropicSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  private closeActiveBlock(out: string[]): void {
    if (this.activeBlockType !== null) {
      out.push(
        formatAnthropicSseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: this.activeBlockIndex,
        })
      );
      this.activeBlockType = null;
    }
  }

  processChunk(chunk: GeminiGenerateResponse): string {
    if (this.finished) return '';
    const out: string[] = [];
    for (const cand of chunk.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if (!part) continue;
        if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
          this.thoughtTextLength += part.text.length;
          if (this.activeBlockType !== 'thinking') {
            this.closeActiveBlock(out);
            this.activeBlockIndex += 1;
            this.activeBlockType = 'thinking';
            out.push(
              formatAnthropicSseEvent('content_block_start', {
                type: 'content_block_start',
                index: this.activeBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              })
            );
          }
          out.push(
            formatAnthropicSseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.activeBlockIndex,
              delta: { type: 'thinking_delta', thinking: part.text },
            })
          );
          continue;
        }

        if (!part.thought && typeof part.text === 'string' && part.text.length > 0) {
          this.outputTextLength += part.text.length;
          if (this.activeBlockType !== 'text') {
            this.closeActiveBlock(out);
            this.activeBlockIndex += 1;
            this.activeBlockType = 'text';
            out.push(
              formatAnthropicSseEvent('content_block_start', {
                type: 'content_block_start',
                index: this.activeBlockIndex,
                content_block: { type: 'text', text: '' },
              })
            );
          }
          out.push(
            formatAnthropicSseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.activeBlockIndex,
              delta: { type: 'text_delta', text: part.text },
            })
          );
          continue;
        }

        if (part.functionCall) {
          this.closeActiveBlock(out);
          this.sawToolUse = true;
          this.activeBlockIndex += 1;
          const toolId =
            part.functionCall.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
          const argsJson = JSON.stringify(part.functionCall.args ?? {});
          out.push(
            formatAnthropicSseEvent('content_block_start', {
              type: 'content_block_start',
              index: this.activeBlockIndex,
              content_block: {
                type: 'tool_use',
                id: toolId,
                name: part.functionCall.name,
                input: {},
              },
            })
          );
          out.push(
            formatAnthropicSseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.activeBlockIndex,
              delta: { type: 'input_json_delta', partial_json: argsJson },
            })
          );
          out.push(
            formatAnthropicSseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: this.activeBlockIndex,
            })
          );
        }
      }
    }
    return out.join('');
  }

  finishMessage(
    req: GeminiGenerateRequest,
    finishReason?: string,
    usageMetadata?: GeminiGenerateResponse['usageMetadata']
  ): string {
    if (this.finished) return '';
    this.finished = true;
    const out: string[] = [];
    this.closeActiveBlock(out);
    const stopReason = mapFinishReasonToStopReason(finishReason, this.sawToolUse);
    const usage = extractAnthropicUsage(
      req,
      usageMetadata,
      this.outputTextLength,
      this.thoughtTextLength
    );
    out.push(
      formatAnthropicSseEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage,
      })
    );
    out.push(formatAnthropicSseEvent('message_stop', { type: 'message_stop' }));
    return out.join('');
  }

  getMeasuredLengths(): { outputTextLength: number; thoughtTextLength: number } {
    return {
      outputTextLength: this.outputTextLength,
      thoughtTextLength: this.thoughtTextLength,
    };
  }
}
