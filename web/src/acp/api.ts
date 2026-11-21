import type {
  AccountRecord,
  AccountTier,
  ChromeOAuthResult,
  ChromeProfile,
  ChromeProfilesResult,
  CooldownRecord,
  DetectAllTiersResult,
  DetectTierDetail,
  ExitGroup,
  GatewayConfig,
  GatewayMetrics,
  GatewayStatusPayload,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  GeminiModelItem,
  GeminiModelsResponse,
  ImportRefreshTokensResult,
  ImportTokenItemResult,
  RefreshAllAccountQuotasResult,
  RequestAttempt,
  RequestLog,
  SseEventPayload,
  SseEventType,
} from './types';

export type {
  ChromeProfile,
  ChromeProfilesResult,
  ChromeOAuthResult,
  ImportTokenItemResult,
  ImportRefreshTokensResult,
  DetectTierDetail,
  DetectAllTiersResult,
};

const ACP_API_PREFIX = '/acp-api';

export class AcpApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AcpApiError';
    this.status = status;
  }
}

function getConsoleHeaders(): Record<string, string> {
  return {
    'X-Console-Path': window.location.pathname,
  };
}

function withPrefix(path: string): string {
  return `${ACP_API_PREFIX}${path}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withPrefix(path), {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...getConsoleHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event('session-expired'));
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string } | string;
      message?: string;
    } | null;
    const detail = typeof body?.error === 'string' ? body.error : body?.error?.message;
    const message = [detail, body?.message].find((text) => typeof text === 'string' && text.trim());
    throw new AcpApiError(message || `HTTP ${res.status}`, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ============================================================================
// Accounts & Exits
// ============================================================================

export function fetchAccounts(): Promise<AccountRecord[]> {
  return requestJson<AccountRecord[]>('/api/accounts');
}

export function createAccount(payload: {
  label: string;
  email?: string;
  proxyUrl?: string;
  concurrencyLimit?: number;
  homeDir?: string;
  tier?: AccountTier;
}): Promise<AccountRecord> {
  return requestJson<AccountRecord>('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateAccount(
  id: string,
  payload: Partial<
    Pick<
      AccountRecord,
      'label' | 'email' | 'proxyUrl' | 'status' | 'concurrencyLimit' | 'tier'
    >
  >
): Promise<AccountRecord> {
  return requestJson<AccountRecord>(
    `/api/accounts/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
}

export function deleteAccount(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/accounts/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    }
  );
}

export function importLocalAccounts(): Promise<{
  imported: number;
  accounts: AccountRecord[];
}> {
  return requestJson<{ imported: number; accounts: AccountRecord[] }>(
    '/api/accounts/import-local',
    {
      method: 'POST',
    }
  );
}

export function fetchChromeProfiles(): Promise<ChromeProfilesResult> {
  return requestJson<ChromeProfilesResult>('/api/accounts/chrome-profiles');
}

export function startChromeOAuth(
  profiles: Array<{ profileDir: string; email?: string }>
): Promise<ChromeOAuthResult> {
  return requestJson<ChromeOAuthResult>('/api/accounts/chrome-oauth', {
    method: 'POST',
    body: JSON.stringify({ profiles }),
  });
}

export function importRefreshTokens(
  tokens: string,
  proxyUrl?: string
): Promise<ImportRefreshTokensResult> {
  return requestJson<ImportRefreshTokensResult>(
    '/api/accounts/import-tokens',
    {
      method: 'POST',
      body: JSON.stringify({ tokens, proxyUrl }),
    }
  );
}

/** 调用后端真实 loadCodeAssist 探测，批量识别各账号等级 */
export function detectAccountTiers(): Promise<DetectAllTiersResult> {
  return requestJson<DetectAllTiersResult>('/api/accounts/detect-tiers', {
    method: 'POST',
  });
}

export interface OpenAccountUrlResult {
  ok: boolean;
  launched: boolean;
  reason?: 'chrome_not_found' | 'profile_not_found';
  profileDir?: string;
  profileName?: string;
  email?: string;
  url?: string;
}

export function openAccountUrlInChrome(
  id: string,
  url: string
): Promise<OpenAccountUrlResult> {
  return requestJson<OpenAccountUrlResult>(
    `/api/accounts/${encodeURIComponent(id)}/open-url`,
    {
      method: 'POST',
      body: JSON.stringify({ url }),
    }
  );
}

export function loginAccount(
  id: string
): Promise<{ ok: boolean; message?: string; account?: AccountRecord }> {
  return requestJson<{
    ok: boolean;
    message?: string;
    account?: AccountRecord;
  }>(`/api/accounts/${encodeURIComponent(id)}/login`, { method: 'POST' });
}

const REFRESH_ACCOUNT_TIMEOUT_MS = 70_000;

export async function refreshAccount(id: string): Promise<AccountRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REFRESH_ACCOUNT_TIMEOUT_MS);
  try {
    return await requestJson<AccountRecord>(
      `/api/accounts/${encodeURIComponent(id)}/refresh`,
      {
        method: 'POST',
        signal: controller.signal,
      }
    );
  } catch (err) {
    if (
      (err instanceof Error || err instanceof DOMException) &&
      err.name === 'AbortError'
    ) {
      throw new AcpApiError('刷新超时（70s）', 408);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function refreshAccountQuota(id: string): Promise<AccountRecord> {
  return requestJson<AccountRecord>(
    `/api/accounts/${encodeURIComponent(id)}/quota`,
    {
      method: 'POST',
    }
  );
}

export function refreshAllAccountQuotas(): Promise<RefreshAllAccountQuotasResult> {
  return requestJson<RefreshAllAccountQuotasResult>('/api/accounts/quota/refresh-all', {
    method: 'POST',
  });
}

export function fetchAccountExits(): Promise<ExitGroup[]> {
  return requestJson<ExitGroup[]>('/api/accounts/exits');
}

// ============================================================================
// Cooldowns
// ============================================================================

export function fetchCooldowns(): Promise<CooldownRecord[]> {
  return requestJson<CooldownRecord[]>('/api/cooldowns');
}

export function clearAccountCooldown(
  accountId: string,
  scope: string
): Promise<{ ok: boolean; deleted?: boolean }> {
  return requestJson<{ ok: boolean; deleted?: boolean }>(
    `/api/accounts/${encodeURIComponent(accountId)}/cooldowns/${encodeURIComponent(scope)}`,
    { method: 'DELETE' }
  );
}

// ============================================================================
// Requests & Metrics
// ============================================================================

export function fetchRequests(): Promise<RequestLog[]> {
  return requestJson<RequestLog[]>('/api/requests');
}

export function cancelRequest(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/requests/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
    }
  );
}

export function fetchMetrics(): Promise<GatewayMetrics> {
  return requestJson<GatewayMetrics>('/api/metrics');
}

// ============================================================================
// Config
// ============================================================================

export function fetchConfig(): Promise<GatewayConfig> {
  return requestJson<GatewayConfig>('/api/config');
}

export function updateConfig(
  payload: Partial<GatewayConfig>
): Promise<GatewayConfig> {
  return requestJson<GatewayConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

// ============================================================================
// Fetch-based SSE /acp-api/api/events (with X-Console-Path & backoff)
// ============================================================================

export interface SseHandlers {
  onStatus?: (data: GatewayStatusPayload, ts: number) => void;
  onAccounts?: (data: AccountRecord[], ts: number) => void;
  onCooldowns?: (data: CooldownRecord[], ts: number) => void;
  onRequests?: (data: RequestLog[], ts: number) => void;
  onRequestStart?: (data: RequestLog, ts: number) => void;
  onRequestAttempt?: (
    data: { requestId: string; attempt: RequestAttempt } | RequestLog,
    ts: number
  ) => void;
  onRequestFinish?: (data: RequestLog, ts: number) => void;
  onConfig?: (data: GatewayConfig, ts: number) => void;
  onPing?: (ts: number) => void;
  onOpen?: () => void;
  onError?: () => void;
}

const SSE_MIN_BACKOFF_MS = 2000;
const SSE_MAX_BACKOFF_MS = 5000;

function dispatchSseEvent(
  eventName: string,
  rawData: string,
  handlers: SseHandlers
): void {
  const event = eventName as SseEventType;
  if (event === 'ping') {
    try {
      const parsed = JSON.parse(rawData) as SseEventPayload<unknown>;
      handlers.onPing?.(parsed.timestamp);
    } catch {
      handlers.onPing?.(Date.now());
    }
    return;
  }

  let parsed: SseEventPayload<unknown>;
  try {
    parsed = JSON.parse(rawData) as SseEventPayload<unknown>;
  } catch {
    return;
  }

  switch (event) {
    case 'status':
      handlers.onStatus?.(
        parsed.data as GatewayStatusPayload,
        parsed.timestamp
      );
      break;
    case 'accounts':
      handlers.onAccounts?.(parsed.data as AccountRecord[], parsed.timestamp);
      break;
    case 'cooldowns':
      handlers.onCooldowns?.(parsed.data as CooldownRecord[], parsed.timestamp);
      break;
    case 'requests':
      handlers.onRequests?.(parsed.data as RequestLog[], parsed.timestamp);
      break;
    case 'request:start':
      handlers.onRequestStart?.(parsed.data as RequestLog, parsed.timestamp);
      break;
    case 'request:attempt':
      handlers.onRequestAttempt?.(
        parsed.data as
          | { requestId: string; attempt: RequestAttempt }
          | RequestLog,
        parsed.timestamp
      );
      break;
    case 'request:finish':
      handlers.onRequestFinish?.(parsed.data as RequestLog, parsed.timestamp);
      break;
    case 'config':
      handlers.onConfig?.(parsed.data as GatewayConfig, parsed.timestamp);
      break;
    default:
      break;
  }
}

export function connectGatewayEvents(handlers: SseHandlers): () => void {
  let closed = false;
  let activeController: AbortController | null = null;
  let reconnectTimer: number | null = null;
  let retryAttempt = 0;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearReconnectTimer();
    const delay = Math.min(
      SSE_MAX_BACKOFF_MS,
      Math.round(SSE_MIN_BACKOFF_MS * Math.pow(1.5, retryAttempt))
    );
    retryAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    try {
      const res = await fetch(withPrefix('/api/events'), {
        method: 'GET',
        headers: {
          ...getConsoleHeaders(),
          Accept: 'text/event-stream',
        },
        credentials: 'same-origin',
        signal: controller.signal,
      });

      if (res.status === 401) {
        window.dispatchEvent(new Event('session-expired'));
      }

      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      retryAttempt = 0;
      handlers.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines: string[] = [];

      const flushEvent = () => {
        if (dataLines.length > 0) {
          dispatchSseEvent(eventName, dataLines.join('\n'), handlers);
        }
        eventName = 'message';
        dataLines = [];
      };

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          flushEvent();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            flushEvent();
            continue;
          }
          if (line.startsWith(':')) {
            continue;
          }
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() || 'message';
          } else if (line.startsWith('data:')) {
            const val = line.slice(5);
            dataLines.push(val.startsWith(' ') ? val.slice(1) : val);
          }
        }
      }

      if (!closed) {
        handlers.onError?.();
        scheduleReconnect();
      }
    } catch {
      if (closed || controller.signal.aborted) {
        return;
      }
      handlers.onError?.();
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    closed = true;
    clearReconnectTimer();
    activeController?.abort();
    activeController = null;
  };
}

// ============================================================================
// Native Gemini /v1beta Playground Helpers
// ============================================================================

export function updateModelLimits(
  modelId: string,
  body: { inputTokenLimit: number | null; outputTokenLimit: number | null }
): Promise<{
  ok: true;
  model: string;
  limits: { inputTokenLimit?: number; outputTokenLimit?: number } | null;
}> {
  return requestJson(`/api/models/${encodeURIComponent(modelId)}/limits`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function fetchAcpModelCatalog(options?: {
  refresh?: boolean;
}): Promise<GeminiModelItem[]> {
  const path = options?.refresh
    ? '/api/models/catalog?refresh=1'
    : '/api/models/catalog';
  const res = await requestJson<GeminiModelsResponse>(path);
  return Array.isArray(res.models) ? res.models : [];
}

export async function callGeminiGenerate(
  model: string,
  body: GeminiGenerateRequest,
  apiKey?: string
): Promise<GeminiGenerateResponse> {
  const headers: Record<string, string> = {};
  if (apiKey?.trim()) {
    headers['x-goog-api-key'] = apiKey.trim();
  }
  return requestJson<GeminiGenerateResponse>(
    `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  );
}

export async function streamGeminiGenerate(
  model: string,
  body: GeminiGenerateRequest,
  apiKey: string | undefined,
  onChunk: (chunk: GeminiGenerateResponse) => void,
  signal?: AbortSignal
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getConsoleHeaders(),
  };
  if (apiKey?.trim()) {
    headers['x-goog-api-key'] = apiKey.trim();
  }

  const res = await fetch(
    withPrefix(
      `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    ),
    {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(body),
      signal,
    }
  );

  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event('session-expired'));
    }
    const text = await res.text().catch(() => '');
    throw new AcpApiError(text || `HTTP ${res.status}`, res.status);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('ReadableStream not supported');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw) as GeminiGenerateResponse;
        onChunk(parsed);
      } catch {
        // ignore partial chunk
      }
    }
  }
}
