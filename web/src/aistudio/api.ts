import type {
  AiStudioAccount,
  AiStudioAccountExit,
  AiStudioAccountTask,
  AiStudioActiveRequest,
  AiStudioAuthMode,
  AiStudioAuthSession,
  AiStudioBrowserInfo,
  AiStudioChromeProfile,
  AiStudioConfig,
  AiStudioConfigPatch,
  AiStudioCooldown,
  AiStudioDiscoveredCookieAccount,
  AiStudioImportChromePayload,
  AiStudioImportCookiesPayload,
  AiStudioModel,
  AiStudioStatus,
  AiStudioUpdateInfo,
  AiStudioUsagePair,
  AiStudioUsageRecord,
  AiStudioUsageSummary,
} from "./types";

export const AISTUDIO_PREFIX = "/aistudio-api";

export class AiStudioApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AiStudioApiError";
    this.status = status;
    this.code = code;
  }
}

export function getConsoleHeaders(): Record<string, string> {
  return {
    "X-Console-Path": window.location.pathname,
  };
}

export function checkZakoSessionExpired(res: Response): boolean {
  if (
    res.status === 401 &&
    res.headers.get("x-zako-auth-error") === "session_expired"
  ) {
    window.dispatchEvent(new Event("session-expired"));
    return true;
  }
  return false;
}

async function parseErrorResponse(res: Response): Promise<AiStudioApiError> {
  checkZakoSessionExpired(res);
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string; code?: string } | string;
    message?: string;
  } | null;
  const detail =
    typeof body?.error === "string" ? body.error : body?.error?.message;
  const code =
    typeof body?.error === "object" ? body?.error?.code : undefined;
  const message = [detail, body?.message].find(
    (text) => typeof text === "string" && text.trim(),
  );
  return new AiStudioApiError(message || `HTTP ${res.status}`, res.status, code);
}

function assertArrayField<T>(
  obj: unknown,
  field: string,
  endpoint: string,
): T[] {
  if (!obj || typeof obj !== "object") {
    throw new AiStudioApiError(
      `${endpoint} 返回格式异常（非对象）`,
      502,
      "invalid_response",
    );
  }
  const value = (obj as Record<string, unknown>)[field];
  if (!Array.isArray(value)) {
    throw new AiStudioApiError(
      `${endpoint} 响应缺少 ${field} 数组`,
      502,
      "invalid_response",
    );
  }
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AiStudioApiError(
        `${endpoint} 响应 ${field}[${i}] 项格式异常`,
        502,
        "invalid_response",
      );
    }
  }
  return value as T[];
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AISTUDIO_PREFIX}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...getConsoleHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// Auth
export function parseAuthMode(raw: string | null): AiStudioAuthMode | undefined {
  const val = raw?.trim().toLowerCase();
  if (val === "managed" || val === "manual") return val;
  return undefined;
}

export function assertValidAccounts(
  raw: unknown,
  endpoint = "/api/accounts",
): AiStudioAccount[] {
  if (!Array.isArray(raw)) {
    throw new AiStudioApiError(
      `${endpoint} 响应缺少 accounts 数组`,
      502,
      "invalid_response",
    );
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new AiStudioApiError(
        `${endpoint} 响应 accounts[${i}] 项格式异常`,
        502,
        "invalid_response",
      );
    }
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.state !== "string" ||
      (typeof rec.id !== "string" && typeof rec.email !== "string")
    ) {
      throw new AiStudioApiError(
        `${endpoint} 响应 accounts[${i}] 缺少必要字段 (state / id|email)`,
        502,
        "invalid_response",
      );
    }
  }
  return raw as AiStudioAccount[];
}

export async function fetchAuthSession(
  signal?: AbortSignal,
): Promise<AiStudioAuthSession> {
  const res = await fetch(`${AISTUDIO_PREFIX}/api/auth/session`, {
    method: "GET",
    signal,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...getConsoleHeaders(),
    },
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as AiStudioAuthSession;
  if (!body || typeof body !== "object" || typeof body.authenticated !== "boolean") {
    throw new AiStudioApiError(
      "/api/auth/session 返回格式异常",
      502,
      "invalid_response",
    );
  }
  const headerMode = parseAuthMode(res.headers.get("x-aistudio-auth-mode"));
  return {
    ...body,
    ...(headerMode ? { mode: headerMode } : {}),
  };
}

export async function loginAiStudio(
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<AiStudioAuthSession> {
  const res = await fetch(`${AISTUDIO_PREFIX}/api/auth/login`, {
    method: "POST",
    signal,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...getConsoleHeaders(),
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const body = (await res.json()) as AiStudioAuthSession;
  if (!body || typeof body !== "object" || typeof body.authenticated !== "boolean") {
    throw new AiStudioApiError(
      "/api/auth/login 返回格式异常",
      502,
      "invalid_response",
    );
  }
  const headerMode = parseAuthMode(res.headers.get("x-aistudio-auth-mode"));
  return {
    ...body,
    ...(headerMode ? { mode: headerMode } : {}),
  };
}

export function logoutAiStudio(): Promise<void> {
  return requestJson<void>("/api/auth/logout", { method: "POST" });
}

// Status & Control
export async function fetchStatus(
  signal?: AbortSignal,
): Promise<AiStudioStatus> {
  const res = await requestJson<AiStudioStatus>("/api/status", { signal });
  if (
    !res ||
    typeof res !== "object" ||
    typeof res.state !== "string" ||
    typeof res.running !== "boolean"
  ) {
    throw new AiStudioApiError(
      "/api/status 返回格式异常（缺少 state/running 字段）",
      502,
      "invalid_response",
    );
  }
  return res;
}

export function startService(): Promise<unknown> {
  return requestJson<unknown>("/api/control/start", { method: "POST" });
}

export function stopService(): Promise<unknown> {
  return requestJson<unknown>("/api/control/stop", { method: "POST" });
}

export async function fetchCooldowns(
  signal?: AbortSignal,
): Promise<AiStudioCooldown[]> {
  const res = await requestJson<{ cooldowns?: unknown }>("/api/cooldowns", {
    signal,
  });
  return assertArrayField<AiStudioCooldown>(
    res,
    "cooldowns",
    "/api/cooldowns",
  );
}

// Accounts & Tasks & Import
export async function fetchAccounts(
  signal?: AbortSignal,
): Promise<AiStudioAccount[]> {
  const res = await requestJson<{ accounts?: unknown }>("/api/accounts", {
    signal,
  });
  const list = assertArrayField<unknown>(res, "accounts", "/api/accounts");
  return assertValidAccounts(list, "/api/accounts");
}

export async function fetchAccountExits(
  signal?: AbortSignal,
): Promise<AiStudioAccountExit[]> {
  const res = await requestJson<{ exits?: unknown }>("/api/accounts/exits", {
    signal,
  });
  return assertArrayField<AiStudioAccountExit>(
    res,
    "exits",
    "/api/accounts/exits",
  );
}

export async function fetchAccountTasks(
  signal?: AbortSignal,
): Promise<AiStudioAccountTask[]> {
  const res = await requestJson<{ tasks?: unknown }>("/api/accounts/tasks", {
    signal,
  });
  return assertArrayField<AiStudioAccountTask>(
    res,
    "tasks",
    "/api/accounts/tasks",
  );
}

export function createAccountTask(payload: {
  label?: string;
  proxy?: string;
}): Promise<{ task?: AiStudioAccountTask; account?: AiStudioAccount }> {
  return requestJson<{ task?: AiStudioAccountTask; account?: AiStudioAccount }>(
    "/api/accounts",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function updateAccount(
  id: string,
  payload: Partial<Pick<AiStudioAccount, "label" | "proxy">>,
): Promise<unknown> {
  return requestJson<unknown>(`/api/accounts/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function setAccountState(
  id: string,
  state: "enabled" | "disabled",
): Promise<unknown> {
  return requestJson<unknown>(
    `/api/accounts/${encodeURIComponent(id)}/state`,
    {
      method: "PUT",
      body: JSON.stringify({ state }),
    },
  );
}

export function deleteAccount(id: string): Promise<unknown> {
  return requestJson<unknown>(`/api/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function reloginAccount(
  id: string,
  view?: string,
): Promise<{ task?: AiStudioAccountTask; account?: AiStudioAccount }> {
  return requestJson<{ task?: AiStudioAccountTask; account?: AiStudioAccount }>(
    `/api/accounts/${encodeURIComponent(id)}/login`,
    {
      method: "POST",
      body: JSON.stringify(view ? { view } : {}),
    },
  );
}

export function refreshAccount(id: string): Promise<unknown> {
  return requestJson<unknown>(
    `/api/accounts/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
  );
}

export function clearAccountCooldown(
  id: string,
  model: string,
): Promise<unknown> {
  return requestJson<unknown>(
    `/api/accounts/${encodeURIComponent(id)}/cooldowns/${encodeURIComponent(model)}`,
    { method: "DELETE" },
  );
}

export function deleteAccountTask(taskId: string): Promise<unknown> {
  return requestJson<unknown>(
    `/api/accounts/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE" },
  );
}

export async function discoverCookies(payload: {
  cookies: string;
  proxy?: string;
}): Promise<AiStudioDiscoveredCookieAccount[]> {
  const res = await requestJson<{ accounts?: unknown }>(
    "/api/accounts/import/cookies/discover",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return assertArrayField<AiStudioDiscoveredCookieAccount>(
    res,
    "accounts",
    "/api/accounts/import/cookies/discover",
  );
}

export function importCookies(
  payload: AiStudioImportCookiesPayload,
): Promise<{ task?: AiStudioAccountTask; account?: AiStudioAccount }> {
  return requestJson<{ task?: AiStudioAccountTask; account?: AiStudioAccount }>(
    "/api/accounts/import/cookies",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function fetchChromeProfiles(
  signal?: AbortSignal,
): Promise<AiStudioChromeProfile[]> {
  const res = await requestJson<{ profiles?: unknown }>(
    "/api/accounts/import/chrome",
    { signal },
  );
  return assertArrayField<AiStudioChromeProfile>(
    res,
    "profiles",
    "/api/accounts/import/chrome",
  );
}

export async function fetchImportBrowsers(
  signal?: AbortSignal,
): Promise<AiStudioBrowserInfo[]> {
  const res = await requestJson<{ browsers?: unknown }>(
    "/api/accounts/import/browsers",
    { signal },
  );
  return assertArrayField<AiStudioBrowserInfo>(
    res,
    "browsers",
    "/api/accounts/import/browsers",
  );
}

export function importChromeAccounts(
  payload: AiStudioImportChromePayload,
): Promise<{ task?: AiStudioAccountTask; account?: AiStudioAccount }> {
  return requestJson<{ task?: AiStudioAccountTask; account?: AiStudioAccount }>(
    "/api/accounts/import/chrome",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

// Models & Requests
export async function fetchModels(
  signal?: AbortSignal,
): Promise<AiStudioModel[]> {
  const res = await requestJson<{ models?: unknown }>("/api/models", {
    signal,
  });
  return assertArrayField<AiStudioModel>(res, "models", "/api/models");
}

export async function fetchRequests(
  signal?: AbortSignal,
): Promise<AiStudioActiveRequest[]> {
  const res = await requestJson<{ requests?: unknown }>("/api/requests", {
    signal,
  });
  return assertArrayField<AiStudioActiveRequest>(
    res,
    "requests",
    "/api/requests",
  );
}

export function cancelRequest(id: string): Promise<unknown> {
  return requestJson<unknown>(
    `/api/requests/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );
}

export function fetchRequestBody(id: string): Promise<unknown> {
  return requestJson<unknown>(
    `/api/requests/${encodeURIComponent(id)}/body`,
  );
}

export function clearLogs(): Promise<void> {
  return requestJson<void>("/api/logs", { method: "DELETE" });
}

// Usage
export function fetchUsage(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<AiStudioUsageSummary> {
  const qs = new URLSearchParams({ from, to }).toString();
  return requestJson<AiStudioUsageSummary>(`/api/usage?${qs}`, { signal });
}

export async function fetchUsagePairs(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<AiStudioUsagePair[]> {
  const qs = new URLSearchParams({ from, to }).toString();
  const res = await requestJson<{ pairs?: unknown }>(
    `/api/usage/pairs?${qs}`,
    { signal },
  );
  return assertArrayField<AiStudioUsagePair>(
    res,
    "pairs",
    "/api/usage/pairs",
  );
}

export async function fetchUsageRecords(
  from: string,
  to: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<AiStudioUsageRecord[]> {
  const qs = new URLSearchParams({
    from,
    to,
    limit: String(limit),
  }).toString();
  const res = await requestJson<{ items?: unknown }>(
    `/api/usage/records?${qs}`,
    { signal },
  );
  return assertArrayField<AiStudioUsageRecord>(
    res,
    "items",
    "/api/usage/records",
  );
}

export async function downloadUsageCsv(
  from: string,
  to: string,
): Promise<void> {
  const qs = new URLSearchParams({ from, to }).toString();
  const res = await fetch(`${AISTUDIO_PREFIX}/api/usage/records.csv?${qs}`, {
    method: "GET",
    credentials: "same-origin",
    headers: {
      ...getConsoleHeaders(),
      Accept: "text/csv, */*",
    },
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isCsvLike =
    contentType.includes("text/csv") ||
    contentType.includes("application/csv") ||
    contentType.includes("application/octet-stream");
  if (!isCsvLike) {
    const errText = (await res.text().catch(() => "")).trim();
    throw new AiStudioApiError(
      errText
        ? `CSV 导出响应异常 (${contentType || "unknown"}): ${errText.slice(0, 160)}`
        : `CSV 导出响应 Content-Type 异常: ${contentType || "unknown"}`,
      502,
      "invalid_response",
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "aistudio-usage-records.csv";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const READONLY_CONFIG_KEYS = new Set([
  "reserved_listen_addr",
  "management_restart_required",
  "service_restart_required",
  "admin_password_set",
  "proxy_pool",
  "environment",
  "invalid",
]);

export function buildSafeConfigPayload(
  base: AiStudioConfig,
  patch: AiStudioConfigPatch,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(base as unknown as Record<string, unknown>),
    ...(patch as unknown as Record<string, unknown>),
  };
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (key.startsWith("active_") || READONLY_CONFIG_KEYS.has(key)) continue;
    if (key === "admin_password" && typeof value === "string" && !value) {
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

// Config & Update
export function fetchConfig(signal?: AbortSignal): Promise<AiStudioConfig> {
  return requestJson<AiStudioConfig>("/api/config", { signal });
}

export async function saveConfig(
  patch: AiStudioConfigPatch,
  baseConfig?: AiStudioConfig | null,
): Promise<AiStudioConfig> {
  const base = baseConfig ?? (await fetchConfig());
  const payload = buildSafeConfigPayload(base, patch);
  return requestJson<AiStudioConfig>("/api/config", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function fetchUpdateInfo(
  refresh = false,
  signal?: AbortSignal,
): Promise<AiStudioUpdateInfo> {
  return requestJson<AiStudioUpdateInfo>(
    refresh ? "/api/update?refresh=1" : "/api/update",
    { signal },
  );
}

export function applyUpdate(): Promise<unknown> {
  return requestJson<unknown>("/api/update", { method: "POST" });
}
