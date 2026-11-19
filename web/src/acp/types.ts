// ============================================================================
// Gemini /v1beta Native Types
// ============================================================================

export interface GeminiInlineData {
  mimeType: string;
  data: string;
}

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: GeminiInlineData;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

export interface GeminiContent {
  role?: 'user' | 'model' | 'system' | string;
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  [key: string]: unknown;
}

export interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent | { parts: GeminiPart[] };
  tools?: GeminiTool[];
  toolConfig?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  safetySettings?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
  safetyRatings?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  [key: string]: unknown;
}

export interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
  [key: string]: unknown;
}

// ============================================================================
// Account & Risk Control Types
// ============================================================================

export type AccountStatus = 'ready' | 'disabled' | 'auth_required' | 'restricted';
export type AccountTier = 'pro' | 'standard';

export type QuotaPoolKey = 'gemini_flagship' | 'gemini_flash' | 'third_party';

export interface PoolModelQuota {
  id: string;
  displayName: string;
  percentage: number;
  remainingFraction: number;
  resetTime: string | null;
}

export interface PoolQuotaSummary {
  pool: QuotaPoolKey;
  label: string;
  percentage: number;
  remainingFraction: number;
  resetTime: string | null;
  modelCount: number;
  bottleneckModel: string | null;
  window5h: number | null;
  windowWeekly: number | null;
  window5hResetTime?: string | null;
  windowWeeklyResetTime?: string | null;
  models: PoolModelQuota[];
}

export interface AccountQuotaSnapshot {
  fetchedAt: number;
  projectId?: string;
  pools: Record<QuotaPoolKey, PoolQuotaSummary | null>;
  /** 最近一次刷新失败时，pools 仍可能保留上次采集的数据。 */
  error?: string;
}

export interface AccountRecord {
  id: string;
  label: string;
  email: string;
  source: string;
  homeDir: string;
  proxyUrl: string;
  status: AccountStatus;
  tier?: AccountTier;
  statusReason: string;
  exitIp: string;
  exitCountry: string;
  concurrencyLimit: number;
  activeWorkers: number;
  lastVerifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
  quota?: AccountQuotaSnapshot | null;
}

export interface RefreshAllAccountQuotasResult {
  refreshed: number;
  failed: number;
  accounts: AccountRecord[];
}

export interface ExitGroup {
  ip: string;
  country: string;
  accountIds: string[];
  count: number;
  sharedWarning: boolean;
}

export interface ChromeProfile {
  profileDir: string;
  name: string;
  email: string;
  gaiaName?: string;
  alreadyAdded: boolean;
}

export interface ChromeProfilesResult {
  chromeAvailable: boolean;
  chromePath: string;
  profiles: ChromeProfile[];
}

export interface ChromeOAuthResult {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: Array<{ email?: string; profileDir: string; error: string }>;
}

export interface ImportTokenItemResult {
  index: number;
  email: string;
  id: string;
  action: 'imported' | 'updated' | 'failed';
  ok: boolean;
  error?: string;
}

export interface ImportRefreshTokensResult {
  imported: number;
  updated: number;
  failed: number;
  results: ImportTokenItemResult[];
}

export interface DetectTierDetail {
  id: string;
  label: string;
  email: string;
  ok: boolean;
  tier: AccountTier | null;
  reason?: string;
}

export interface DetectAllTiersResult {
  total: number;
  updated: number;
  pro: number;
  standard: number;
  failed: number;
  details: DetectTierDetail[];
}

// ============================================================================
// Cooldown & Scheduling Types
// ============================================================================

export interface CooldownRecord {
  accountId: string;
  family: string;
  scopeType: string;
  reason: string;
  untilMs: number;
  consecutiveFailures: number;
  lastError: string;
}

export type RoutingStrategy =
  | 'sticky-round-robin'
  | 'fill-first'
  | 'cache-first'
  | 'performance-first';

export type AcpSensitiveWordScope = 'all' | 'system' | 'messages' | 'tools';

export interface AcpSensitiveWordRule {
  pattern: string;
  replace: string;
  case_insensitive: boolean;
  enabled: boolean;
  scope?: AcpSensitiveWordScope;
}

export interface GatewayConfig {
  port: number;
  host: string;
  agyPath: string;
  apiKey: string;
  defaultProxy: string;
  routingStrategy: RoutingStrategy;
  perAccountConcurrency: number;
  maxAccountSwitches: number;
  queueWaitTimeoutMs: number;
  cacheSettlingDelayMs: number;
  softErrorCutoffMs: number;
  cooldownStepsMinutes: number[];
  maxImagesPerRequest: number;
  maxLogsRetained: number;
  sensitiveFilterEnabled?: boolean;
  sensitiveWords?: AcpSensitiveWordRule[];
}

// ============================================================================
// Request Logs & SSE Event Types
// ============================================================================

export interface PhaseTimingsMs {
  queue?: number;
  workerAcquire?: number;
  mcpSetup?: number;
  spawnMs?: number;
  initializeMs?: number;
  sessionSetupMs?: number;
  setModelMs?: number;
  promptToFirstEventMs?: number;
  firstEvent?: number;
  total?: number;
  coldStart?: boolean;
  sessionResumed?: boolean;
}

export interface RequestAttempt {
  index: number;
  accountId: string;
  accountLabel: string;
  requestedModel?: string;
  confirmedModel?: string;
  modelSelectionAcknowledged?: boolean;
  outcome: 'success' | 'failed' | 'cancelled';
  upstreamStatus?: number;
  reasonCode?: string;
  reasonText?: string;
  rawError?: string;
  phaseTimingsMs: PhaseTimingsMs;
}

export type RequestLogState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RequestLog {
  id: string;
  model: string;
  family: string;
  endpoint: string;
  stream: boolean;
  state: RequestLogState;
  cacheHit?: boolean;
  cachedTokens?: number;
  httpStatus?: number;
  startedAt: number;
  durationMs?: number;
  switchCount: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts: RequestAttempt[];
}

export type SseEventType =
  | 'status'
  | 'accounts'
  | 'cooldowns'
  | 'requests'
  | 'request:start'
  | 'request:attempt'
  | 'request:finish'
  | 'config'
  | 'ping';

export interface SseEventPayload<T = unknown> {
  type: SseEventType;
  data: T;
  timestamp: number;
}

export interface GatewayMetrics {
  totalRequests?: number;
  successRequests?: number;
  failedRequests?: number;
  activeRequests?: number;
  avgFirstEventMs?: number;
  avgTotalMs?: number;
  [key: string]: unknown;
}

export interface GatewayStatusPayload {
  ok?: boolean;
  uptimeMs?: number;
  accounts?: number;
  readyAccounts?: number;
  activeRequests?: number;
  [key: string]: unknown;
}

export interface GeminiModelItem {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  [key: string]: unknown;
}

export interface GeminiModelsResponse {
  models?: GeminiModelItem[];
}
