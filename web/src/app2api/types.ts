// ============================================================================
// Gemini App (8049) Console Types
// ============================================================================

export type App2ApiAccountStatus =
  | 'ready'
  | 'active'
  | 'disabled'
  | 'auth_required'
  | 'terms_required'
  | 'restricted'
  | 'error'
  | string;

export interface App2ApiQuotaUsageRow {
  label?: string | null;
  providerPercent?: number | null;
  percentMeaning?: 'used' | 'remaining' | string | null;
  providerTimestamp?: string | number | null;
  timestampMeaning?: string | null;
  groupType?: number | null;
  [key: string]: unknown;
}

export interface App2ApiQuotaBudgetRow {
  label?: string | null;
  model?: string | null;
  remainingPercent?: number | null;
  available?: number | null;
  max?: number | null;
  used?: number | null;
  limit?: number | null;
  resetAt?: string | number | null;
  [key: string]: unknown;
}

export interface App2ApiQuotaInfo {
  source?: 'official' | 'unknown' | string | null;
  status?: 'ok' | 'unqueried' | 'missing' | 'error' | 'unknown' | string | null;
  updatedAt?: string | number | null;
  errorCode?: string | null;
  remainingPercent?: number | null;
  usageRows?: App2ApiQuotaUsageRow[] | null;
  budgets?: App2ApiQuotaBudgetRow[] | null;
  refills?: unknown[] | null;
  remaining?: number | null;
  limit?: number | null;
  percentage?: number | null;
  resetAt?: string | number | null;
  tier?: string | null;
  plan?: string | null;
  summary?: string | null;
  raw?: Record<string, unknown>;
}

export interface App2ApiSubscriptionInfo {
  source?: string;
  provider?: string | null;
  rpc?: string | null;
  status?: 'unqueried' | 'ok' | 'missing' | 'error' | string;
  tier?: string | null;
  nativeTier?: number | null;
  nativeTierName?: string | null;
  nativeState?: unknown;
  membershipStatus?: string | null;
  isForced?: boolean | null;
  updatedAt?: string | null;
  lastAttemptAt?: string | null;
  errorCode?: string | null;
  plan?: string | null;
}

export interface App2ApiAccountError {
  at?: number | string;
  status?: number;
  code?: string;
  model?: string;
  message?: string;
  nativeEvidence?: {
    upstreamMessage?: string | null;
    http2ResetCode?: number | null;
    streamCloseCode?: number | null;
    fallback?: number | null;
    downgradeReason?: number | null;
    [key: string]: unknown;
  } | null;
}

export interface App2ApiAccount {
  id: string;
  label?: string;
  email?: string;
  enabled: boolean;
  status?: App2ApiAccountStatus;
  authenticationStatus?: string;
  statusReason?: string;
  tier?: string;
  subscription?: App2ApiSubscriptionInfo | string | null;
  termsAccepted?: boolean;
  quota?: App2ApiQuotaInfo | null;
  quotaSummary?: string;
  quotaUpdatedAt?: string | number | null;
  modelTelemetry?: Record<string, App2ApiModelTelemetry> | null;
  lastTestedAt?: string | number | null;
  lastTestOk?: boolean | null;
  lastError?: App2ApiAccountError | string | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

export interface App2ApiLoginStartResponse {
  flowId: string;
  authorizationUrl?: string;
  authUrl?: string;
  url?: string;
  expiresAt?: string | number | null;
  acceptTerms?: boolean;
  status?: string;
}

export interface App2ApiLoginPollResponse {
  flowId: string;
  status?: 'pending' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired' | string;
  phase?: string;
  expiresAt?: string | number | null;
  errorCode?: string | null;
  error?: string | null;
  acceptTerms?: boolean;
  termsStatus?: string;
  termsEvidence?: unknown;
  account?: App2ApiAccount | null;
}

export interface App2ApiLoginFlow {
  flowId: string;
  authorizationUrl?: string;
  authUrl?: string;
  url?: string;
  status: 'pending' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired' | string;
  phase?: string;
  label?: string;
  acceptTerms?: boolean;
  termsStatus?: string;
  termsEvidence?: unknown;
  account?: App2ApiAccount | null;
  errorCode?: string | null;
  error?: string | null;
  expiresAt?: string | number | null;
}

export interface App2ApiLoginCallbackResponse {
  ok: boolean;
  flow: App2ApiLoginFlow;
}

export interface App2ApiChromeProfile {
  profileDir: string;
  name: string;
  email: string;
  alreadyAdded: boolean;
}

export interface App2ApiChromeProfilesResponse {
  chromeFound: boolean;
  chromePath?: string | null;
  profiles: App2ApiChromeProfile[];
}

export interface App2ApiChromeOAuthResultItem {
  profileDir: string;
  email?: string;
  status: string;
  accountId?: string;
  error?: string;
}

export interface App2ApiChromeOAuthResponse {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  results: App2ApiChromeOAuthResultItem[];
}

export interface App2ApiImportTokenResultItem {
  index: number;
  label?: string;
  email?: string;
  status: string;
  accountId?: string;
  error?: string;
}

export interface App2ApiImportTokensResponse {
  total: number;
  added: number;
  updated: number;
  failed: number;
  results: App2ApiImportTokenResultItem[];
}

export interface App2ApiExportAccountItem {
  id: string;
  label?: string;
  googleSubject?: string;
  enabled: boolean;
  refreshToken: string;
}

export interface App2ApiExportAccountsResponse {
  exportedAt: string;
  format: string;
  accounts: App2ApiExportAccountItem[];
}

export interface App2ApiQuotaRefreshJob {
  id: string;
  jobId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  trigger?: string;
  total?: number;
  completed?: number;
  updated?: number;
  failed?: number;
  missing?: number;
  skipped?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  reason?: string | null;
  reused?: boolean;
  error?: string | null;
}

export interface App2ApiKey {
  id: string;
  label: string;
  prefix?: string;
  maskedKey?: string;
  key?: string;
  token?: string;
  createdAt?: string | number | null;
  lastUsedAt?: string | number | null;
  requestCount?: number;
}

export interface App2ApiModelItem {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  contextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  protocols?: string[];
  aliases?: string[];
}

export interface App2ApiModelTelemetry {
  model?: string;
  requests?: number;
  successes?: number;
  failures?: number;
  inFlight?: number;
  outputBytes?: number;
  retries?: number;
  softErrors?: number;
  quotaErrors?: number;
  errorCounts?: Record<string, number>;
  avgLatencyMs?: number;
  lastUsedAt?: string | number | null;
}

export interface App2ApiModelTelemetrySnapshot {
  zeroPromptLogging?: boolean;
  models?: string[];
  byModel?: Record<string, App2ApiModelTelemetry>;
}

export interface App2ApiRequestAttempt {
  index: number;
  accountId: string | null;
  accountLabel: string | null;
  startedAt: number;
  durationMs: number | null;
  firstEventMs: number | null;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  httpStatus: number | null;
  reasonCode: string | null;
  reasonText: string | null;
  rawError: string | null;
  requestedModel: string;
  actualModel: string | null;
  failoverReason: string | null;
}

export interface App2ApiRequestRecord {
  id: string;
  requestId?: string;
  at?: number;
  timestamp?: number | string;
  startedAt?: number;
  createdAt?: string | number;
  protocol?: string;
  method?: string;
  path?: string;
  model?: string;
  accountId?: string | null;
  accountLabel?: string | null;
  status?: number;
  ok?: boolean;
  state?: 'running' | 'completed' | 'failed' | 'cancelled';
  stream?: boolean;
  durationMs?: number;
  firstEventMs?: number | null;
  switchCount?: number;
  providerAttempts?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  cacheHit?: boolean;
  toolCalls?: number;
  continued?: boolean;
  sessionSource?: string;
  promptBytes?: number;
  inputMessages?: number;
  declaredTools?: number;
  errorCode?: string | null;
  error?: string | null;
  outputIncomplete?: boolean;
  nativeResponseRevisions?: number;
  nativeEvidence?: unknown;
  providerFailures?: Array<{
    accountId?: string | null;
    status?: number;
    code?: string;
    nativeEvidence?: unknown;
  }>;
  attempts?: App2ApiRequestAttempt[];
}

export interface App2ApiFailoverRecord {
  id?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  fromAccountId?: string;
  toAccountId?: string;
  model?: string;
  reason?: string;
  status?: number | string;
}

export interface App2ApiAuditRecord {
  id?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  action?: string;
  actor?: string;
  target?: string;
  detail?: string;
  ok?: boolean;
}

export interface App2ApiSettings {
  host: string;
  port: number;
  timeoutMs: number;
  maxConcurrent: number;
  maxBodyBytes: number;
  maxPromptBytes: number;
  continuation: boolean;
  allowRemoteImages: boolean;
  sessionTtlMs: number;
  maxSessions: number;
}

export interface App2ApiMetrics {
  totalRequests?: number;
  successRequests?: number;
  failedRequests?: number;
  activeRequests?: number;
  avgLatencyMs?: number;
  [key: string]: unknown;
}

export interface App2ApiOverview {
  version?: string;
  mode?: string;
  toolProtocol?: string;
  ready?: boolean;
  uptimeSeconds?: number;
  metrics?: App2ApiMetrics;
  accounts?: App2ApiAccount[];
  sessions?: unknown[];
  failovers?: App2ApiFailoverRecord[];
  requests?: App2ApiRequestRecord[];
  audit?: App2ApiAuditRecord[];
  models?: Array<string | App2ApiModelItem>;
  modelTelemetry?:
    | App2ApiModelTelemetrySnapshot
    | App2ApiModelTelemetry[]
    | Record<string, App2ApiModelTelemetry>;
  settings?: App2ApiSettings;
  keyCount?: number;
}
