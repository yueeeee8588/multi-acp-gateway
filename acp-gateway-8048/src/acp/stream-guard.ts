export interface AgyStreamQuotaError {
  code: "QUOTA_EXHAUSTED";
  message: string;
  retryAfterSec?: number;
}

export interface AgyStreamGuardResult {
  emit: string;
  quotaError?: AgyStreamQuotaError;
}

type BannerState = "idle" | "expect_please_or_retries" | "expect_retries";

const MAX_LINE_HOLD_CHARS = 256;

const MALFORMED_TOOL_HEADER_RE = /^⚠\s*Your previous response\b/;
const MALFORMED_TOOL_PLEASE_RE = /^Please\b/;
const MALFORMED_TOOL_RETRIES_RE = /^Retries remaining:\s*\d+\b/i;

const QUOTA_STANDALONE_RE =
  /^(?:⚠\s*)?(?:Third-party|Individual)\s+quota reached(?:\s*[.:!—–-]?\s*(?:\(\s*)?(Resets in\s+[0-9]+(?:\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b)(?:[\s,]*[0-9]+(?:\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b))*)\s*\)?)?\s*[.!]?\s*$/i;

const DURATION_UNIT_RE =
  /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;

function parseResetsInSeconds(resetsClause?: string): number | undefined {
  if (!resetsClause) return undefined;
  let total = 0;
  let matched = false;
  DURATION_UNIT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_UNIT_RE.exec(resetsClause)) !== null) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    matched = true;
    const unit = match[2]!.toLowerCase();
    if (unit === "d" || unit.startsWith("day")) {
      total += value * 86_400;
    } else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) {
      total += value * 3_600;
    } else if (unit === "m" || unit.startsWith("min")) {
      total += value * 60;
    } else {
      total += value;
    }
  }
  return matched ? total : undefined;
}

function couldBeTargetPrefix(trimmedLine: string, bannerState: BannerState): boolean {
  if (trimmedLine.length === 0) return true;

  const prefixes: string[] = [
    "⚠",
    "Third-party quota reached",
    "Individual quota reached",
  ];
  if (bannerState === "expect_please_or_retries") {
    prefixes.push("Please", "Retries remaining:");
  } else if (bannerState === "expect_retries") {
    prefixes.push("Retries remaining:");
  }

  const lower = trimmedLine.toLowerCase();
  for (const target of prefixes) {
    const targetLower = target.toLowerCase();
    if (targetLower.startsWith(lower) || lower.startsWith(targetLower)) {
      return true;
    }
  }
  return false;
}

/**
 * 流式输出守卫（移植自 Antigravity-agy-cli-auth 0.1.111 + 0.1.114）：
 * 1. 跨 chunk 行缓冲与行首状态追踪，切除横幅后严格维持下一行的行首状态；
 * 2. 拦截行首独立成条的伪 200 配额耗尽提示（Third-party / Individual quota reached），
 *    提取 Resets in 秒数；正文句子中引用该短语时不误杀，原样放行；
 * 3. 剥离 agy 1.5.12+ 畸形工具三行重试横幅（⚠ Your previous response ... / Please ... / Retries remaining: <N>）。
 */
export class AgyStreamGuard {
  private lineBuf = "";
  private atLineStart = true;
  private bannerState: BannerState = "idle";

  push(chunk: string): AgyStreamGuardResult {
    if (!chunk) {
      return { emit: "" };
    }

    let emit = "";
    let quotaError: AgyStreamQuotaError | undefined;
    let idx = 0;

    while (idx < chunk.length) {
      if (!this.atLineStart) {
        const nlIdx = chunk.indexOf("\n", idx);
        if (nlIdx === -1) {
          emit += chunk.slice(idx);
          break;
        }
        emit += chunk.slice(idx, nlIdx + 1);
        idx = nlIdx + 1;
        this.atLineStart = true;
        this.bannerState = "idle";
        continue;
      }

      const nlIdx = chunk.indexOf("\n", idx);
      if (nlIdx === -1) {
        this.lineBuf += chunk.slice(idx);
        idx = chunk.length;

        const trimmed = this.lineBuf.replace(/^[ \t]+/, "");
        if (
          this.lineBuf.length > MAX_LINE_HOLD_CHARS ||
          (trimmed.length > 0 && !couldBeTargetPrefix(trimmed, this.bannerState))
        ) {
          emit += this.lineBuf;
          this.lineBuf = "";
          this.atLineStart = false;
          this.bannerState = "idle";
        }
        break;
      }

      const rawLineWithNewline = this.lineBuf + chunk.slice(idx, nlIdx + 1);
      this.lineBuf = "";
      idx = nlIdx + 1;

      const lineBody = rawLineWithNewline.replace(/\r?\n$/, "");
      const handled = this.handleCompleteLine(lineBody, rawLineWithNewline);
      if (handled.emit) {
        emit += handled.emit;
      }
      if (handled.quotaError && !quotaError) {
        quotaError = handled.quotaError;
      }
      // 无论本行是否被切除，换行后下一字符必然处于行首
      this.atLineStart = true;
    }

    return quotaError ? { emit, quotaError } : { emit };
  }

  flush(): AgyStreamGuardResult {
    if (!this.lineBuf) {
      this.atLineStart = true;
      this.bannerState = "idle";
      return { emit: "" };
    }

    const pending = this.lineBuf;
    this.lineBuf = "";
    this.atLineStart = true;

    const lineBody = pending.replace(/\r$/, "");
    const handled = this.handleCompleteLine(lineBody, pending);
    this.bannerState = "idle";
    return handled;
  }

  private handleCompleteLine(lineBody: string, rawWithEnding: string): AgyStreamGuardResult {
    const trimmed = lineBody.trim();

    if (this.bannerState === "expect_please_or_retries") {
      if (MALFORMED_TOOL_PLEASE_RE.test(trimmed)) {
        this.bannerState = "expect_retries";
        return { emit: "" };
      }
      if (MALFORMED_TOOL_RETRIES_RE.test(trimmed)) {
        this.bannerState = "idle";
        return { emit: "" };
      }
      this.bannerState = "idle";
    } else if (this.bannerState === "expect_retries") {
      if (MALFORMED_TOOL_RETRIES_RE.test(trimmed)) {
        this.bannerState = "idle";
        return { emit: "" };
      }
      this.bannerState = "idle";
    }

    if (MALFORMED_TOOL_HEADER_RE.test(trimmed)) {
      this.bannerState = "expect_please_or_retries";
      return { emit: "" };
    }

    const quotaMatch = QUOTA_STANDALONE_RE.exec(trimmed);
    if (quotaMatch) {
      const retryAfterSec = parseResetsInSeconds(quotaMatch[1]);
      return {
        emit: "",
        quotaError: {
          code: "QUOTA_EXHAUSTED",
          message: trimmed,
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        },
      };
    }

    return { emit: rawWithEnding };
  }
}
