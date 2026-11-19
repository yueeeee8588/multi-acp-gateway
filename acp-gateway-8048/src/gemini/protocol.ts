import { createHash } from 'node:crypto';
import type {
  GeminiContent,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  GeminiPart,
} from '../types';

export class GeminiProtocolError extends Error {
  readonly statusCode: number;
  readonly reasonCode: string;

  constructor(statusCode: number, message: string, reasonCode = 'INVALID_ARGUMENT') {
    super(message);
    this.name = 'GeminiProtocolError';
    this.statusCode = statusCode;
    this.reasonCode = reasonCode;
  }
}

export function countInlineImages(req: GeminiGenerateRequest): number {
  let count = 0;

  const countInParts = (parts?: GeminiPart[]) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (part && typeof part === 'object' && part.inlineData && typeof part.inlineData === 'object') {
        count += 1;
      }
    }
  };

  if (req.systemInstruction && typeof req.systemInstruction === 'object') {
    countInParts(req.systemInstruction.parts);
  }

  if (Array.isArray(req.contents)) {
    for (const content of req.contents) {
      if (content && typeof content === 'object') {
        countInParts(content.parts);
      }
    }
  }

  return count;
}

export function sanitizeInlineData(req: GeminiGenerateRequest): void {
  const cleanParts = (parts?: GeminiPart[]): GeminiPart[] | undefined => {
    if (!Array.isArray(parts)) return parts;
    const filtered = parts.filter((part) => {
      if (!part || typeof part !== 'object') return false;
      if (part.inlineData !== undefined) {
        if (
          !part.inlineData ||
          typeof part.inlineData !== 'object' ||
          typeof part.inlineData.data !== 'string' ||
          part.inlineData.data.trim() === ''
        ) {
          // Drop invalid/empty inlineData; keep part only if it has other valid fields
          delete (part as Partial<GeminiPart>).inlineData;
          return Boolean(
            typeof part.text === 'string' ||
              part.functionCall ||
              part.functionResponse
          );
        }
      }
      return true;
    });
    return filtered;
  };

  if (req.systemInstruction && typeof req.systemInstruction === 'object') {
    req.systemInstruction.parts = cleanParts(req.systemInstruction.parts) ?? [];
  }

  if (Array.isArray(req.contents)) {
    for (const content of req.contents) {
      if (content && typeof content === 'object' && Array.isArray(content.parts)) {
        const cleaned = cleanParts(content.parts) ?? [];
        content.parts = cleaned.length > 0 ? cleaned : [{ text: '' }];
      }
    }
  }
}

export function getGoogleRpcStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 503:
      return 'UNAVAILABLE';
    case 500:
      return 'INTERNAL';
    default:
      return statusCode >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT';
  }
}

export function validateAndParseGeminiRequest(
  raw: unknown,
  maxImagesPerRequest = 200
): GeminiGenerateRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GeminiProtocolError(400, 'Request body must be a JSON object');
  }

  const req = raw as GeminiGenerateRequest & { system_instruction?: GeminiGenerateRequest['systemInstruction'] };

  if (req.systemInstruction === undefined && req.system_instruction !== undefined) {
    req.systemInstruction = req.system_instruction;
  }

  if (!Array.isArray(req.contents) || req.contents.length === 0) {
    throw new GeminiProtocolError(400, 'Request must include a non-empty "contents" array');
  }

  for (let i = 0; i < req.contents.length; i++) {
    const item = req.contents[i];
    if (!item || typeof item !== 'object' || !Array.isArray(item.parts)) {
      throw new GeminiProtocolError(400, `contents[${i}].parts must be an array`);
    }
  }

  if (req.systemInstruction !== undefined) {
    if (
      !req.systemInstruction ||
      typeof req.systemInstruction !== 'object' ||
      !Array.isArray(req.systemInstruction.parts)
    ) {
      throw new GeminiProtocolError(400, 'systemInstruction.parts must be an array');
    }
  }

  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) {
      throw new GeminiProtocolError(400, 'tools must be an array');
    }
  }

  sanitizeInlineData(req);

  const imageCount = countInlineImages(req);
  if (imageCount > maxImagesPerRequest) {
    throw new GeminiProtocolError(
      400,
      `Too many inlineData images: ${imageCount} exceeds limit of ${maxImagesPerRequest}`,
      'TOO_MANY_IMAGES'
    );
  }

  return req;
}

function extractStableTextFromContent(content?: { parts?: GeminiPart[] }): string {
  if (!content || !Array.isArray(content.parts)) return '';
  const chunks: string[] = [];
  for (const part of content.parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      chunks.push(part.text);
    } else if (part.inlineData) {
      chunks.push(`[inlineData:${part.inlineData.mimeType}:${part.inlineData.data.slice(0, 32)}]`);
    } else if (part.functionCall) {
      chunks.push(`[functionCall:${part.functionCall.name}]`);
    } else if (part.functionResponse) {
      chunks.push(`[functionResponse:${part.functionResponse.name}]`);
    }
  }
  return chunks.join('\n');
}

export function computeSessionHash(req: GeminiGenerateRequest): string {
  const sysText = extractStableTextFromContent(req.systemInstruction);
  const firstUser = req.contents.find((c: GeminiContent) => !c.role || c.role === 'user') ?? req.contents[0];
  const userText = extractStableTextFromContent(firstUser);

  const hash = createHash('sha256');
  hash.update('sys:');
  hash.update(sysText);
  hash.update('\nuser0:');
  hash.update(userText);
  return hash.digest('hex').slice(0, 24);
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

export function resolveSessionKey(
  req: GeminiGenerateRequest,
  headers?: Headers | Record<string, string | undefined> | null
): string {
  const sessionId = readHeaderCaseInsensitive(headers, 'x-session-id');
  const threadId = readHeaderCaseInsensitive(headers, 'x-thread-id');
  const subagentId = readHeaderCaseInsensitive(headers, 'x-claude-code-agent-id');
  const baseKey = sessionId || threadId || computeSessionHash(req);
  return subagentId ? `${baseKey}|agent:${subagentId}` : baseKey;
}

export function formatSseChunk(response: GeminiGenerateResponse): string {
  // Strictly single-line JSON after `data: ` followed by `\n\n`
  const json = JSON.stringify(response);
  return `data: ${json}\n\n`;
}

export function estimateTokens(req: GeminiGenerateRequest): number {
  let chars = 0;
  let imageTokens = 0;

  const scanParts = (parts?: GeminiPart[]) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') chars += part.text.length;
      if (part.functionCall) chars += JSON.stringify(part.functionCall).length;
      if (part.functionResponse) chars += JSON.stringify(part.functionResponse).length;
      if (part.inlineData) imageTokens += 258;
    }
  };

  if (req.systemInstruction) {
    scanParts(req.systemInstruction.parts);
  }
  for (const content of req.contents) {
    scanParts(content.parts);
  }
  if (req.tools) {
    chars += JSON.stringify(req.tools).length;
  }

  return Math.max(1, Math.ceil(chars / 4) + imageTokens);
}

export function normalizeModelName(model: string): string {
  return model.replace(/^models\//, '').trim();
}

const FLASH_25_COMPAT_EXACT = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking',
]);

export interface ResolveGatewayModelOptions {
  thinkingConfig?: Record<string, unknown> | null;
  reasoningEffort?: string | null;
}

function resolveNeonThinkingModel(options?: ResolveGatewayModelOptions): string {
  if (typeof options?.reasoningEffort === 'string') {
    const effort = options.reasoningEffort.trim().toLowerCase();
    if (effort === 'none' || effort === 'minimal' || effort === 'low') {
      return 'gemini-4-neon-low';
    }
    if (effort === 'medium') {
      return 'gemini-4-neon-medium';
    }
    if (effort === 'high') {
      return 'gemini-4-neon-high';
    }
    if (effort === 'xhigh') {
      return 'gemini-4-neon-xhigh';
    }
  }

  const thinkingConfig = options?.thinkingConfig;
  if (thinkingConfig && typeof thinkingConfig === 'object') {
    if (typeof thinkingConfig.thinkingLevel === 'string') {
      const level = thinkingConfig.thinkingLevel.trim().toLowerCase();
      if (level) {
        if (level === 'none' || level === 'off' || level === 'minimal' || level === 'low') {
          return 'gemini-4-neon-low';
        }
        if (level === 'medium') {
          return 'gemini-4-neon-medium';
        }
        if (level === 'high') {
          return 'gemini-4-neon-high';
        }
        if (level === 'xhigh' || level === 'max' || level === 'extra_high') {
          return 'gemini-4-neon-xhigh';
        }
      }
    }

    if (thinkingConfig.includeThoughts === false) {
      return 'gemini-4-neon-low';
    }

    if (
      typeof thinkingConfig.thinkingBudget === 'number' &&
      Number.isFinite(thinkingConfig.thinkingBudget)
    ) {
      const budget = thinkingConfig.thinkingBudget;
      if (budget === -1) return 'gemini-4-neon-medium';
      if (budget <= 1024) return 'gemini-4-neon-low';
      if (budget <= 8192) return 'gemini-4-neon-medium';
      if (budget <= 24576) return 'gemini-4-neon-high';
      return 'gemini-4-neon-xhigh';
    }
  }

  return 'gemini-4-neon-medium';
}

export function resolveGatewayModel(model: string, options?: ResolveGatewayModelOptions): string {
  const normalized = normalizeModelName(model);
  const lower = normalized.toLowerCase();
  if (lower === 'gemini-4-neon') return resolveNeonThinkingModel(options);
  if (lower === 'gemini-4-hydrogen') return 'gemini-4-hydrogen-medium';
  if (
    FLASH_25_COMPAT_EXACT.has(lower) ||
    (lower.startsWith('gemini-2.5-flash-preview') &&
      !/(?:^|-)(?:image|tts|native-audio)(?:-|$)/.test(lower))
  ) {
    return 'gemini-3.8-flash-low';
  }
  return normalized;
}

export function getModelFamily(model: string): string {
  const m = normalizeModelName(model).toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gemini-4') || m.includes('argon')) return 'gemini-4';
  if (m.includes('gemini-3')) return 'gemini-3';
  if (m.includes('gemini-2.5')) return 'gemini-2.5';
  if (m.includes('gemini-2.0') || m.includes('gemini-2')) return 'gemini-2';
  return 'gemini';
}
