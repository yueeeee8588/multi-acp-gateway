export interface VolatileSystemOptions {
  /** true 时保留 AGENT_MODEL_LINE_RE 匹配行，用于兼容旧版 systemHash / sessionKey */
  legacy?: boolean;
}

/**
 * 1. 计费头（x-anthropic-billing-header / billing_header / anthropic-billing）
 */
const BILLING_HEADER_LINE_RE =
  /^\s*(?:x-anthropic-billing-header|anthropic-billing(?:-header)?|billing[_-]header)\s*:.*$/i;

/**
 * 2. Agent 时钟行（Current date / Current local time / Today's date is / Session started at）
 */
const AGENT_CLOCK_LINE_RE =
  /^\s*(?:(?:current\s+(?:local\s+)?(?:date|time)|session\s+started\s+at)\s*[:：]|(?:today(?:'s)?\s+date\s+is|the\s+current\s+local\s+time\s+is)(?:\s*[:：]|\s+\S)).*$/i;

/**
 * 3. 模型 / 知识截止日期声明行（legacy: true 时保留）
 */
export const AGENT_MODEL_LINE_RE =
  /^\s*(?:you\s+are\s+powered\s+by\b.*|your\s+knowledge\s+cutoff\b.*|knowledge\s+cutoff\s*[:：].*|model\s*[:：].*)$/i;

/**
 * 4. 脱敏占位符提示行（含上游 Values written like {{NAME_...}} 与 <system-reminder> 脱敏提示）
 */
const REDACTION_NOTICE_LINE_RE =
  /^\s*(?:\[(?:REDACTED|FILTERED|MASKED|SENSITIVE|已脱敏|脱敏)[^\]]*\]|<(?:REDACTED|FILTERED|MASKED)>|Note:\s*Sensitive\s+content\s+has\s+been\s+redacted.*|Values\s+written\s+like\s+\{\{[A-Z0-9_]+\}\}.*|<system-reminder>\s*(?:\[(?:REDACTED|FILTERED|MASKED|SENSITIVE|已脱敏|脱敏)[^\]]*\]|<(?:REDACTED|FILTERED|MASKED)>|[^<]*(?:redacted|filtered|masked|sensitive|已脱敏|脱敏)[^<]*)\s*<\/system-reminder>)\s*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVolatileLine(line: string, options?: VolatileSystemOptions): boolean {
  if (BILLING_HEADER_LINE_RE.test(line)) {
    return true;
  }
  if (AGENT_CLOCK_LINE_RE.test(line)) {
    return true;
  }
  if (!options?.legacy && AGENT_MODEL_LINE_RE.test(line)) {
    return true;
  }
  if (REDACTION_NOTICE_LINE_RE.test(line)) {
    return true;
  }
  return false;
}

/**
 * 剥离系统提示词中的易变行（计费头、时钟行、模型/截止日期行、脱敏占位提示行），
 * 仅用于稳定哈希计算，不修改发往上游的原始提示词。
 */
export function stripVolatileSystem(
  text: string,
  options?: VolatileSystemOptions,
): string {
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    if (isVolatileLine(line, options)) {
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizePartForHash(
  part: unknown,
  options?: VolatileSystemOptions,
): unknown | undefined {
  if (typeof part === "string") {
    const stripped = stripVolatileSystem(part, options);
    return stripped ? stripped : undefined;
  }
  if (!isRecord(part)) {
    return normalizeSystemValue(part, options);
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(part).sort()) {
    const value = part[key];
    if (value === undefined) {
      continue;
    }
    if (key === "text" && typeof value === "string") {
      out.text = stripVolatileSystem(value, options);
      continue;
    }
    out[key] = normalizeSystemValue(value, options);
  }

  // 若该 part 仅含 text（或 type + text）且剥离后为空字符串，则过滤该 part
  const keys = Object.keys(out);
  if (
    typeof out.text === "string" &&
    out.text === "" &&
    keys.every((k) => k === "text" || k === "type")
  ) {
    return undefined;
  }

  return out;
}

function normalizeSystemValue(
  value: unknown,
  options?: VolatileSystemOptions,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return stripVolatileSystem(value, options);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSystemValue(item, options));
  }

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) {
      continue;
    }
    if (key === "parts" && Array.isArray(v)) {
      const nextParts: unknown[] = [];
      for (const rawPart of v) {
        const normalizedPart = normalizePartForHash(rawPart, options);
        if (normalizedPart !== undefined) {
          nextParts.push(normalizedPart);
        }
      }
      sorted.parts = nextParts;
      continue;
    }
    sorted[key] = normalizeSystemValue(v, options);
  }
  return sorted;
}

/**
 * 纯函数：将 systemInstruction 归一化为可稳定哈希的结构，绝不原地修改入参对象。
 */
export function normalizeSystemInstructionForHash(
  raw: unknown,
  options?: VolatileSystemOptions,
): unknown {
  return normalizeSystemValue(raw, options);
}
