import type { AccountRecord } from "./types";

export type AttentionCategory =
  | "violation_blocked"
  | "validation_required"
  | "oauth_reauth_required"
  | "risk_controlled"
  | "forbidden"
  | "manual_disabled";

export type AttentionTone = "danger" | "warning" | "muted";

export type AttentionActionKind =
  | "external_url"
  | "relogin"
  | "enable"
  | "refresh"
  | "details";

export interface AttentionInfo {
  category: AttentionCategory;
  label: string;
  tone: AttentionTone;
  summary: string;
  parsedMessage: string;
  actionUrl: string | null;
  actionLabel: string;
  actionKind: AttentionActionKind;
  isDisabled: boolean;
}

export const ATTENTION_CATEGORY_ORDER: AttentionCategory[] = [
  "violation_blocked",
  "validation_required",
  "oauth_reauth_required",
  "risk_controlled",
  "forbidden",
  "manual_disabled",
];

export const ATTENTION_CATEGORY_LABELS: Record<AttentionCategory, string> = {
  violation_blocked: "由于违规被禁用",
  validation_required: "账号需验证",
  oauth_reauth_required: "授权异常",
  risk_controlled: "风控/限流",
  forbidden: "无权访问",
  manual_disabled: "已停用",
};

const VIOLATION_HINTS = [
  "terms of service",
  "violation",
  "service has been disabled",
  "account has been disabled",
  "suspended",
  "banned",
  "submit an appeal",
];

const VALIDATION_HINTS = [
  "validation_required",
  "verify your account",
  "verification required",
  "validation_url",
];

const OAUTH_HINTS = [
  "invalid_grant",
  "unauthorized_client",
  "invalid_client",
  "unauthenticated",
  "401",
  "awaiting login",
  "oauth",
];

const RISK_CONTROL_HINTS = [
  "resource_exhausted",
  "too many requests",
  "429",
  "rate limit",
  "rate-limited",
  "risk control",
  "风控",
  "冻结",
  "frozen",
];

const EXIT_IP_DRIFT_HINTS = [
  "exit ip drift",
  "exit_ip_drift",
  "ip drift",
  "出口 ip 漂移",
  "出口ip漂移",
];

const PROXY_UNREACHABLE_HINTS = [
  "proxy unreachable",
  "proxy_unreachable",
  "代理不可达",
];

const DEFAULT_APPEAL_URL = "https://forms.gle/hGzM9MEUv2azZsrb9";
const DEFAULT_VALIDATION_URL = "https://accounts.google.com/";

function includesAny(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function isSafeHttpUrl(urlStr: string): boolean {
  return /^https?:\/\//i.test(urlStr.trim());
}

export function isAttentionAccount(acc: AccountRecord): boolean {
  return (
    acc.status === "auth_required" ||
    acc.status === "restricted" ||
    acc.status === "disabled"
  );
}

function stripLeadingWarningPrefix(text: string): string {
  return text.replace(/^\s*(?:⚠\uFE0F?\s*)+/, "");
}

export function extractErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    let innerParsed: Record<string, unknown> | null = null;

    if (typeof parsed?.error === "string") {
      try {
        innerParsed = JSON.parse(parsed.error) as Record<string, unknown>;
      } catch {
        innerParsed = null;
      }
    }

    const innerError = innerParsed?.error as Record<string, unknown> | undefined;
    const outerError = parsed?.error as Record<string, unknown> | undefined;
    const outerDetails = Array.isArray(outerError?.details)
      ? (outerError.details as Array<Record<string, unknown>>)
      : null;
    const innerDetails = Array.isArray(innerError?.details)
      ? (innerError.details as Array<Record<string, unknown>>)
      : null;

    const msg =
      innerError?.message ??
      innerDetails?.[0]?.message ??
      outerError?.message ??
      outerDetails?.[0]?.message ??
      parsed?.message ??
      raw;

    return stripLeadingWarningPrefix(String(msg));
  } catch {
    return stripLeadingWarningPrefix(raw);
  }
}

export function extractActionUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const outerError = parsed?.error as Record<string, unknown> | undefined;
    const outerDetails = Array.isArray(outerError?.details)
      ? (outerError.details as Array<Record<string, unknown>>)
      : null;
    const metadata = outerDetails?.[0]?.metadata as
      | Record<string, unknown>
      | undefined;

    let url =
      metadata?.appeal_url ??
      metadata?.validation_url ??
      parsed?.validation_url ??
      parsed?.appeal_url;

    if (!url && typeof parsed?.error === "string") {
      try {
        const innerParsed = JSON.parse(parsed.error) as Record<string, unknown>;
        const innerError = innerParsed?.error as
          | Record<string, unknown>
          | undefined;
        const innerDetails = Array.isArray(innerError?.details)
          ? (innerError.details as Array<Record<string, unknown>>)
          : null;
        const innerMeta = innerDetails?.[0]?.metadata as
          | Record<string, unknown>
          | undefined;
        url =
          innerMeta?.appeal_url ??
          innerMeta?.validation_url ??
          innerParsed?.validation_url ??
          innerParsed?.appeal_url;
      } catch {
        // ignore nested JSON parse errors
      }
    }

    if (url && isSafeHttpUrl(String(url))) {
      return String(url).trim();
    }
  } catch {
    // fallback to regex extraction
  }

  const urlRegex = /https:\/\/[^\s"'<>]+/g;
  const match = raw.match(urlRegex);
  if (match && match.length > 0) {
    let extracted = match[0]
      .replace(/\\u0026/g, "&")
      .replace(/\\"/g, "")
      .replace(/\\/g, "");
    extracted = extracted.replace(/[.,;)\]]+$/, "");
    if (isSafeHttpUrl(extracted)) {
      return extracted.trim();
    }
  }

  return null;
}

export function resolveAttentionInfo(acc: AccountRecord): AttentionInfo {
  const rawReason = acc.statusReason || "";
  const normalized = rawReason.toLowerCase();
  const parsedMessage = extractErrorMessage(rawReason);
  const extractedUrl = extractActionUrl(rawReason);
  const isDisabled = acc.status === "disabled";

  if (includesAny(normalized, VIOLATION_HINTS)) {
    return {
      category: "violation_blocked",
      label: ATTENTION_CATEGORY_LABELS.violation_blocked,
      tone: "danger",
      summary: "账号因违反服务条款被停用或封禁，建议前往申诉或停用隔离。",
      parsedMessage,
      actionUrl: extractedUrl || DEFAULT_APPEAL_URL,
      actionLabel: "前往申诉",
      actionKind: "external_url",
      isDisabled,
    };
  }

  if (includesAny(normalized, VALIDATION_HINTS)) {
    return {
      category: "validation_required",
      label: ATTENTION_CATEGORY_LABELS.validation_required,
      tone: "warning",
      summary: "上游要求完成人机或账号安全验证，请在同出口代理下验证后刷新。",
      parsedMessage,
      actionUrl: extractedUrl || DEFAULT_VALIDATION_URL,
      actionLabel: "前往验证",
      actionKind: "external_url",
      isDisabled,
    };
  }

  if (acc.status === "auth_required" || includesAny(normalized, OAUTH_HINTS)) {
    return {
      category: "oauth_reauth_required",
      label: ATTENTION_CATEGORY_LABELS.oauth_reauth_required,
      tone: "warning",
      summary: "OAuth 授权已失效或尚未完成登录，请重新发起登录授权。",
      parsedMessage,
      actionUrl: extractedUrl,
      actionLabel: "重新登录",
      actionKind: "relogin",
      isDisabled,
    };
  }

  if (includesAny(normalized, EXIT_IP_DRIFT_HINTS)) {
    return {
      category: "risk_controlled",
      label: "出口 IP 漂移",
      tone: "warning",
      summary: "检测到账号出口 IP 发生漂移，已触发防漂移熔断保护（非 ToS 封号），请检查代理后重新探活。",
      parsedMessage,
      actionUrl: extractedUrl,
      actionLabel: "检查代理并重新探活",
      actionKind: "refresh",
      isDisabled,
    };
  }

  if (includesAny(normalized, PROXY_UNREACHABLE_HINTS)) {
    return {
      category: "risk_controlled",
      label: "代理不可达",
      tone: "danger",
      summary: "强代理绑定已拦截请求，当前配置的代理节点不可达（非 ToS 封号），请检查代理节点与网络后重新探活。",
      parsedMessage,
      actionUrl: extractedUrl,
      actionLabel: "检查代理并重新探活",
      actionKind: "refresh",
      isDisabled,
    };
  }

  if (includesAny(normalized, RISK_CONTROL_HINTS)) {
    return {
      category: "risk_controlled",
      label: ATTENTION_CATEGORY_LABELS.risk_controlled,
      tone: "warning",
      summary: "触发上游限流或风控策略，建议降低并发、冷却后刷新再试。",
      parsedMessage,
      actionUrl: extractedUrl,
      actionLabel: "冷却后刷新",
      actionKind: "refresh",
      isDisabled,
    };
  }

  if (acc.status === "restricted") {
    return {
      category: "forbidden",
      label: ATTENTION_CATEGORY_LABELS.forbidden,
      tone: "danger",
      summary: "账号当前无权访问目标服务或被限制调度，建议检查出口并重新探活。",
      parsedMessage,
      actionUrl: extractedUrl,
      actionLabel: "重新探活",
      actionKind: "refresh",
      isDisabled,
    };
  }

  return {
    category: "manual_disabled",
    label: ATTENTION_CATEGORY_LABELS.manual_disabled,
    tone: "muted",
    summary: "账号已手动停用，当前不参与请求调度；需要恢复时点击启用即可。",
    parsedMessage,
    actionUrl: extractedUrl,
    actionLabel: "立即启用",
    actionKind: "enable",
    isDisabled,
  };
}
