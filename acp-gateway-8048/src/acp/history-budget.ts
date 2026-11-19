import type { GeminiContent } from "../types";

export const DEFAULT_HISTORY_BUDGET_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TOOL_RESULT_CLIP_BYTES = 12 * 1024;
export const DEFAULT_TOOL_RESULT_KEEP_BYTES = 4 * 1024;

const HISTORY_OMISSION_NOTICE =
  "[... earlier conversation history omitted to fit ACP 8 MiB prompt budget ...]";

const textEncoder = new TextEncoder();

export interface HistorySerializeOptions {
  maxTotalBytes?: number;
  maxToolResultBytes?: number;
  keepBytes?: number;
}

/**
 * Return a UTF-8 prefix of `str` whose byte length is at most `maxBytes`,
 * using `TextEncoder.prototype.encodeInto` so multi-byte characters and
 * surrogate pairs are never split.
 */
function sliceUtf8Prefix(str: string, maxBytes: number): string {
  if (maxBytes <= 0 || str.length === 0) return "";
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  const buf = new Uint8Array(maxBytes);
  const { read } = textEncoder.encodeInto(str, buf);
  return str.slice(0, read);
}

/**
 * Return a UTF-8 suffix of `str` whose byte length is at most `maxBytes`,
 * stepping backwards by complete Unicode scalar values so multi-byte
 * characters and surrogate pairs are never split.
 */
function sliceUtf8Suffix(str: string, maxBytes: number): string {
  if (maxBytes <= 0 || str.length === 0) return "";
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;

  let bytes = 0;
  let start = str.length;
  while (start > 0) {
    let cpStart = start - 1;
    const code = str.charCodeAt(cpStart);
    if (code >= 0xdc00 && code <= 0xdfff && cpStart > 0) {
      const prev = str.charCodeAt(cpStart - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) {
        cpStart -= 1;
      }
    }
    const cpBytes = Buffer.byteLength(str.slice(cpStart, start), "utf8");
    if (bytes + cpBytes > maxBytes) {
      break;
    }
    bytes += cpBytes;
    start = cpStart;
  }
  return str.slice(start);
}

/**
 * Clip `text` to head + tail (`keepBytes` each) when its UTF-8 byte length
 * exceeds `maxBytes`.
 */
function clipTextHeadTail(text: string, maxBytes: number, keepBytes: number): string {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;

  const safeKeep = Math.max(0, Math.min(keepBytes, Math.floor((maxBytes - 1) / 2)));
  const head = sliceUtf8Prefix(text, safeKeep);
  const tail = sliceUtf8Suffix(text, safeKeep);
  const headBytes = Buffer.byteLength(head, "utf8");
  const tailBytes = Buffer.byteLength(tail, "utf8");
  const omitted = totalBytes - headBytes - tailBytes;
  if (omitted <= 0) return text;

  return `${head}\n[... ${omitted} bytes of this history block omitted ...]\n${tail}`;
}

function estimateBlockBytes(block: Record<string, unknown>): number {
  if (block.type === "text" && typeof block.text === "string") {
    return Buffer.byteLength(block.text, "utf8");
  }
  if (block.type === "image") {
    return (
      Buffer.byteLength(String(block.data ?? ""), "utf8") +
      Buffer.byteLength(String(block.mimeType ?? ""), "utf8")
    );
  }
  return Buffer.byteLength(JSON.stringify(block), "utf8");
}

function sumBlocksBytes(blocks: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const b of blocks) {
    total += estimateBlockBytes(b);
  }
  return total;
}

function serializeTurn(
  item: GeminiContent,
  maxToolResultBytes: number,
  keepBytes: number,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const role = item.role || "user";
  const textParts: string[] = [];

  for (const part of item.parts ?? []) {
    if (part.text) {
      const rawText = part.thought ? `[thought]\n${part.text}` : part.text;
      textParts.push(clipTextHeadTail(rawText, maxToolResultBytes, keepBytes));
    } else if (part.functionCall) {
      const rawCall = `[functionCall ${part.functionCall.name}]: ${JSON.stringify(part.functionCall.args ?? {})}`;
      textParts.push(clipTextHeadTail(rawCall, maxToolResultBytes, keepBytes));
    } else if (part.functionResponse) {
      const rawResp = `[functionResponse ${part.functionResponse.name}]: ${JSON.stringify(part.functionResponse.response ?? {})}`;
      textParts.push(clipTextHeadTail(rawResp, maxToolResultBytes, keepBytes));
    } else if (part.inlineData) {
      blocks.push({
        type: "image",
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data,
      });
    }
  }

  if (textParts.length > 0) {
    const combined = `[${role}]\n${textParts.join("\n")}`;
    blocks.push({
      type: "text",
      text: clipTextHeadTail(combined, maxToolResultBytes, keepBytes),
    });
  }

  return blocks;
}

/**
 * Shrink a turn's blocks so their total estimated byte size does not exceed `budgetBytes`.
 */
function fitTurnToBudget(
  turnBlocks: Array<Record<string, unknown>>,
  budgetBytes: number,
): Array<Record<string, unknown>> {
  if (budgetBytes <= 0) return [];
  if (sumBlocksBytes(turnBlocks) <= budgetBytes) return turnBlocks;

  const slots: Array<Record<string, unknown> | null> = new Array(turnBlocks.length).fill(null);
  let remaining = budgetBytes;

  // Pass 1: prioritize text blocks (text / functionCall / functionResponse)
  // so oversized inlineData images in the same turn never crowd out the latest text.
  for (let i = 0; i < turnBlocks.length; i++) {
    if (remaining <= 0) break;
    const block = turnBlocks[i];
    if (block.type !== "text" || typeof block.text !== "string") continue;

    const size = estimateBlockBytes(block);
    if (size <= remaining) {
      slots[i] = block;
      remaining -= size;
    } else {
      // Reserve space for the omission marker if possible; otherwise hard-prefix clip.
      const markerReserve = 80;
      if (remaining > markerReserve + 16) {
        const keep = Math.floor((remaining - markerReserve) / 2);
        let clipped = clipTextHeadTail(block.text, remaining, keep);
        if (Buffer.byteLength(clipped, "utf8") > remaining) {
          clipped = sliceUtf8Prefix(clipped, remaining);
        }
        slots[i] = { type: "text", text: clipped };
      } else {
        slots[i] = { type: "text", text: sliceUtf8Prefix(block.text, remaining) };
      }
      remaining = 0;
    }
  }

  // Pass 2: fit non-text blocks (e.g. inlineData images) into any remaining budget.
  for (let i = 0; i < turnBlocks.length; i++) {
    if (remaining <= 0) break;
    if (slots[i] !== null) continue;
    const block = turnBlocks[i];
    if (block.type === "text") continue;

    const size = estimateBlockBytes(block);
    if (size <= remaining) {
      slots[i] = block;
      remaining -= size;
    }
  }

  return slots.filter((b): b is Record<string, unknown> => b !== null);
}

/**
 * Serialize Gemini `contents` into ACP prompt blocks while enforcing per-block
 * head-tail clipping and a total UTF-8 byte budget. Never mutates `contents`.
 */
export function serializeContentsWithBudget(
  contents: GeminiContent[],
  opts?: HistorySerializeOptions,
): Array<Record<string, unknown>> {
  if (contents.length === 0) return [];

  const maxTotalBytes = Math.max(0, opts?.maxTotalBytes ?? DEFAULT_HISTORY_BUDGET_BYTES);
  const maxToolResultBytes = Math.max(1, opts?.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_CLIP_BYTES);
  const keepBytes = Math.max(0, opts?.keepBytes ?? DEFAULT_TOOL_RESULT_KEEP_BYTES);

  const turns = contents.map((item) => serializeTurn(item, maxToolResultBytes, keepBytes));
  const turnBytes = turns.map(sumBlocksBytes);

  let totalBytes = 0;
  for (const bytes of turnBytes) {
    totalBytes += bytes;
  }

  if (totalBytes <= maxTotalBytes) {
    return turns.flat();
  }

  const omissionBlock: Record<string, unknown> = {
    type: "text",
    text: HISTORY_OMISSION_NOTICE,
  };
  const omissionBytes = estimateBlockBytes(omissionBlock);

  const lastIdx = turns.length - 1;

  if (turns.length >= 2) {
    // Try keeping first turn (anchor) + omission notice + suffix of turns ending at lastIdx.
    const firstTurnBytes = turnBytes[0];
    let suffixBytes = turnBytes[lastIdx];
    let startIdx = lastIdx;

    // Expand suffix backwards while keeping firstTurn + omissionBlock + suffix <= maxTotalBytes.
    for (let i = lastIdx - 1; i >= 1; i--) {
      const candidate = firstTurnBytes + omissionBytes + suffixBytes + turnBytes[i];
      if (candidate <= maxTotalBytes) {
        suffixBytes += turnBytes[i];
        startIdx = i;
      } else {
        break;
      }
    }

    if (firstTurnBytes + omissionBytes + suffixBytes <= maxTotalBytes) {
      const out: Array<Record<string, unknown>> = [...turns[0], omissionBlock];
      for (let i = startIdx; i <= lastIdx; i++) {
        out.push(...turns[i]);
      }
      return out;
    }

    // First anchor squeezes the latest turn; drop first anchor and prioritize latest turn.
    const latestTurn = turns[lastIdx];
    const latestBytes = turnBytes[lastIdx];
    if (omissionBytes + latestBytes <= maxTotalBytes) {
      return [omissionBlock, ...latestTurn];
    }

    if (maxTotalBytes > omissionBytes) {
      return [omissionBlock, ...fitTurnToBudget(latestTurn, maxTotalBytes - omissionBytes)];
    }
    return fitTurnToBudget(latestTurn, maxTotalBytes);
  }

  // Only a single turn exists and it exceeds maxTotalBytes.
  return fitTurnToBudget(turns[0], maxTotalBytes);
}
