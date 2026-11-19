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
  cachedContentTokenCount?: number;
  cacheCreationTokenCount?: number;
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
  /** 有池数据时，记录这些额度的采集时间。 */
  fetchedAt: number;
  projectId?: string;
  pools: Record<QuotaPoolKey, PoolQuotaSummary | null>;
  /** 最近一次失败。已采集的池数据可能仍保留在快照中。 */
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
  tier: AccountTier;
  statusReason: string;
  exitIp: string;
  exitCountry: string;
  concurrencyLimit: number;
  activeWorkers: number;
  lastVerifiedAt: number | null;
  quota?: AccountQuotaSnapshot | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExitGroup {
  ip: string;
  country: string;
  accountIds: string[];
  count: number;
  sharedWarning: boolean;
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

export type RoutingStrategy = 'sticky-round-robin' | 'fill-first' | 'cache-first' | 'performance-first';

export type SensitiveWordScope = 'all' | 'system' | 'messages' | 'tools';

export interface SensitiveWordRule {
  pattern: string;
  replace: string;
  case_insensitive: boolean;
  enabled: boolean;
  scope?: SensitiveWordScope;
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
  softErrorCutoffMs: number;
  cooldownStepsMinutes: number[];
  maxImagesPerRequest: number;
  maxLogsRetained: number;
  streamThoughtImmediately?: boolean;
  /**
   * alt=sse 且未开启 streamThoughtImmediately 时，进入排队 / worker 执行后最多等多久（毫秒）才提前放行
   * HTTP 200 text/event-stream 并开始 : keepalive 心跳。默认 3000。
   */
  streamThoughtEarlyReleaseMs?: number;
  /**
   * 巨型冷请求（未命中缓存输入 >= 16000 tokens）完成后，同一 (accountId, sessionHash)
   * 下一次请求出站前的 KV 缓存就绪平滑等待窗口（毫秒，0..5000，0 表示关闭，默认 1000）。
   */
  cacheSettlingDelayMs: number;
  sensitiveFilterEnabled: boolean;
  sensitiveWords: SensitiveWordRule[];
}

// ============================================================================
// Request Logs & SSE Event Types
// ============================================================================

export interface PhaseTimingsMs {
  queue?: number;
  workerAcquire?: number;
  mcpSetup?: number;
  firstEvent?: number;
  total?: number;
  spawnMs?: number;
  initializeMs?: number;
  sessionSetupMs?: number;
  setModelMs?: number;
  promptToFirstEventMs?: number;
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
  httpStatus?: number;
  startedAt: number;
  durationMs?: number;
  switchCount: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHit?: boolean;
  cachedTokens?: number;
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

// ============================================================================
// ACP & MCP Types
// ============================================================================

export interface AcpCapabilities {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  models?: string[];
  [key: string]: unknown;
}

export interface SanitizedTool {
  name: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

export type WorkerStatus = 'idle' | 'busy' | 'starting' | 'stopped' | 'error';

export interface WorkerState {
  id: string;
  accountId: string;
  status: WorkerStatus;
  pid?: number;
  startedAt: number;
  lastUsedAt: number;
  activeRequestId?: string;
  error?: string;
}
