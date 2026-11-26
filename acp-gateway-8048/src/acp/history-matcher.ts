import { createHash } from "node:crypto";

const TRAILING_NUDGE_RE =
  /(?:\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>|<nudge>[\s\S]*?<\/nudge>|\[nudge\][\s\S]*?\[\/nudge\]|\[(?:system[- ]?reminder|system[- ]?note|nudge)\s*:[^\]]*\]))+\s*$/i;

const INLINE_THOUGHT_TAG_RE = /<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi;

const PLACEHOLDER_BOUNDARY_RE =
  /\s*(\[(?:REDACTED|FILTERED|MASKED|SENSITIVE|已脱敏|脱敏)[^\]]*\]|<(?:REDACTED|FILTERED|MASKED)>|\*{3,})\s*/gi;

const MAGPIE_EXACT_PLACEHOLDERS = new Set([
  "[an earlier image was left out here to keep this request under its size limit.]",
  "[an earlier image was omitted here to keep this request within the model's image limit.]",
  "[this image is omitted here; the same image appears again later in this conversation.]",
]);

const MAGPIE_SIZE_PLACEHOLDER_RE =
  /^\[\d+(?:\.\d+)?\s*(?:KB|MB|GB)?\s*image left out here:[\s\S]*\]$/i;

const ZH_IMAGE_PLACEHOLDER_INNER_RE =
  /^(?:(?:历史)?图片(?:内容)?(?:已(?:省略|替换为文字占位(?:符)?|占位|降载|移除|跳过|清理|压缩)|占位(?:符)?)|已(?:省略|移除|跳过|降载)图片|历史图片)(?:$|[:：\s,，.。…—\-].*$)/;

const EN_IMAGE_PLACEHOLDER_INNER_RE =
  /^(?:(?:(?:earlier|historical|previous)\s+)?image\s+(?:omitted|placeholder|left\s+out|removed|skipped|offloaded|replaced)|(?:omitted|placeholder)\s+image)(?:$|[:\s,\.…—\-].*$)/i;

const INLINE_BRACKET_RE = /\[[^\]\r\n]+\]/g;

const OMITTED_MEDIA = Symbol("OMITTED_MEDIA");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMediaPart(part: Record<string, unknown>): boolean {
  if (isRecord(part.inlineData) || isRecord(part.inline_data)) {
    return true;
  }
  if (isRecord(part.fileData) || isRecord(part.file_data)) {
    return true;
  }
  if (part.type === "image_url" || part.type === "image") {
    return true;
  }
  return false;
}

function isBracketImagePlaceholder(bracketedText: string): boolean {
  const trimmed = bracketedText.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return false;
  }
  if (MAGPIE_EXACT_PLACEHOLDERS.has(trimmed.toLowerCase())) {
    return true;
  }
  if (MAGPIE_SIZE_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner || /[\r\n]/.test(inner)) {
    return false;
  }
  return (
    ZH_IMAGE_PLACEHOLDER_INNER_RE.test(inner) ||
    EN_IMAGE_PLACEHOLDER_INNER_RE.test(inner)
  );
}

function extractTextAndMediaPlaceholders(raw: string): {
  text: string;
  mediaCount: number;
} {
  const normalized = raw.replace(/\r\n?/g, "\n").replace(INLINE_THOUGHT_TAG_RE, " ");
  const trimmed = normalized.trim();
  if (trimmed && isBracketImagePlaceholder(trimmed)) {
    return { text: "", mediaCount: 1 };
  }

  let mediaCount = 0;
  const lines = normalized.split("\n");
  const keptLines: string[] = [];

  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (lineTrimmed && isBracketImagePlaceholder(lineTrimmed)) {
      mediaCount += 1;
      continue;
    }
    const replaced = line.replace(INLINE_BRACKET_RE, (match) => {
      if (isBracketImagePlaceholder(match)) {
        mediaCount += 1;
        return " ";
      }
      return match;
    });
    keptLines.push(replaced);
  }

  return { text: keptLines.join("\n"), mediaCount };
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function normalizeTextSegment(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  text = text.replace(INLINE_THOUGHT_TAG_RE, " ");
  text = text.replace(PLACEHOLDER_BOUNDARY_RE, " $1 ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function stripTrailingNudge(text: string): string {
  return text.replace(TRAILING_NUDGE_RE, "").replace(/\s+/g, " ").trim();
}

function canonicalizeValue(value: unknown, mediaCtx?: { count: number }): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    if (mediaCtx) {
      const extracted = extractTextAndMediaPlaceholders(value);
      if (extracted.mediaCount > 0) {
        mediaCtx.count += extracted.mediaCount;
        return extracted.text.replace(/\s+/g, " ").trim();
      }
    }
    return value.replace(/\r\n?/g, "\n");
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const canonical = canonicalizeValue(item, mediaCtx);
      if (canonical !== OMITTED_MEDIA) {
        out.push(canonical);
      }
    }
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (mediaCtx && isMediaPart(obj)) {
    mediaCtx.count += 1;
    return OMITTED_MEDIA;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (key === "thoughtSignature") continue;
    const v = obj[key];
    if (v === undefined) continue;
    const canonical = canonicalizeValue(v, mediaCtx);
    if (canonical !== OMITTED_MEDIA) {
      sorted[key] = canonical;
    }
  }
  return sorted;
}

function normalizeFunctionResponse(
  rawFr: unknown,
  mediaCtx: { count: number },
): unknown {
  if (!isRecord(rawFr)) {
    return canonicalizeValue(rawFr, mediaCtx);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(rawFr).sort()) {
    if (key === "thoughtSignature") continue;
    const v = rawFr[key];
    if (v === undefined) continue;
    if (key === "parts" && Array.isArray(v)) {
      const extracted = extractNormalizedParts(v);
      mediaCtx.count += extracted.mediaCount;
      if (extracted.parts.length > 0) {
        sorted.parts = extracted.parts;
      }
      continue;
    }
    const canonical = canonicalizeValue(v, mediaCtx);
    if (canonical !== OMITTED_MEDIA) {
      sorted[key] = canonical;
    }
  }
  return sorted;
}

function extractNormalizedParts(parts: unknown[]): {
  parts: unknown[];
  mediaCount: number;
} {
  const normalized: unknown[] = [];
  let textAcc = "";
  let mediaCount = 0;

  const flushText = () => {
    const extracted = extractTextAndMediaPlaceholders(textAcc);
    mediaCount += extracted.mediaCount;
    const cleaned = normalizeTextSegment(extracted.text);
    if (cleaned) {
      normalized.push({ type: "text", text: cleaned });
    }
    textAcc = "";
  };

  for (const rawPart of parts) {
    if (typeof rawPart === "string") {
      textAcc += (textAcc ? "\n" : "") + rawPart;
      continue;
    }
    if (!isRecord(rawPart)) {
      flushText();
      normalized.push(canonicalizeValue(rawPart));
      continue;
    }

    // 容忍 thought 块增删
    if (
      rawPart.thought === true ||
      rawPart.type === "thinking" ||
      rawPart.type === "thought" ||
      rawPart.type === "redacted_thinking"
    ) {
      continue;
    }

    // 识别结构化媒体块，计入 mediaCount 并剥离原始媒体载荷
    if (isMediaPart(rawPart)) {
      mediaCount += 1;
      continue;
    }

    if (
      typeof rawPart.text === "string" &&
      Object.keys(rawPart).every(
        (k) =>
          k === "text" ||
          k === "thought" ||
          k === "thoughtSignature" ||
          k === "type",
      )
    ) {
      textAcc += (textAcc ? "\n" : "") + rawPart.text;
      continue;
    }

    flushText();
    const copy: Record<string, unknown> = {};
    const mediaCtx = { count: 0 };
    for (const key of Object.keys(rawPart).sort()) {
      if (key === "thoughtSignature") continue;
      if (rawPart[key] === undefined) continue;
      if (key === "functionResponse") {
        copy[key] = normalizeFunctionResponse(rawPart[key], mediaCtx);
        continue;
      }
      if (rawPart.type === "tool_result" && key === "content") {
        if (Array.isArray(rawPart[key])) {
          const extracted = extractNormalizedParts(rawPart[key]);
          mediaCtx.count += extracted.mediaCount;
          copy[key] = extracted.parts;
          continue;
        }
        if (typeof rawPart[key] === "string") {
          const extracted = extractNormalizedParts([{ text: rawPart[key] }]);
          mediaCtx.count += extracted.mediaCount;
          copy[key] = extracted.parts;
          continue;
        }
      }
      const canonical = canonicalizeValue(rawPart[key], mediaCtx);
      if (canonical !== OMITTED_MEDIA) {
        copy[key] = canonical;
      }
    }
    mediaCount += mediaCtx.count;
    normalized.push(copy);
  }

  flushText();

  // 剥离末尾单次 nudge 注入差异
  if (normalized.length > 0) {
    const last = normalized[normalized.length - 1];
    if (isRecord(last) && last.type === "text" && typeof last.text === "string") {
      const stripped = stripTrailingNudge(last.text);
      if (stripped) {
        last.text = stripped;
      } else {
        normalized.pop();
      }
    }
  }

  return { parts: normalized, mediaCount };
}

/**
 * 将单条历史消息归一化为确定性字符串，用于精确 hash 失配后的容错前缀比对。
 * 容忍：字段顺序/空白微调、thought 块增删、末尾单次 nudge 注入差异、脱敏占位符粘连边界、
 * 历史图片块与对应图片占位符之间的等价替换（保留 mediaCount 防数量篡改）；
 * 对实质内容（role、正文语义、媒体数量、工具调用/响应等）保持严格敏感。
 */
export function normalizeMessageForHistory(msg: unknown): string {
  if (msg === null || msg === undefined) {
    return "";
  }
  if (typeof msg === "string") {
    const extracted = extractTextAndMediaPlaceholders(msg);
    const cleaned = stripTrailingNudge(normalizeTextSegment(extracted.text));
    if (extracted.mediaCount > 0) {
      return JSON.stringify({
        text: cleaned,
        mediaCount: extracted.mediaCount,
      });
    }
    return cleaned;
  }
  if (!isRecord(msg)) {
    return JSON.stringify(canonicalizeValue(msg));
  }

  const role = typeof msg.role === "string" ? msg.role.trim().toLowerCase() : "";

  // GeminiContent 格式: { role, parts }
  if (Array.isArray(msg.parts)) {
    const { parts, mediaCount } = extractNormalizedParts(msg.parts);
    const out: Record<string, unknown> = { role, parts };
    if (mediaCount > 0) {
      out.mediaCount = mediaCount;
    }
    return JSON.stringify(out);
  }

  // OpenAI / Anthropic 消息格式: { role, content, ... }
  const out: Record<string, unknown> = { role };
  let mediaCount = 0;
  if (typeof msg.content === "string") {
    const extracted = extractNormalizedParts([{ text: msg.content }]);
    out.parts = extracted.parts;
    mediaCount += extracted.mediaCount;
  } else if (Array.isArray(msg.content)) {
    const extracted = extractNormalizedParts(msg.content);
    out.parts = extracted.parts;
    mediaCount += extracted.mediaCount;
  } else if (msg.content !== undefined) {
    const mediaCtx = { count: 0 };
    const canonical = canonicalizeValue(msg.content, mediaCtx);
    if (canonical !== OMITTED_MEDIA) {
      out.content = canonical;
    }
    mediaCount += mediaCtx.count;
  }

  for (const key of Object.keys(msg).sort()) {
    if (
      key === "role" ||
      key === "content" ||
      key === "parts" ||
      key === "reasoning_content" ||
      key === "reasoning" ||
      key === "thought" ||
      key === "thoughtSignature"
    ) {
      continue;
    }
    if (msg[key] !== undefined) {
      const mediaCtx = { count: 0 };
      const canonical = canonicalizeValue(msg[key], mediaCtx);
      if (canonical !== OMITTED_MEDIA) {
        out[key] = canonical;
      }
      mediaCount += mediaCtx.count;
    }
  }

  if (mediaCount > 0) {
    out.mediaCount = mediaCount;
  }

  return JSON.stringify(out);
}

/**
 * 在已提交历史前缀与传入消息序列之间查找可复用前缀长度：
 * 1. 精确 JSON hash 匹配优先；
 * 2. 若精确 hash 失配，降级到归一化文本比对；
 * 3. 一旦出现实质内容篡改，立即 Fail-Fast 返回当前已匹配长度。
 */
export function findReusablePrefixLength(
  committedHashes: string[],
  committedNormalized: string[],
  incomingMessages: unknown[],
): { matchedCount: number; exact: boolean } {
  const committedLen =
    committedHashes.length > 0 ? committedHashes.length : committedNormalized.length;
  const limit = Math.min(committedLen, incomingMessages.length);

  if (limit === 0) {
    return { matchedCount: 0, exact: true };
  }

  let exact = true;
  let matchedCount = 0;

  for (let i = 0; i < limit; i++) {
    const incoming = incomingMessages[i];
    const incomingHash = hashJson(incoming);
    if (i < committedHashes.length && incomingHash === committedHashes[i]) {
      matchedCount += 1;
      continue;
    }

    exact = false;
    const expectedNorm = committedNormalized[i];
    if (expectedNorm === undefined) {
      break;
    }
    const incomingNorm = normalizeMessageForHistory(incoming);
    if (incomingNorm !== expectedNorm) {
      break;
    }
    matchedCount += 1;
  }

  return { matchedCount, exact };
}
