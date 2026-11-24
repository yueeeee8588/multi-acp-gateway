import type {
  App2ApiAccount,
  App2ApiChromeOAuthResponse,
  App2ApiChromeProfilesResponse,
  App2ApiExportAccountsResponse,
  App2ApiImportTokensResponse,
  App2ApiKey,
  App2ApiLoginCallbackResponse,
  App2ApiLoginFlow,
  App2ApiLoginPollResponse,
  App2ApiLoginStartResponse,
  App2ApiOverview,
  App2ApiQuotaRefreshJob,
  App2ApiSettings,
} from './types';

const APP2API_PREFIX = '/app2api-api';

export class App2ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'App2ApiError';
    this.status = status;
  }
}

function getConsoleHeaders(): Record<string, string> {
  return {
    'X-Console-Path': window.location.pathname,
  };
}

function withPrefix(path: string): string {
  return `${APP2API_PREFIX}${path}`;
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
    if (
      res.status === 401 &&
      res.headers.get('x-zako-auth-error') === 'session_expired'
    ) {
      window.dispatchEvent(new Event('session-expired'));
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string } | string;
      message?: string;
    } | null;
    const detail =
      typeof body?.error === 'string' ? body.error : body?.error?.message;
    const message = [detail, body?.message].find(
      (text) => typeof text === 'string' && text.trim()
    );
    throw new App2ApiError(message || `HTTP ${res.status}`, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function unwrapList<T>(res: T[] | Record<string, unknown>, keys: string[]): T[] {
  if (Array.isArray(res)) return res;
  for (const key of keys) {
    const val = res?.[key];
    if (Array.isArray(val)) return val as T[];
  }
  return [];
}

// ============================================================================
// Overview
// ============================================================================

export function fetchOverview(): Promise<App2ApiOverview> {
  return requestJson<App2ApiOverview>('/admin/api/overview');
}

// ============================================================================
// Accounts & OAuth & Quota
// ============================================================================

export async function fetchAccounts(): Promise<App2ApiAccount[]> {
  const res = await requestJson<App2ApiAccount[] | { accounts?: App2ApiAccount[] }>(
    '/admin/api/accounts'
  );
  return unwrapList<App2ApiAccount>(res, ['accounts', 'items', 'data']);
}

export async function startAccountLogin(payload: {
  label?: string;
  acceptTerms?: boolean;
}): Promise<App2ApiLoginFlow> {
  const res = await requestJson<App2ApiLoginStartResponse>(
    '/admin/api/accounts/login',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  const authorizationUrl = res.authorizationUrl ?? res.authUrl ?? res.url;
  return {
    ...res,
    authorizationUrl,
    status: res.status || 'pending',
  };
}

export async function pollAccountLogin(
  flowId: string
): Promise<App2ApiLoginPollResponse> {
  const res = await requestJson<App2ApiLoginPollResponse>(
    `/admin/api/accounts/login/${encodeURIComponent(flowId)}`
  );
  return {
    ...res,
    status: res.status || 'pending',
  };
}

export function cancelAccountLogin(flowId: string): Promise<{ ok?: boolean }> {
  return requestJson<{ ok?: boolean }>(
    `/admin/api/accounts/login/${encodeURIComponent(flowId)}`,
    {
      method: 'DELETE',
    }
  );
}

export function submitLoginCallback(
  flowId: string,
  callbackUrl: string
): Promise<App2ApiLoginCallbackResponse> {
  return requestJson<App2ApiLoginCallbackResponse>(
    `/admin/api/accounts/login/${encodeURIComponent(flowId)}/callback`,
    {
      method: 'POST',
      body: JSON.stringify({ callbackUrl }),
    }
  );
}

export function scanChromeProfiles(): Promise<App2ApiChromeProfilesResponse> {
  return requestJson<App2ApiChromeProfilesResponse>(
    '/admin/api/accounts/chrome-profiles'
  );
}

export function authorizeChromeProfiles(
  profiles: Array<{ profileDir: string; email?: string }>,
  acceptTerms?: boolean
): Promise<App2ApiChromeOAuthResponse> {
  return requestJson<App2ApiChromeOAuthResponse>(
    '/admin/api/accounts/chrome-oauth',
    {
      method: 'POST',
      body: JSON.stringify({ profiles, acceptTerms }),
    }
  );
}

export function importAccountTokens(
  tokens: string,
  acceptTerms?: boolean
): Promise<App2ApiImportTokensResponse> {
  return requestJson<App2ApiImportTokensResponse>(
    '/admin/api/accounts/import-tokens',
    {
      method: 'POST',
      body: JSON.stringify({ tokens, acceptTerms }),
    }
  );
}

export function exportAccounts(): Promise<App2ApiExportAccountsResponse> {
  return requestJson<App2ApiExportAccountsResponse>(
    '/admin/api/accounts/export'
  );
}

export function acceptAccountTerms(id: string): Promise<{ ok?: boolean; account?: App2ApiAccount }> {
  return requestJson<{ ok?: boolean; account?: App2ApiAccount }>(
    `/admin/api/accounts/${encodeURIComponent(id)}/terms/accept`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    }
  );
}

export function testAccount(
  id: string,
  model: string
): Promise<{ ok?: boolean; latencyMs?: number; message?: string; error?: string }> {
  return requestJson<{ ok?: boolean; latencyMs?: number; message?: string; error?: string }>(
    `/admin/api/accounts/${encodeURIComponent(id)}/test`,
    {
      method: 'POST',
      body: JSON.stringify({ model }),
    }
  );
}

export function fetchAccountQuota(
  id: string
): Promise<{ ok?: boolean; account?: App2ApiAccount; quota?: unknown }> {
  return requestJson<{ ok?: boolean; account?: App2ApiAccount; quota?: unknown }>(
    `/admin/api/accounts/${encodeURIComponent(id)}/quota`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

function unwrapQuotaJob(
  res: App2ApiQuotaRefreshJob | { job: App2ApiQuotaRefreshJob; reused?: boolean }
): App2ApiQuotaRefreshJob {
  if (res && typeof res === 'object' && 'job' in res && res.job) {
    return {
      ...res.job,
      reused: res.reused,
    };
  }
  return res as App2ApiQuotaRefreshJob;
}

export async function startQuotaRefreshAll(): Promise<App2ApiQuotaRefreshJob> {
  const res = await requestJson<
    App2ApiQuotaRefreshJob | { job: App2ApiQuotaRefreshJob; reused?: boolean }
  >('/admin/api/accounts/quota-refresh', {
    method: 'POST',
    body: JSON.stringify({ trigger: 'manual' }),
  });
  return unwrapQuotaJob(res);
}

export async function pollQuotaRefreshJob(
  jobId: string
): Promise<App2ApiQuotaRefreshJob> {
  const res = await requestJson<
    App2ApiQuotaRefreshJob | { job: App2ApiQuotaRefreshJob }
  >(`/admin/api/accounts/quota-refresh/${encodeURIComponent(jobId)}`);
  return unwrapQuotaJob(res);
}

export function updateAccount(
  id: string,
  payload: { enabled?: boolean; label?: string }
): Promise<App2ApiAccount> {
  return requestJson<App2ApiAccount>(
    `/admin/api/accounts/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
}

export function deleteAccount(id: string): Promise<{ ok?: boolean }> {
  return requestJson<{ ok?: boolean }>(
    `/admin/api/accounts/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    }
  );
}

// ============================================================================
// API Keys
// ============================================================================

export async function fetchKeys(): Promise<App2ApiKey[]> {
  const res = await requestJson<App2ApiKey[] | { keys?: App2ApiKey[] }>(
    '/admin/api/keys'
  );
  return unwrapList<App2ApiKey>(res, ['keys', 'items', 'data']);
}

export function createKey(label: string): Promise<App2ApiKey & { key?: string; token?: string }> {
  return requestJson<App2ApiKey & { key?: string; token?: string }>(
    '/admin/api/keys',
    {
      method: 'POST',
      body: JSON.stringify({ label }),
    }
  );
}

export function revealKey(
  id: string
): Promise<{ key?: string; token?: string; secret?: string }> {
  return requestJson<{ key?: string; token?: string; secret?: string }>(
    `/admin/api/keys/${encodeURIComponent(id)}/reveal`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

export function deleteKey(id: string): Promise<{ ok?: boolean }> {
  return requestJson<{ ok?: boolean }>(
    `/admin/api/keys/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    }
  );
}

// ============================================================================
// Settings
// ============================================================================

export async function fetchSettings(): Promise<App2ApiSettings> {
  const res = await requestJson<App2ApiSettings | { settings: App2ApiSettings }>(
    '/admin/api/settings'
  );
  if (res && typeof res === 'object' && 'settings' in res && res.settings) {
    return res.settings;
  }
  return res as App2ApiSettings;
}

export async function updateSettings(
  payload: Partial<App2ApiSettings>
): Promise<App2ApiSettings> {
  const res = await requestJson<App2ApiSettings | { settings: App2ApiSettings }>(
    '/admin/api/settings',
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
  if (res && typeof res === 'object' && 'settings' in res && res.settings) {
    return res.settings;
  }
  return res as App2ApiSettings;
}
