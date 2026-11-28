import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { buildAgyWorkerArgs, buildIsolatedAgyEnv, createAgyWorkerLogPath, getDataRoot, removeAgyWorkerLog, resolveAgyBinary } from "./env";
import { ensureMinimalAgentDefinition } from "./minimal-agent";
import { AcpConnection } from "./connection";
import { LoopbackMcpServer, SessionToolBroker, type ExposedToolCall, type ToolResultPayload } from "./loopback-mcp";
import { serializeContentsWithBudget } from "./history-budget";
import {
  sanitizeToolDeclarations,
  type GeminiFunctionDeclaration,
  type SanitizedToolDefinition,
} from "./schema-sanitizer";
import { AgyStreamGuard } from "./stream-guard";
import {
  findReusablePrefixLength,
  summarizeMessageForHistory,
  type HistoryMessageSummary,
} from "./history-matcher";
import {
  normalizeSystemInstructionForHash,
  stripVolatileSystem,
  type VolatileSystemOptions,
} from "./volatile-system";
import type { AcpSessionMidTurnMeta } from "../db/store";
import {
  isStepUsageEnabled,
  modelUsageAfter,
  modelUsageCursor,
  sessionDbPath,
  sumStepUsage,
  type ModelUsageCursor,
} from "./step-usage";
import { getConfig, resolveEffectiveProxy } from "../config/settings";
import { checkProxyReachable } from "../accounts/exit-probe";
import { accountScheduler } from "../accounts/scheduler";
import {
  applySensitiveFilterToContents,
  applySensitiveFilterToText,
  applySensitiveFilterToTools,
  computeSensitiveFilterFingerprint,
  getEffectiveSensitiveRules,
  type SensitiveFilterConfig,
} from "./sensitive-filter";
import type {
  AccountRecord,
  GatewayConfig,
  GeminiContent,
  GeminiGenerateRequest,
  GeminiPart,
} from "../types";

export type WorkerErrorCode =
  | "QUOTA_EXHAUSTED"
  | "CAPACITY_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "VALIDATION_REQUIRED"
  | "RESTRICTED"
  | "SOFT_ERROR"
  | "TRANSPORT_ERROR"
  | "MODEL_SELECTION_FAILED"
  | "TIMEOUT"
  | "CANCELLED";

const CLI_API_ERROR_PREFIX_RE = /^\s*⚠\s*API error\s*\(attempt\s+\d+\):/i;
const CLI_BARE_API_ERROR_PREFIX_RE = /^\s*(?:⚠\s*)?API error\s*\(attempt\s+\d+\)\s*:/i;
const CLI_WARNING_PREFIX_RE = /^\s*⚠\s+/;
const RETRY_429_HINT_RE =
  /^\s*(?:retrying\b.*\b(?:429|resource_exhausted|rate[_\s-]?limit|quota|too many requests)\b|(?:429|resource_exhausted)\b.*\bretrying\b)/i;

const AGY_RETRY_LOG_RE = /\] (?:Run|CallWithRetry): attempt \d+ failed \((.+)\), retrying in /;
const MAX_LOG_READ_BYTES = 256 * 1024;

const FAST_ABORT_ERROR_CODES: ReadonlySet<WorkerErrorCode> = new Set([
  "CAPACITY_UNAVAILABLE",
  "AUTH_REQUIRED",
  "VALIDATION_REQUIRED",
  "RESTRICTED",
  "TRANSPORT_ERROR",
]);

export class WorkerError extends Error {
  public readonly code: WorkerErrorCode;
  public readonly upstreamStatus?: number;
  public readonly retryAfterMs?: number;
  public readonly rawError?: string;
  public timings?: WorkerTimings;
  public modelSelection?: WorkerModelSelection;

  constructor(
    message: string,
    opts: {
      code: WorkerErrorCode;
      upstreamStatus?: number;
      retryAfterMs?: number;
      rawError?: string;
    },
  ) {
    super(message);
    this.name = "WorkerError";
    this.code = opts.code;
    this.upstreamStatus = opts.upstreamStatus;
    this.retryAfterMs = opts.retryAfterMs;
    this.rawError = opts.rawError;
  }
}

export interface AcpSessionSnapshot {
  stickyKey?: string;
  sessionId: string;
  accountId?: string;
  model?: string;
  systemHash: string;
  toolsHash: string;
  sensitiveFilterFingerprint?: string;
  committedHashes: string[];
  committedNormalized?: string[];
  committedSummaries?: HistoryMessageSummary[];
  midTurn?: boolean;
  committedCount?: number;
  midTurnMeta?: AcpSessionMidTurnMeta | null;
  updatedAt: number;
}

export interface AcpTransport {
  initialize(): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<{ sessionId: string }>;
  resumeSession?(params: {
    sessionId: string;
    cwd: string;
    mcpServers: Array<Record<string, unknown>>;
    _meta?: Record<string, unknown>;
  }, timeoutMs?: number): Promise<{ sessionId?: string }>;
  closeSession?(sessionId: string): Promise<void>;
  setModel?(params: { sessionId: string; modelId: string }): Promise<unknown>;
  prompt(params: Record<string, unknown>): Promise<unknown>;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
  onStderr?(handler: (chunk: string) => void): void;
}

export type AcpTransportFactory = (opts: {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onUpdate: (params: Record<string, unknown>) => void;
  onExit: (code: number | null, stderr: string) => void;
  onStderr?: (chunk: string) => void;
}) => AcpTransport;

export interface PrewarmedTransportOptions {
  transport: AcpTransport;
  envHomeDir?: string;
  boundProxyUrl?: string;
  logFile?: string;
  initCaps?: unknown;
  bindHandlers?: (handlers: {
    onUpdate: (params: Record<string, unknown>) => void;
    onExit: (code: number | null, stderr: string) => void;
  }) => void;
}

export interface WorkerOptions {
  account: AccountRecord;
  model: string;
  agyPath?: string;
  softErrorCutoffMs?: number;
  idleTimeoutMs?: number;
  logPollIntervalMs?: number;
  mcpServer: LoopbackMcpServer;
  workspaceDir?: string;
  transportFactory?: AcpTransportFactory;
  stickyKey?: string;
  persistedSession?: AcpSessionSnapshot | null;
  onSessionStateChange?: (snapshot: AcpSessionSnapshot | null) => void;
  onWorkerSpawn?: (accountId: string) => void;
  tryAcquireWorkerSpawn?: (accountId: string) => boolean;
  sessionTtlMs?: number;
  prewarmedTransport?: PrewarmedTransportOptions | null;
}

export interface WorkerTimings {
  spawnMs?: number;
  initializeMs?: number;
  sessionSetupMs?: number;
  setModelMs?: number;
  promptToFirstEventMs?: number;
  coldStart?: boolean;
  sessionResumed?: boolean;
}

export interface WorkerModelSelection {
  confirmedModel?: string;
  modelSelectionAcknowledged?: boolean;
}

function reportedModel(result: unknown): string | undefined {
  const value = result as { models?: { currentModelId?: unknown }; currentModelId?: unknown; modelId?: unknown } | null;
  const id = value?.models?.currentModelId ?? value?.currentModelId ?? value?.modelId;
  return typeof id === 'string' && id.trim() ? id.trim().replace(/^models\//, '') : undefined;
}

export interface WorkerPromptResult {
  modelSelection?: WorkerModelSelection;
  parts: GeminiPart[];
  finishReason: string;
  cacheHit?: boolean;
  cachedTokens?: number;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    cacheCreationTokenCount?: number;
  };
  timings?: WorkerTimings;
}

export interface WorkerStreamCallbacks {
  onPart?: (part: GeminiPart) => void;
}

interface AcpPromptUsage {
  inputTokens?: unknown;
  cachedReadTokens?: unknown;
  cachedWriteTokens?: unknown;
  outputTokens?: unknown;
  thoughtTokens?: unknown;
  totalTokens?: unknown;
}

function toNonNegInt(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? Math.max(0, Math.round(val)) : 0;
}

function normalizeAcpUsage(raw: unknown): {
  usageMetadata: NonNullable<WorkerPromptResult["usageMetadata"]>;
  cachedTokens: number;
  cacheHit: boolean;
} | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const u = raw as AcpPromptUsage;
  const rawInput = toNonNegInt(u.inputTokens);
  const cacheRead = toNonNegInt(u.cachedReadTokens);
  const cacheWrite = toNonNegInt(u.cachedWriteTokens);
  const rawOutput = toNonNegInt(u.outputTokens);
  const thinking = toNonNegInt(u.thoughtTokens);
  const total = toNonNegInt(u.totalTokens);

  const inclusive =
    total > 0
      ? Math.abs(total - (rawInput + rawOutput)) <
        Math.abs(total - (rawInput + cacheRead + cacheWrite + rawOutput))
      : cacheRead <= rawInput;
  const promptInput = inclusive ? rawInput : rawInput + cacheRead;
  const realCachedTokens = Math.min(cacheRead, promptInput);
  const candidatesTokenCount = rawOutput >= thinking ? rawOutput - thinking : rawOutput;
  const thoughtsTokenCount = thinking;
  const totalTokenCount =
    total > 0 ? total : promptInput + Math.max(rawOutput, thinking) + cacheWrite;

  return {
    usageMetadata: {
      promptTokenCount: promptInput,
      candidatesTokenCount,
      thoughtsTokenCount,
      totalTokenCount,
      ...(realCachedTokens > 0 ? { cachedContentTokenCount: realCachedTokens } : {}),
      ...(cacheWrite > 0 ? { cacheCreationTokenCount: cacheWrite } : {}),
    },
    cachedTokens: realCachedTokens,
    cacheHit: realCachedTokens > 0,
  };
}

function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export function defaultTransportFactory(opts: {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onUpdate: (params: Record<string, unknown>) => void;
  onExit: (code: number | null, stderr: string) => void;
  onStderr?: (chunk: string) => void;
}): AcpTransport {
  const conn = new AcpConnection({
    binaryPath: opts.binaryPath,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    onUpdate: opts.onUpdate,
    onExit: opts.onExit,
    onStderr: opts.onStderr,
  });

  return {
    initialize: () => conn.initialize(),
    newSession: (params) => conn.request<{ sessionId: string }>("session/new", params),
    resumeSession: (params, timeoutMs) => conn.request<{ sessionId?: string }>("session/resume", params, timeoutMs),
    closeSession: async (sessionId) => {
      await conn.request("session/close", { sessionId });
    },
    setModel: (params) => conn.request("session/set_model", params),
    prompt: (params) => conn.request("session/prompt", params, 0),
    cancel: async (sessionId) => {
      conn.notify("session/cancel", { sessionId });
    },
    close: () => conn.close(),
    isAlive: () => conn.isAlive,
    onStderr: (handler) => conn.onStderr(handler),
  };
}

export async function closeAgyTransport(transport: AcpTransport, logFile?: string): Promise<void> {
  try {
    await transport.close();
  } finally {
    await removeAgyWorkerLog(logFile);
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function extractTextFromContent(content?: { parts?: GeminiPart[] }): string {
  if (!content?.parts) return "";
  return content.parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

function collectToolDeclarations(request: GeminiGenerateRequest): GeminiFunctionDeclaration[] {
  const declarations: GeminiFunctionDeclaration[] = [];
  for (const tool of request.tools ?? []) {
    if (Array.isArray(tool.functionDeclarations)) {
      declarations.push(...tool.functionDeclarations);
    }
  }
  return declarations;
}

function computeSystemHash(
  request: GeminiGenerateRequest,
  config: SensitiveFilterConfig,
  options?: VolatileSystemOptions,
): string {
  const normalized = normalizeSystemInstructionForHash(request.systemInstruction ?? null, options);
  if (getEffectiveSensitiveRules(config).length === 0) {
    return hashJson(normalized);
  }
  const filteredText = applySensitiveFilterToText(
    stripVolatileSystem(extractTextFromContent(request.systemInstruction), options),
    config,
    'system',
  );
  return hashJson({ raw: normalized, filteredText });
}

function computeToolsHash(
  request: GeminiGenerateRequest,
  config: SensitiveFilterConfig,
): string {
  const raw = request.tools ?? null;
  if (getEffectiveSensitiveRules(config).length === 0) {
    return hashJson(raw);
  }
  const filteredDeclarations = applySensitiveFilterToTools(
    collectToolDeclarations(request),
    config,
  );
  return hashJson({ raw, filteredDeclarations });
}

export function isToolsSuperset(
  prevTools: readonly SanitizedToolDefinition[],
  nextTools: readonly SanitizedToolDefinition[],
): boolean {
  if (nextTools.length < prevTools.length) return false;
  const nextByOriginal = new Map<string, SanitizedToolDefinition>();
  for (const tool of nextTools) {
    if (nextByOriginal.has(tool.originalName)) {
      return false;
    }
    nextByOriginal.set(tool.originalName, tool);
  }
  for (const prev of prevTools) {
    const next = nextByOriginal.get(prev.originalName);
    if (!next) return false;
    if (hashJson(prev) !== hashJson(next)) {
      return false;
    }
  }
  return true;
}

function isEffectiveOutputPart(part: GeminiPart): boolean {
  if (!part) return false;
  if (!part.thought && typeof part.text === "string" && part.text.length > 0) {
    return true;
  }
  if (part.functionCall || part.inlineData || part.functionResponse) {
    return true;
  }
  return false;
}

function extractNonThoughtAssistantText(parts?: GeminiPart[]): string | null {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.functionCall || part.functionResponse || part.inlineData) {
      return null;
    }
    if (!part.thought && typeof part.text === "string" && part.text.length > 0) {
      chunks.push(part.text);
    }
  }
  const normalized = chunks.join("").trim();
  return normalized.length > 0 ? normalized : null;
}

function mapStopReasonToFinishReason(stopReason?: unknown): string {
  if (typeof stopReason !== "string" || !stopReason) return "STOP";
  switch (stopReason.toLowerCase()) {
    case "end_turn":
    case "stop_sequence":
    case "stop":
      return "STOP";
    case "max_tokens":
      return "MAX_TOKENS";
    case "refusal":
    case "safety":
      return "SAFETY";
    case "recitation":
      return "RECITATION";
    case "cancelled":
    case "canceled":
    case "other":
      return "OTHER";
    default:
      return "STOP";
  }
}

export function isToolResponseError(response: unknown): boolean {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return false;
  }
  const obj = response as Record<string, unknown>;
  if (obj.is_error === true || obj.isError === true) {
    return true;
  }
  if (
    typeof obj.error === "string" &&
    obj.error.trim().length > 0 &&
    obj.output === undefined &&
    obj.result === undefined &&
    obj.content === undefined
  ) {
    return true;
  }
  return false;
}

export function classifyUpstreamError(
  rawText: string,
): { code: WorkerErrorCode; upstreamStatus: number; retryAfterMs?: number } | null {
  const lower = rawText.toLowerCase();

  if (
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    /\b429\b/.test(lower)
  ) {
    const delay = /retry[-_\s]?after[:\s]+(\d+(?:\.\d+)?)(?:[ \t]*(ms|s))?(?![\w.])/i.exec(rawText);
    const durationMs = delay ? Math.ceil(Number(delay[1]) * (delay[2]?.toLowerCase() === 'ms' ? 1 : 1000)) : undefined;
    const retryAfterMs = Number.isSafeInteger(durationMs) ? durationMs : undefined;
    return { code: "QUOTA_EXHAUSTED", upstreamStatus: 429, retryAfterMs };
  }

  if (
    lower.includes("unauthenticated") ||
    lower.includes("authentication required") ||
    lower.includes("auth_required") ||
    lower.includes("please login") ||
    lower.includes("not logged in") ||
    lower.includes("invalid credentials") ||
    /\b401\b/.test(lower)
  ) {
    return { code: "AUTH_REQUIRED", upstreamStatus: 401 };
  }

  if (
    lower.includes("validation_required") ||
    lower.includes("verify your account") ||
    lower.includes("verification required")
  ) {
    return { code: "VALIDATION_REQUIRED", upstreamStatus: 403, retryAfterMs: 10 * 60_000 };
  }

  if (
    lower.includes("account restricted") ||
    lower.includes("permission_denied") ||
    lower.includes("violation of terms") ||
    lower.includes("service has been disabled") ||
    lower.includes("account has been disabled") ||
    lower.includes("account suspended") ||
    lower.includes("account banned") ||
    lower.includes("submit an appeal") ||
    /\b403\b/.test(lower)
  ) {
    return { code: "RESTRICTED", upstreamStatus: 403 };
  }

  if (
    lower.includes("no capacity available") ||
    lower.includes("model overloaded") ||
    lower.includes("service unavailable") ||
    (/\bunavailable\b/.test(lower) && /\b503\b/.test(lower)) ||
    /\b(?:code|status|http)\s*[:=]?\s*503\b/.test(lower)
  ) {
    const delay =
      /retry[-_\s]?after[:\s]+(\d+(?:\.\d+)?)(?:[ \t]*(ms|s))?(?![\w.])/i.exec(rawText) ??
      /retrying\s+in\s+(\d+(?:\.\d+)?)(?:[ \t]*(ms|s))?(?![\w.])/i.exec(rawText);
    const durationMs = delay
      ? Math.ceil(Number(delay[1]) * (delay[2]?.toLowerCase() === "ms" ? 1 : 1000))
      : undefined;
    const retryAfterMs = Number.isSafeInteger(durationMs) ? durationMs : undefined;
    return {
      code: "CAPACITY_UNAVAILABLE",
      upstreamStatus: 503,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  if (
    lower.includes("unexpected eof") ||
    /\beof\b/.test(lower) ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("broken pipe") ||
    lower.includes("epipe") ||
    lower.includes("no such host") ||
    lower.includes("dial tcp") ||
    lower.includes("tls handshake timeout") ||
    lower.includes("i/o timeout") ||
    lower.includes("context deadline exceeded") ||
    lower.includes("socket hang up")
  ) {
    return { code: "TRANSPORT_ERROR", upstreamStatus: 502 };
  }

  return null;
}

const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export class AgySessionWorker {
  public readonly account: AccountRecord;
  public model: string;
  public lastUsedAt: number = Date.now();

  private readonly agyPath?: string;
  private readonly softErrorCutoffMs: number;
  private readonly idleTimeoutMs: number;
  private readonly mcpServer: LoopbackMcpServer;
  private readonly workspaceDir: string;
  private readonly transportFactory: AcpTransportFactory;
  private stickyKey?: string;
  private persistedSession: AcpSessionSnapshot | null;
  private onSessionStateChange?: (snapshot: AcpSessionSnapshot | null) => void;
  private readonly tryAcquireWorkerSpawn: (accountId: string) => boolean;
  private readonly sessionTtlMs: number;

  private transport: AcpTransport | null = null;
  private boundProxyUrl: string | undefined = undefined;
  private sessionId: string | null = null;
  private broker: SessionToolBroker | null = null;
  private registeredMcp: { token: string; url: string; unregister: () => void } | null = null;

  private committedSummaries: HistoryMessageSummary[] = [];
  private committedHashes: string[] = [];
  private pendingRequestedModel?: string;
  private lastAssistantText: string | null = null;
  private systemInstructionHash = "";
  private toolsHash = "";
  private sensitiveFilterFingerprint = "";
  private awaitingTools = new Map<string, ExposedToolCall>();
  private busy = false;
  private inFlightPromptPromise: Promise<unknown> | null = null;
  private logFile?: string;
  private promptLog?: { file: string; offset: number; reading: boolean };
  private readonly logPollIntervalMs: number;

  // Per-turn collection state
  private activeTurnParts: GeminiPart[] = [];
  private internal429RetryCount = 0;
  private activeTurnCallbacks?: WorkerStreamCallbacks;
  private activeSoftErrorAbort?: (err: WorkerError) => void;
  private activeToolBatchResolve?: () => void;
  private activeTurnOpen = false;
  private activeTurnId = 0;
  private resumingSession = false;
  private unemittedToolCalls: ExposedToolCall[] = [];
  private softErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private mcpToOriginal = new Map<string, string>();
  private registeredTools: SanitizedToolDefinition[] = [];
  private prewarmedTransport: PrewarmedTransportOptions | null = null;
  private initCaps: unknown = null;
  private streamGuard: AgyStreamGuard | null = null;
  private activeTurnTimings: WorkerTimings = {};
  private activeTurnPromptStartMs: number | null = null;
  private modelSelection: WorkerModelSelection = {};
  private verifyingModel = false;
  private stderrBuffer = "";
  private stderrAbortTriggered = false;
  private stepUsageCursorState: {
    sessionId: string;
    dbPath: string;
    cursor: ModelUsageCursor;
  } | null = null;

  constructor(opts: WorkerOptions) {
    this.account = opts.account;
    this.model = opts.model;
    this.agyPath = opts.agyPath;
    this.softErrorCutoffMs = opts.softErrorCutoffMs ?? 2800;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 180_000;
    const logPollIntervalMs = opts.logPollIntervalMs ?? 500;
    this.logPollIntervalMs = Number.isFinite(logPollIntervalMs) ? Math.max(50, logPollIntervalMs) : 500;
    this.mcpServer = opts.mcpServer;
    this.workspaceDir = opts.workspaceDir ?? getDataRoot();
    this.transportFactory = opts.transportFactory ?? defaultTransportFactory;
    this.stickyKey = opts.stickyKey;
    this.persistedSession = opts.persistedSession ?? null;
    this.onSessionStateChange = opts.onSessionStateChange;
    this.tryAcquireWorkerSpawn =
      opts.tryAcquireWorkerSpawn ??
      (opts.onWorkerSpawn
        ? (accountId) => {
            opts.onWorkerSpawn!(accountId);
            return true;
          }
        : (accountId) => accountScheduler.tryConsumeWorkerSpawn(accountId));
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (opts.prewarmedTransport) {
      this.adoptPrewarmedTransport(
        opts.prewarmedTransport.transport,
        opts.prewarmedTransport.envHomeDir,
        {
          initCaps: opts.prewarmedTransport.initCaps,
          boundProxyUrl: opts.prewarmedTransport.boundProxyUrl,
          logFile: opts.prewarmedTransport.logFile,
          bindHandlers: opts.prewarmedTransport.bindHandlers,
        },
      );
    }
  }

  adoptPrewarmedTransport(
    transport: AcpTransport,
    envHomeDir?: string,
    options?: {
      initCaps?: unknown;
      boundProxyUrl?: string;
      logFile?: string;
      bindHandlers?: PrewarmedTransportOptions["bindHandlers"];
    },
  ): void {
    if (this.prewarmedTransport && this.prewarmedTransport.transport !== transport) {
      void closeAgyTransport(this.prewarmedTransport.transport, this.prewarmedTransport.logFile).catch(() => {});
    }
    this.prewarmedTransport = {
      transport,
      envHomeDir,
      boundProxyUrl: options?.boundProxyUrl,
      logFile: options?.logFile,
      initCaps: options?.initCaps,
      bindHandlers: options?.bindHandlers,
    };
  }

  getBoundProxyUrl(): string | undefined {
    return this.boundProxyUrl;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get isAlive(): boolean {
    return Boolean(this.transport?.isAlive() && this.sessionId);
  }

  setRequestedModel(model: string): void {
    this.pendingRequestedModel = model;
  }

  bindSessionPersistence(
    stickyKey: string,
    onSessionStateChange: (snapshot: AcpSessionSnapshot | null) => void,
  ): void {
    this.stickyKey = stickyKey;
    this.onSessionStateChange = onSessionStateChange;
  }

  private emitSessionSnapshot(committedCount: number, midTurn: boolean): void {
    if (!this.sessionId) return;
    const awaitingToolsList = Array.from(this.awaitingTools.values()).map((t) => ({
      id: t.id,
      name: t.name,
      mcpName: t.mcpName,
      args: t.args,
    }));
    this.onSessionStateChange?.({
      stickyKey: this.stickyKey,
      sessionId: this.sessionId,
      accountId: this.account.id,
      model: this.model,
      systemHash: this.systemInstructionHash,
      toolsHash: this.toolsHash,
      sensitiveFilterFingerprint: this.sensitiveFilterFingerprint,
      committedHashes: [...this.committedHashes],
      committedNormalized: this.committedSummaries.map((s) => s.norm),
      committedSummaries: [...this.committedSummaries],
      midTurn,
      committedCount,
      midTurnMeta:
        midTurn && awaitingToolsList.length > 0
          ? { awaitingTools: awaitingToolsList }
          : null,
      updatedAt: this.lastUsedAt,
    });
  }

  /**
   * 彻底消除 409 死锁：
   * 仅当 systemInstruction、tools、已提交前缀完全一致且工具挂起状态匹配时才复用；
   * 否则一律返回 false，由上层/executePrompt 触发无缝冷启动重建。
   */
  canReuse(
    request: GeminiGenerateRequest,
    configSnapshot?: SensitiveFilterConfig & Partial<Pick<GatewayConfig, "defaultProxy">>,
    accountOverride?: AccountRecord,
    requestedModel?: string,
  ): boolean {
    if (!this.isAlive) return false;
    if (
      requestedModel &&
      requestedModel !== this.model &&
      typeof this.transport?.setModel !== "function"
    ) {
      return false;
    }
    if (
      accountOverride &&
      (accountOverride.id !== this.account.id || accountOverride.homeDir !== this.account.homeDir)
    ) {
      return false;
    }
    const config = configSnapshot ?? getConfig();
    const gatewayConfig =
      configSnapshot && "defaultProxy" in configSnapshot && typeof configSnapshot.defaultProxy === "string"
        ? { defaultProxy: configSnapshot.defaultProxy }
        : getConfig();
    const expectedProxy = resolveEffectiveProxy((accountOverride ?? this.account).proxyUrl, gatewayConfig);
    if (expectedProxy !== this.boundProxyUrl) {
      return false;
    }
    const nextSensitiveFingerprint = computeSensitiveFilterFingerprint(config);
    if (nextSensitiveFingerprint !== this.sensitiveFilterFingerprint) {
      return false;
    }
    const nextSysHash = computeSystemHash(request, config);
    const nextToolsHash = computeToolsHash(request, config);
    if (nextSysHash !== this.systemInstructionHash) {
      return false;
    }
    if (nextToolsHash !== this.toolsHash) {
      if (!this.broker || this.registeredTools.length === 0) {
        return false;
      }
      const nextDeclarations = applySensitiveFilterToTools(
        collectToolDeclarations(request),
        config,
      );
      const nextSanitized = sanitizeToolDeclarations(nextDeclarations);
      if (
        nextSanitized.tools.length <= this.registeredTools.length ||
        !isToolsSuperset(this.registeredTools, nextSanitized.tools)
      ) {
        return false;
      }
    }

    const incoming = request.contents ?? [];
    const committedLen =
      this.committedSummaries.length > 0
        ? this.committedSummaries.length
        : this.committedHashes.length;
    if (incoming.length <= committedLen) {
      return false;
    }

    if (this.committedSummaries.length > 0) {
      const { matchedCount } = findReusablePrefixLength(this.committedSummaries, incoming);
      if (matchedCount !== this.committedSummaries.length) {
        return false;
      }
    } else {
      for (let i = 0; i < this.committedHashes.length; i++) {
        if (hashJson(incoming[i]) !== this.committedHashes[i]) {
          return false;
        }
      }
    }

    if (this.awaitingTools.size === 0 && this.inFlightPromptPromise !== null) {
      return false;
    }

    // Continue a pending batch if the client answers at least one emitted call.
    if (this.awaitingTools.size > 0) {
      const unemittedIds = new Set(this.unemittedToolCalls.map((c) => c.id));
      const emittedAwaiting = new Map<string, ExposedToolCall>();
      for (const [id, call] of this.awaitingTools.entries()) {
        if (!unemittedIds.has(id)) {
          emittedAwaiting.set(id, call);
        }
      }

      const tail = incoming.slice(committedLen);
      const providedIds = new Set<string>();
      for (const c of tail) {
        for (const p of c.parts ?? []) {
          if (p.functionResponse?.id) {
            if (emittedAwaiting.has(p.functionResponse.id)) {
              providedIds.add(p.functionResponse.id);
            }
          } else if (p.functionResponse?.name) {
            for (const [id, call] of emittedAwaiting.entries()) {
              if (!providedIds.has(id) && call.name === p.functionResponse.name) {
                providedIds.add(id);
                break;
              }
            }
          }
        }
      }
      if (emittedAwaiting.size > 0 && providedIds.size === 0) {
        return false;
      }
      if (this.unemittedToolCalls.length > 0 && providedIds.size === 0) {
        return false;
      }
    }

    return true;
  }

  async executePrompt(
    request: GeminiGenerateRequest,
    callbacks?: WorkerStreamCallbacks,
    signal?: AbortSignal,
    _retriedTokenLimit = false,
    requestedModel?: string,
  ): Promise<WorkerPromptResult> {
    const targetModel = requestedModel ?? this.pendingRequestedModel ?? this.model;
    this.pendingRequestedModel = undefined;

    if (signal?.aborted) {
      await this.resetAndClose();
      throw new WorkerError("Request cancelled", { code: "CANCELLED" });
    }

    if (this.busy) {
      // 不抛出 409，直接冷启动新会话或等待
      await this.resetAndClose();
    }

    const myTurnId = ++this.activeTurnId;
    this.busy = true;
    this.lastUsedAt = Date.now();
    this.activeTurnParts = [];
    this.internal429RetryCount = 0;
    this.stderrBuffer = "";
    this.stderrAbortTriggered = false;
    this.streamGuard = new AgyStreamGuard();
    this.activeTurnCallbacks = callbacks;
    this.activeTurnTimings = {
      coldStart: false,
      sessionResumed: false,
    };
    this.activeTurnPromptStartMs = null;

    const configSnapshot = getConfig();
    let onAbort: (() => void) | undefined;
    let stopLogPolling: (() => void) | undefined;
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new WorkerError("Request cancelled", { code: "CANCELLED" }));
            return;
          }
          onAbort = () => {
            reject(new WorkerError("Request cancelled", { code: "CANCELLED" }));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;
    abortPromise?.catch(() => {});

    let toolsGrewUpdated = false;
    try {
      let reuse = false;
      const tryExecute = async () => {
        reuse = this.canReuse(request, configSnapshot, undefined, targetModel);
        if (reuse && targetModel !== this.model) {
          const prevModel = this.model;
          this.model = targetModel;
          try {
            await this.selectModel({ models: { currentModelId: prevModel } }, undefined);
          } catch (err) {
            if (err instanceof WorkerError && err.code === "MODEL_SELECTION_FAILED") {
              await this.resetAndClose();
              this.onSessionStateChange?.(null);
              reuse = false;
            } else {
              throw err;
            }
          }
        }
        if (!reuse) {
          this.model = targetModel;
          const coldStartPromise = this.coldStart(request, configSnapshot, signal);
          if (abortPromise) {
            coldStartPromise.catch(() => {});
            reuse = await Promise.race([coldStartPromise, abortPromise]);
          } else {
            reuse = await coldStartPromise;
          }
        }
      };
      await tryExecute();

      if (signal?.aborted) {
        await this.resetAndClose();
        throw new WorkerError("Request cancelled", { code: "CANCELLED" });
      }

      const stepUsageDbPath =
        isStepUsageEnabled() && this.sessionId
          ? sessionDbPath(this.sessionId, this.account.homeDir)
          : null;
      let usageCursor: ModelUsageCursor | null = null;
      if (stepUsageDbPath && this.sessionId) {
        if (
          this.stepUsageCursorState &&
          this.stepUsageCursorState.sessionId === this.sessionId &&
          this.stepUsageCursorState.dbPath === stepUsageDbPath
        ) {
          usageCursor = this.stepUsageCursorState.cursor;
        } else {
          usageCursor = modelUsageCursor(stepUsageDbPath);
          if (usageCursor) {
            this.stepUsageCursorState = {
              sessionId: this.sessionId,
              dbPath: stepUsageDbPath,
              cursor: usageCursor,
            };
          } else {
            this.stepUsageCursorState = null;
          }
        }
      }

      let newlyLoadedTools: SanitizedToolDefinition[] = [];
      if (reuse) {
        const nextToolsHash = computeToolsHash(request, configSnapshot);
        if (nextToolsHash !== this.toolsHash && this.broker) {
          const nextDeclarations = applySensitiveFilterToTools(
            collectToolDeclarations(request),
            configSnapshot,
          );
          const nextSanitized = sanitizeToolDeclarations(nextDeclarations);
          const { added } = this.broker.updateTools(nextSanitized.tools);
          newlyLoadedTools = added;
          this.mcpToOriginal = nextSanitized.mcpToOriginal;
          this.registeredTools = nextSanitized.tools;
          this.toolsHash = nextToolsHash;
          toolsGrewUpdated = true;
        }
      }

      const incoming = request.contents ?? [];
      const committedBeforeLen = this.committedHashes.length;
      const delta = reuse ? incoming.slice(committedBeforeLen) : incoming;

      // 收集需要喂给 broker 的工具调用结果（在挂载完本轮等待器后再交付）
      const payloads: ToolResultPayload[] = [];
      const unemittedIds = new Set(this.unemittedToolCalls.map((c) => c.id));
      if (reuse && this.awaitingTools.size > 0 && this.broker) {
        for (const c of delta) {
          for (const p of c.parts ?? []) {
            if (!p.functionResponse) continue;
            let callId = p.functionResponse.id;
            if (!callId) {
              for (const [id, call] of this.awaitingTools.entries()) {
                if (!unemittedIds.has(id) && call.name === p.functionResponse.name) {
                  callId = id;
                  break;
                }
              }
            }
            if (callId && !unemittedIds.has(callId) && this.awaitingTools.has(callId)) {
              const response = p.functionResponse.response ?? {};
              const isError = isToolResponseError(response);
              payloads.push({
                callId,
                response,
                ...(isError ? { isError: true } : {}),
              });
              this.awaitingTools.delete(callId);
            }
          }
        }
      }

      const softErrorPromise = new Promise<never>((_, reject) => {
        this.activeSoftErrorAbort = reject;
      });
      const toolBatchPromise = new Promise<void>((resolve) => {
        this.activeToolBatchResolve = resolve;
      });
      this.activeTurnOpen = true;
      this.resetIdleTimer();

      if (this.unemittedToolCalls.length > 0) {
        const pending = this.unemittedToolCalls.splice(0);
        for (const call of pending) {
          const part: GeminiPart = {
            functionCall: {
              id: call.id,
              name: call.name,
              args: call.args,
            },
          };
          this.activeTurnParts.push(part);
          this.activeTurnCallbacks?.onPart?.(part);
        }
        this.activeTurnOpen = false;
        this.activeToolBatchResolve?.();
      }

      if (payloads.length > 0 && this.broker) {
        for (const id of this.awaitingTools.keys()) {
          if (!unemittedIds.has(id)) {
            payloads.push({
              callId: id,
              isError: true,
              response: { error: "Client omitted tool result for this call" },
            });
            this.awaitingTools.delete(id);
          }
        }
        this.broker.deliverResults(payloads);
        if (this.awaitingTools.size > 0) {
          this.lastUsedAt = Date.now();
          this.emitSessionSnapshot(this.committedHashes.length, true);
        }
      }

      if (!this.inFlightPromptPromise) {
        let promptDelta = delta;
        if (
          reuse &&
          this.awaitingTools.size === 0 &&
          this.lastAssistantText !== null &&
          delta.length >= 2 &&
          delta[0]?.role === "model"
        ) {
          const candidateText = extractNonThoughtAssistantText(delta[0].parts);
          if (candidateText !== null && candidateText === this.lastAssistantText) {
            promptDelta = delta.slice(1);
          }
        }
        const filteredContents = applySensitiveFilterToContents(
          reuse ? promptDelta : incoming,
          configSnapshot,
        );
        const promptBlocks = serializeContentsWithBudget(filteredContents);
        if (newlyLoadedTools.length > 0) {
          const loadedNames = newlyLoadedTools.map((t) => t.mcpName).join(", ");
          promptBlocks.push({
            type: "text",
            text: `These tools were loaded and can be called now: ${loadedNames}.`,
          });
        }

        if (this.logFile) {
          try {
            const offset = statSync(this.logFile, { throwIfNoEntry: false })?.size ?? 0;
            this.promptLog = { file: this.logFile, offset, reading: false };
          } catch {
            // An unreadable log leaves the stderr and ACP error paths active.
          }
        }
        this.activeTurnPromptStartMs = performance.now();
        const rawPrompt = this.transport!.prompt({
          sessionId: this.sessionId,
          model: this.model,
          prompt: promptBlocks,
        });
        const clearPrompt = () => {
          if (this.inFlightPromptPromise === rawPrompt) {
            this.inFlightPromptPromise = null;
            this.promptLog = undefined;
          }
        };
        void rawPrompt.then(clearPrompt, clearPrompt);
        this.inFlightPromptPromise = rawPrompt;
      }
      stopLogPolling = this.pollPromptLog();

      const raceCandidates: Promise<unknown>[] = [
        this.inFlightPromptPromise,
        softErrorPromise,
        toolBatchPromise,
      ];
      if (abortPromise) {
        raceCandidates.push(abortPromise);
      }

      const raceResult = await Promise.race(raceCandidates);
      this.activeTurnOpen = false;
      if (this.streamGuard) {
        const flushed = this.streamGuard.flush();
        if (flushed.emit) {
          const part: GeminiPart = { text: flushed.emit };
          this.activeTurnParts.push(part);
          this.activeTurnCallbacks?.onPart?.(part);
        }
        if (flushed.quotaError) {
          const retryAfterMs =
            flushed.quotaError.retryAfterSec !== undefined
              ? flushed.quotaError.retryAfterSec * 1000
              : undefined;
          await this.resetAndClose();
          throw new WorkerError(flushed.quotaError.message, {
            code: "QUOTA_EXHAUSTED",
            upstreamStatus: 429,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            rawError: flushed.quotaError.message,
          });
        }
      }
      const promptModel = reportedModel(raceResult);
      if (promptModel) {
        this.modelSelection.confirmedModel = promptModel;
        this.assertSelectedModel();
      }

      const stopReason =
        raceResult && typeof raceResult === "object"
          ? (raceResult as { stopReason?: unknown }).stopReason
          : undefined;
      const normalizedStopReason =
        typeof stopReason === "string" ? stopReason.toLowerCase() : "";
      const isSafetyOrRefusal =
        normalizedStopReason === "refusal" || normalizedStopReason === "safety";

      if (this.awaitingTools.size === 0) {
        const hasEffectiveOutput = this.activeTurnParts.some(isEffectiveOutputPart);
        if (!hasEffectiveOutput && !isSafetyOrRefusal) {
          await this.resetAndClose();
          throw new WorkerError(
            "Model returned thought-only or empty response without effective output",
            {
              code: "SOFT_ERROR",
              upstreamStatus: 502,
              rawError: "EMPTY_OR_THOUGHT_ONLY_RESPONSE",
            },
          );
        }
      }

      const finishReason =
        this.awaitingTools.size > 0
          ? "STOP"
          : mapStopReasonToFinishReason(stopReason);

      this.committedSummaries = incoming.map((c) => summarizeMessageForHistory(c));
      this.committedHashes = this.committedSummaries.map((s) => s.exactHash);
      this.lastAssistantText =
        this.awaitingTools.size === 0
          ? extractNonThoughtAssistantText(this.activeTurnParts)
          : null;
      this.lastUsedAt = Date.now();

      this.emitSessionSnapshot(this.committedHashes.length, this.awaitingTools.size > 0);

      const rawUsage =
        this.awaitingTools.size === 0 && raceResult && typeof raceResult === "object"
          ? (raceResult as { usage?: unknown }).usage
          : undefined;
      let normalizedUsage = normalizeAcpUsage(rawUsage);

      if (stepUsageDbPath && usageCursor) {
        let stepUsageResult = modelUsageAfter(stepUsageDbPath, usageCursor);
        const shouldWait =
          !stepUsageResult || stepUsageResult.steps.length === 0 || Boolean(stepUsageResult.pending);
        if (shouldWait && !signal?.aborted) {
          const maxWaitMs =
            this.awaitingTools.size === 0 || stepUsageResult?.pending ? 200 : 50;
          const pollMs = 25;
          const deadline = Date.now() + maxWaitMs;
          while (Date.now() < deadline && !signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            if (signal?.aborted) break;
            stepUsageResult = modelUsageAfter(stepUsageDbPath, usageCursor);
            if (stepUsageResult && stepUsageResult.steps.length > 0 && !stepUsageResult.pending) {
              break;
            }
          }
        }
        if (stepUsageResult && stepUsageResult.steps.length > 0) {
          const sum = sumStepUsage(stepUsageResult.steps);
          const promptInput = sum.input + sum.read;
          const cachedTokens = Math.min(sum.read, promptInput);
          const candidatesTokenCount = sum.output;
          const thoughtsTokenCount = sum.thinking;
          const totalTokenCount = promptInput + sum.output + sum.thinking + sum.write;
          normalizedUsage = {
            usageMetadata: {
              promptTokenCount: promptInput,
              candidatesTokenCount,
              thoughtsTokenCount,
              totalTokenCount,
              ...(cachedTokens > 0 ? { cachedContentTokenCount: cachedTokens } : {}),
              ...(sum.write > 0 ? { cacheCreationTokenCount: sum.write } : {}),
            },
            cachedTokens,
            cacheHit: cachedTokens > 0,
          };
          if (this.sessionId) {
            this.stepUsageCursorState = {
              sessionId: this.sessionId,
              dbPath: stepUsageDbPath,
              cursor: {
                source: stepUsageResult.source,
                idx: stepUsageResult.steps[stepUsageResult.steps.length - 1].idx,
              },
            };
          }
        }
      }

      return {
        parts: [...this.activeTurnParts],
        finishReason,
        ...(normalizedUsage
          ? {
              cacheHit: normalizedUsage.cacheHit,
              cachedTokens: normalizedUsage.cachedTokens,
              usageMetadata: normalizedUsage.usageMetadata,
            }
          : {
              cacheHit: undefined,
              cachedTokens: undefined,
              usageMetadata: undefined,
            }),
        timings: { ...this.activeTurnTimings },
        modelSelection: { ...this.modelSelection },
      };
    } catch (err) {
      const selection = { ...this.modelSelection };
      const timings = { ...this.activeTurnTimings };
      if ((err instanceof WorkerError && err.code === "CANCELLED") || signal?.aborted) {
        await this.resetAndClose();
        this.onSessionStateChange?.(null);
        const cancelled = new WorkerError("Request cancelled", { code: "CANCELLED" });
        throw Object.assign(cancelled, { timings, modelSelection: selection });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !_retriedTokenLimit &&
        !(err instanceof WorkerError && err.code === "MODEL_SELECTION_FAILED") &&
        msg.toLowerCase().includes("exceeds the maximum number of tokens")
      ) {
        this.clearSoftErrorTimer();
        this.clearIdleTimer();
        this.activeSoftErrorAbort = undefined;
        this.activeToolBatchResolve = undefined;
        this.activeTurnCallbacks = undefined;
        this.busy = false;
        await this.resetAndClose();
        return await this.executePrompt(request, callbacks, signal, true, targetModel);
      }
      const error = err instanceof WorkerError ? err : new WorkerError(
        msg,
        classifyUpstreamError(msg) ?? { code: "TRANSPORT_ERROR", rawError: msg },
      );
      const keepsParkedStep =
        error.code !== "MODEL_SELECTION_FAILED" &&
        error.code !== "TIMEOUT" &&
        error.code !== "CANCELLED" &&
        this.awaitingTools.size > 0;
      if (keepsParkedStep) {
        this.lastUsedAt = Date.now();
        this.emitSessionSnapshot(this.committedHashes.length, true);
      } else {
        this.onSessionStateChange?.(null);
      }
      if (
        error.code === "MODEL_SELECTION_FAILED" ||
        error.code === "TIMEOUT" ||
        (this.broker && this.broker.pendingCount > 0) ||
        this.inFlightPromptPromise !== null ||
        (toolsGrewUpdated && this.awaitingTools.size === 0)
      ) {
        await this.resetAndClose();
      }
      throw Object.assign(error, { timings, modelSelection: selection });
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      stopLogPolling?.();
      if (myTurnId === this.activeTurnId) {
        this.clearSoftErrorTimer();
        this.clearIdleTimer();
        this.activeTurnOpen = false;
        this.activeSoftErrorAbort = undefined;
        this.activeToolBatchResolve = undefined;
        this.activeTurnCallbacks = undefined;
        this.streamGuard = null;
        this.stderrBuffer = "";
        this.stderrAbortTriggered = false;
        this.busy = false;
      }
    }
  }

  private async coldStart(
    request: GeminiGenerateRequest,
    configSnapshot?: SensitiveFilterConfig,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      await this.resetAndClose();
      throw new WorkerError("Request cancelled", { code: "CANCELLED" });
    }
    this.activeTurnTimings.coldStart = true;
    this.activeTurnTimings.sessionResumed = false;

    const persisted = this.persistedSession;
    this.persistedSession = null;
    const prewarmed = this.prewarmedTransport;
    this.prewarmedTransport = null;

    const gatewayConfig = getConfig();
    const config = configSnapshot ?? gatewayConfig;
    const effectiveProxy = resolveEffectiveProxy(this.account.proxyUrl, gatewayConfig);

    const canReuseRecycled =
      prewarmed === null &&
      persisted === null &&
      this.transport !== null &&
      this.transport.isAlive() &&
      this.sessionId === null &&
      this.boundProxyUrl === effectiveProxy &&
      this.initCaps !== null;

    if (!canReuseRecycled) {
      await this.resetAndClose();
    }
    if (signal?.aborted) {
      if (prewarmed) {
        await closeAgyTransport(prewarmed.transport, prewarmed.logFile).catch(() => {});
      }
      throw new WorkerError("Request cancelled", { code: "CANCELLED" });
    }

    const declarations = applySensitiveFilterToTools(
      collectToolDeclarations(request),
      config,
    );

    const sanitized = sanitizeToolDeclarations(declarations);
    this.mcpToOriginal = sanitized.mcpToOriginal;

    let mcpServers: Array<Record<string, unknown>> = [];
    if (sanitized.tools.length > 0) {
      this.broker = new SessionToolBroker({
        tools: sanitized.tools,
        onBatchReady: (calls) => {
          this.resetIdleTimer();
          for (const call of calls) {
            this.awaitingTools.set(call.id, call);
          }
          if (this.activeTurnOpen && this.activeToolBatchResolve) {
            for (const call of calls) {
              const part: GeminiPart = {
                functionCall: {
                  id: call.id,
                  name: call.name,
                  args: call.args,
                },
              };
              this.activeTurnParts.push(part);
              this.activeTurnCallbacks?.onPart?.(part);
            }
            this.activeTurnOpen = false;
            this.activeToolBatchResolve();
          } else {
            this.unemittedToolCalls.push(...calls);
          }
        },
      });

      this.registeredMcp = this.mcpServer.registerSession(this.broker);
      mcpServers = [
        {
          name: "agy8048",
          type: "http",
          url: this.registeredMcp.url,
          headers: [],
        },
      ];
    }

    let initCaps: unknown;
    const canAdoptPrewarmed =
      !canReuseRecycled &&
      prewarmed !== null &&
      prewarmed.transport.isAlive() &&
      (prewarmed.envHomeDir === undefined || prewarmed.envHomeDir === this.account.homeDir) &&
      prewarmed.boundProxyUrl === effectiveProxy;

    if (canReuseRecycled) {
      initCaps = this.initCaps;
      this.transport?.onStderr?.((chunk) => this.handleStderrChunk(chunk));
    } else if (canAdoptPrewarmed && prewarmed) {
      prewarmed.bindHandlers?.({
        onUpdate: (params) => this.handleUpdate(params),
        onExit: (code, stderr) => this.handleExit(code, stderr),
      });
      this.transport = prewarmed.transport;
      this.logFile = prewarmed.logFile;
      this.transport.onStderr?.((chunk) => this.handleStderrChunk(chunk));
      this.boundProxyUrl = prewarmed.boundProxyUrl;
      initCaps = prewarmed.initCaps;
      this.initCaps = initCaps;
    } else {
      if (prewarmed) {
        void closeAgyTransport(prewarmed.transport, prewarmed.logFile).catch(() => {});
      }

      if (effectiveProxy && gatewayConfig.strictProxyBinding) {
        const reach = await checkProxyReachable(effectiveProxy);
        if (signal?.aborted) {
          await this.resetAndClose();
          throw new WorkerError("Request cancelled", { code: "CANCELLED" });
        }
        if (!reach.ok) {
          await this.resetAndClose();
          throw new WorkerError(
            `Proxy unreachable (strictProxyBinding=true): ${reach.error ?? effectiveProxy}`,
            {
              code: "TRANSPORT_ERROR",
              rawError: reach.error,
            },
          );
        }
      }

      const spawnStart = performance.now();
      ensureMinimalAgentDefinition(this.workspaceDir);
      const binaryPath = resolveAgyBinary(this.agyPath);
      const env = buildIsolatedAgyEnv({
        homeDir: this.account.homeDir,
        proxyUrl: effectiveProxy,
        agyPath: binaryPath,
      });
      const logFile = createAgyWorkerLogPath(this.account.homeDir);
      const args = buildAgyWorkerArgs({
        homeDir: this.account.homeDir,
        workspaceDir: this.workspaceDir,
        logFile,
      });

      if (!this.tryAcquireWorkerSpawn(this.account.id)) {
        await this.resetAndClose();
        throw new WorkerError(
          `Worker spawn rate limit exceeded for account ${this.account.id}`,
          {
            code: "SOFT_ERROR",
            upstreamStatus: 503,
          },
        );
      }

      this.boundProxyUrl = effectiveProxy;
      try {
        this.transport = this.transportFactory({
          binaryPath,
          args,
          cwd: this.workspaceDir,
          env,
          onUpdate: (params) => this.handleUpdate(params),
          onExit: (code, stderr) => {
            void removeAgyWorkerLog(logFile);
            this.handleExit(code, stderr);
          },
          onStderr: (chunk) => this.handleStderrChunk(chunk),
        });
      } catch (err) {
        await removeAgyWorkerLog(logFile);
        throw err;
      }
      this.logFile = logFile;
      this.transport.onStderr?.((chunk) => this.handleStderrChunk(chunk));
      this.activeTurnTimings.spawnMs = roundMs(performance.now() - spawnStart);

      const initStart = performance.now();
      initCaps = await this.transport.initialize().finally(() => {
        this.activeTurnTimings.initializeMs = roundMs(performance.now() - initStart);
      });
      if (signal?.aborted) {
        await this.resetAndClose();
        throw new WorkerError("Request cancelled", { code: "CANCELLED" });
      }
      this.initCaps = initCaps;
    }

    const nextSysHash = computeSystemHash(request, config);
    const nextToolsHash = computeToolsHash(request, config);
    const nextSensitiveFingerprint = computeSensitiveFilterFingerprint(config);
    const incoming = request.contents ?? [];

    const systemText = applySensitiveFilterToText(
      extractTextFromContent(request.systemInstruction),
      config,
      'system',
    );
    const supportsSystemAppend = Boolean(
      (initCaps as unknown as { raw?: { agentCapabilities?: { _meta?: { antigravity?: { systemPrompt?: { append?: boolean } } } } } })
        ?.raw?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append ?? true
    );
    const meta =
      systemText.trim().length > 0 && supportsSystemAppend
        ? {
            antigravity: {
              systemPrompt: {
                append: systemText,
              },
            },
          }
        : undefined;

    const supportsResume = (initCaps as { sessionCapabilities?: { resume?: boolean } } | null)
      ?.sessionCapabilities?.resume === true;
    const sessionParams = {
      cwd: this.workspaceDir,
      mcpServers,
      ...(meta ? { _meta: meta } : {}),
    };
    const canTryResume = (() => {
      if (!persisted) return false;
      const persistedSummaries = Array.isArray(persisted.committedSummaries)
        ? persisted.committedSummaries
        : [];
      const committedLen =
        persistedSummaries.length > 0
          ? persistedSummaries.length
          : Array.isArray(persisted.committedHashes)
            ? persisted.committedHashes.length
            : 0;
      if (committedLen === 0) return false;
      if (Date.now() - persisted.updatedAt > this.sessionTtlMs) return false;
      if (!supportsResume) return false;
      if (typeof this.transport?.resumeSession !== "function") return false;
      if (persisted.accountId && persisted.accountId !== this.account.id) return false;
      if (nextSensitiveFingerprint !== (persisted.sensitiveFilterFingerprint ?? "")) {
        return false;
      }
      if (nextSysHash !== persisted.systemHash || nextToolsHash !== persisted.toolsHash) {
        return false;
      }
      if (incoming.length <= committedLen) return false;
      if (persistedSummaries.length > 0) {
        const { matchedCount } = findReusablePrefixLength(persistedSummaries, incoming);
        if (matchedCount !== persistedSummaries.length) {
          return false;
        }
      } else if (
        Array.isArray(persisted.committedNormalized) &&
        persisted.committedNormalized.length === persisted.committedHashes.length
      ) {
        for (let i = 0; i < persisted.committedHashes.length; i++) {
          const incomingSummary = summarizeMessageForHistory(incoming[i]);
          if (
            incomingSummary.exactHash !== persisted.committedHashes[i] &&
            incomingSummary.norm !== persisted.committedNormalized[i]
          ) {
            return false;
          }
        }
      } else {
        for (let i = 0; i < persisted.committedHashes.length; i++) {
          if (hashJson(incoming[i]) !== persisted.committedHashes[i]) {
            return false;
          }
        }
      }

      if (persisted.midTurn) {
        const expectedCount = persisted.committedCount ?? committedLen;
        if (expectedCount <= 0 || expectedCount !== committedLen || incoming.length <= expectedCount) {
          return false;
        }
        const parkedTools = persisted.midTurnMeta?.awaitingTools ?? [];
        if (parkedTools.length === 0) {
          return false;
        }
        const parkedIds = new Set(parkedTools.map((t) => t.id));
        const parkedNames = new Set(parkedTools.map((t) => t.name));
        const tail = incoming.slice(expectedCount);
        let matchedToolResponse = false;
        for (const c of tail) {
          for (const p of c.parts ?? []) {
            if (!p.functionResponse) continue;
            if (p.functionResponse.id && parkedIds.has(p.functionResponse.id)) {
              matchedToolResponse = true;
              break;
            }
            if (p.functionResponse.name && parkedNames.has(p.functionResponse.name)) {
              matchedToolResponse = true;
              break;
            }
          }
          if (matchedToolResponse) break;
        }
        if (!matchedToolResponse) {
          return false;
        }
      }
      return true;
    })();

    const sessionSetupStart = performance.now();
    if (canTryResume && persisted && this.transport!.resumeSession) {
      let resumed: Awaited<ReturnType<NonNullable<AcpTransport['resumeSession']>>> | undefined;
      let resumedSessionId: string | null = null;
      this.resumingSession = true;
      try {
        resumed = await this.transport!.resumeSession({
          sessionId: persisted.sessionId,
          ...sessionParams,
        }) ?? {};
        if (signal?.aborted) {
          await this.resetAndClose();
          throw new WorkerError("Request cancelled", { code: "CANCELLED" });
        }
        resumedSessionId = resumed.sessionId || persisted.sessionId;
        this.sessionId = resumedSessionId;
        await this.selectModel(resumed, sessionParams);
        if (signal?.aborted) {
          await this.resetAndClose();
          throw new WorkerError("Request cancelled", { code: "CANCELLED" });
        }
      } catch (err) {
        if (err instanceof WorkerError && err.code === "CANCELLED") {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[acp-worker] session/resume failed for stickyKey=${this.stickyKey ?? "none"} sessionId=${persisted.sessionId}, falling back to session/new: ${msg}`,
        );
        this.sessionId = null;
        resumed = undefined;
        this.onSessionStateChange?.(null);
      } finally {
        this.resumingSession = false;
        this.activeTurnTimings.sessionSetupMs = roundMs(performance.now() - sessionSetupStart);
      }
      if (resumed && resumedSessionId) {
        this.activeTurnTimings.sessionResumed = true;
        this.sessionId = resumedSessionId;
        this.systemInstructionHash = nextSysHash;
        this.toolsHash = nextToolsHash;
        this.sensitiveFilterFingerprint = nextSensitiveFingerprint;
        this.registeredTools = sanitized.tools;
        const persistedSummaries = Array.isArray(persisted.committedSummaries)
          ? persisted.committedSummaries
          : [];
        const committedLen =
          persistedSummaries.length > 0
            ? persistedSummaries.length
            : persisted.committedHashes.length;
        this.committedHashes = [...persisted.committedHashes];
        this.committedSummaries =
          persistedSummaries.length > 0
            ? [...persistedSummaries]
            : incoming.slice(0, committedLen).map((c) => summarizeMessageForHistory(c));
        this.awaitingTools.clear();
        if (persisted.midTurn && persisted.midTurnMeta?.awaitingTools?.length) {
          for (const call of persisted.midTurnMeta.awaitingTools) {
            this.awaitingTools.set(call.id, { ...call });
          }
        }
        return true;
      }
    } else if (persisted) {
      this.onSessionStateChange?.(null);
    }

    const newSessionStart = performance.now();
    const session = await this.transport!.newSession(sessionParams).finally(() => {
      this.activeTurnTimings.sessionSetupMs = roundMs(performance.now() - newSessionStart);
    });
    if (signal?.aborted) {
      await this.resetAndClose();
      throw new WorkerError("Request cancelled", { code: "CANCELLED" });
    }

    if (!session || typeof session.sessionId !== "string" || session.sessionId.trim().length === 0) {
      throw new Error(
        `ACP session/new returned invalid empty sessionId for stickyKey=${this.stickyKey ?? "none"}`,
      );
    }

    this.sessionId = session.sessionId;
    this.stepUsageCursorState = null;
    await this.selectModel(session, supportsResume ? sessionParams : undefined);
    if (signal?.aborted) {
      await this.resetAndClose();
      throw new WorkerError("Request cancelled", { code: "CANCELLED" });
    }
    this.systemInstructionHash = nextSysHash;
    this.toolsHash = nextToolsHash;
    this.sensitiveFilterFingerprint = nextSensitiveFingerprint;
    this.registeredTools = sanitized.tools;
    this.committedSummaries = [];
    this.committedHashes = [];
    this.lastAssistantText = null;
    return false;
  }

  private async selectModel(
    session: unknown,
    verifyParams?: Omit<Parameters<NonNullable<AcpTransport['resumeSession']>>[0], 'sessionId'>,
  ): Promise<void> {
    const initialModel = reportedModel(session);
    this.modelSelection = { confirmedModel: initialModel };
    if (!this.model || initialModel === this.model) return;
    const { sessionId, transport } = this;
    if (!sessionId || !transport?.setModel) {
      throw new WorkerError(`ACP cannot select the requested model ${this.model}`, { code: "MODEL_SELECTION_FAILED" });
    }

    const started = performance.now();
    try {
      let result: unknown;
      try {
        result = await transport.setModel({ sessionId, modelId: this.model });
      } catch (err) {
        throw new WorkerError(`ACP could not switch to the requested model ${this.model}`, {
          code: "MODEL_SELECTION_FAILED",
          rawError: err instanceof Error ? err.message : String(err),
        });
      }
      this.modelSelection = { confirmedModel: reportedModel(result), modelSelectionAcknowledged: true };
      // Some ACP versions acknowledge set_model without returning the selected ID.
      if (!this.modelSelection.confirmedModel && initialModel && verifyParams && transport.resumeSession) {
        this.verifyingModel = true;
        const verified = await transport.resumeSession({ ...verifyParams, sessionId }, 5_000)
          .catch(() => undefined)
          .finally(() => { this.verifyingModel = false; });
        if (verified?.sessionId && verified.sessionId !== sessionId) {
          throw new WorkerError('ACP returned a different session while verifying model selection', { code: "MODEL_SELECTION_FAILED" });
        }
        this.modelSelection.confirmedModel = reportedModel(verified);
      }
      this.assertSelectedModel();
    } finally {
      this.activeTurnTimings.setModelMs = roundMs(performance.now() - started);
    }
  }

  private assertSelectedModel(): void {
    const actual = this.modelSelection.confirmedModel;
    if (actual && this.model && actual !== this.model) {
      throw new WorkerError(`ACP reported model ${actual} for requested model ${this.model}`, { code: "MODEL_SELECTION_FAILED" });
    }
  }

  private recordFirstEventTiming(): void {
    if (
      this.activeTurnPromptStartMs !== null &&
      this.activeTurnTimings.promptToFirstEventMs === undefined
    ) {
      this.activeTurnTimings.promptToFirstEventMs = roundMs(
        performance.now() - this.activeTurnPromptStartMs,
      );
    }
  }

  private handleUpdate(params: Record<string, unknown>): void {
    if (this.verifyingModel) return;
    if (
      typeof params.sessionId === "string" &&
      params.sessionId.length > 0 &&
      params.sessionId !== this.sessionId
    ) {
      return;
    }

    const update = (params.update ?? params) as Record<string, unknown>;
    const type = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
      if (this.resumingSession) return;
      const content = update.content as Record<string, unknown> | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      if (!text) return;

      this.recordFirstEventTiming();
      this.resetIdleTimer();

      // Antigravity CLI emits `⚠ API error (attempt N): ...` (or bare retry hints) when upstream
      // transport/API fails and retries locally. Never let this CLI warning leak into model output.
      let emitText = text;
      if (type === "agent_message_chunk") {
        const isApiErrorNotice =
          CLI_API_ERROR_PREFIX_RE.test(text) || CLI_BARE_API_ERROR_PREFIX_RE.test(text);
        const isCliWarning = CLI_WARNING_PREFIX_RE.test(text);
        const isRetry429Hint = RETRY_429_HINT_RE.test(text);

        if (isApiErrorNotice || isCliWarning || isRetry429Hint) {
          const classified = classifyUpstreamError(text);
          if (classified?.code === "QUOTA_EXHAUSTED") {
            this.handleInternal429Retry(text, classified);
            return;
          }
          if (isApiErrorNotice) {
            const fallbackClassified = classified ?? {
              code: "TRANSPORT_ERROR" as const,
              upstreamStatus: 502,
            };
            if (!this.activeTurnParts.some(isEffectiveOutputPart)) {
              this.abortTurnImmediately(text, fallbackClassified);
            }
            return;
          }
          if (
            isCliWarning &&
            !this.activeTurnParts.some(isEffectiveOutputPart) &&
            classified &&
            FAST_ABORT_ERROR_CODES.has(classified.code)
          ) {
            this.abortTurnImmediately(text, classified);
            return;
          }
        }

        if (this.streamGuard) {
          const guarded = this.streamGuard.push(text);
          if (guarded.quotaError) {
            if (guarded.emit) {
              const part: GeminiPart = { text: guarded.emit };
              this.activeTurnParts.push(part);
              this.activeTurnCallbacks?.onPart?.(part);
            }
            const retryAfterMs =
              guarded.quotaError.retryAfterSec !== undefined
                ? guarded.quotaError.retryAfterSec * 1000
                : undefined;
            this.abortTurnImmediately(guarded.quotaError.message, {
              code: "QUOTA_EXHAUSTED",
              upstreamStatus: 429,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
            return;
          }
          if (!guarded.emit) {
            return;
          }
          emitText = guarded.emit;
        }
      }

      // Model output (including thoughts) is data, not an upstream error signal.
      // Only explicit error frames and transport failures enter error classification.
      const part: GeminiPart =
        type === "agent_thought_chunk"
          ? { text: emitText, thought: true }
          : { text: emitText };
      this.activeTurnParts.push(part);
      this.activeTurnCallbacks?.onPart?.(part);
      return;
    }

    if (type === "tool_call" || type === "tool_call_update") {
      this.resetIdleTimer();
      return;
    }

    if (type === "error") {
      this.recordFirstEventTiming();
      this.resetIdleTimer();
      const msg =
        typeof update.message === "string"
          ? update.message
          : JSON.stringify(update);
      const classified = classifyUpstreamError(msg) ?? {
        code: "SOFT_ERROR" as const,
        upstreamStatus: 502,
      };
      if (classified.code === "QUOTA_EXHAUSTED") {
        if (this.handleInternal429Retry(msg, classified)) {
          return;
        }
      }
      if (
        classified.code === "CAPACITY_UNAVAILABLE" ||
        classified.code === "TRANSPORT_ERROR"
      ) {
        this.abortTurnImmediately(msg, classified);
        return;
      }
      this.scheduleSoftErrorCutoff(msg, classified);
    }
  }

  private handleInternal429Retry(
    rawText: string,
    classified: { code: WorkerErrorCode; upstreamStatus: number; retryAfterMs?: number },
  ): boolean {
    this.internal429RetryCount += 1;
    if (this.activeTurnParts.some(isEffectiveOutputPart)) {
      return false;
    }
    const threshold = getConfig().maxInternal429RetriesBeforeCancel;
    if (this.internal429RetryCount < threshold) {
      return false;
    }

    this.clearSoftErrorTimer();
    const err = new WorkerError(rawText, {
      code: classified.code,
      upstreamStatus: classified.upstreamStatus,
      retryAfterMs: classified.retryAfterMs,
      rawError: rawText,
    });
    const abort = this.activeSoftErrorAbort;
    this.activeSoftErrorAbort = undefined;
    const transport = this.transport;
    const sessionId = this.sessionId;
    if (transport && sessionId) {
      this.sessionId = null;
      void transport
        .cancel(sessionId)
        .catch(() => {})
        .finally(() => {
          void this.resetAndClose();
        });
    } else {
      void this.resetAndClose();
    }
    abort?.(err);
    return true;
  }

  private pollPromptLog(): (() => void) | undefined {
    const log = this.promptLog;
    if (!log) return;

    let stopped = false;
    const buffer = Buffer.allocUnsafe(MAX_LOG_READ_BYTES);
    const isCurrentTurn = () => !stopped && this.promptLog === log &&
      this.activeTurnOpen && Boolean(this.activeSoftErrorAbort);
    const timer = setInterval(async () => {
      if (log.reading || !isCurrentTurn()) return;
      log.reading = true;
      try {
        const file = await open(log.file, "r");
        const { bytesRead } = await file.read(buffer, 0, buffer.length, log.offset)
          .finally(() => file.close());
        if (!isCurrentTurn()) return;

        const complete = buffer.subarray(0, bytesRead);
        const lastNewline = complete.lastIndexOf(0x0a);
        if (lastNewline === -1) return;
        log.offset += lastNewline + 1;

        for (const line of complete.toString("utf8", 0, lastNewline).split("\n")) {
          const detail = AGY_RETRY_LOG_RE.exec(line)?.[1];
          if (detail && /code 429\b/i.test(detail) && /resource has been exhausted/i.test(detail)) {
            this.abortTurnImmediately(`RESOURCE_EXHAUSTED: ${detail}`, {
              code: "QUOTA_EXHAUSTED",
              upstreamStatus: 429,
            });
            break;
          }
        }
      } catch {
        // The CLI may not have created the log yet, and mocks need not create it.
      } finally {
        log.reading = false;
      }
    }, this.logPollIntervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private handleStderrChunk(chunk: string): void {
    if (!chunk) return;
    if (!this.busy || this.stderrAbortTriggered) return;
    if (!this.activeSoftErrorAbort) return;
    if (this.activeTurnParts.some(isEffectiveOutputPart)) return;

    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > 4096) {
      this.stderrBuffer = this.stderrBuffer.slice(-4096);
    }

    const classified = classifyUpstreamError(this.stderrBuffer);
    if (classified?.code === "CAPACITY_UNAVAILABLE") {
      this.stderrAbortTriggered = true;
      const line =
        this.stderrBuffer
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .find((l) => classifyUpstreamError(l)?.code === "CAPACITY_UNAVAILABLE") ??
        this.stderrBuffer.trim();
      this.stderrBuffer = "";
      this.abortTurnImmediately(line, classified);
    }
  }

  private abortTurnImmediately(
    rawText: string,
    classified: { code: WorkerErrorCode; upstreamStatus: number; retryAfterMs?: number },
  ): void {
    this.clearSoftErrorTimer();
    const err = new WorkerError(rawText, {
      code: classified.code,
      upstreamStatus: classified.upstreamStatus,
      retryAfterMs: classified.retryAfterMs,
      rawError: rawText,
    });
    const abort = this.activeSoftErrorAbort;
    this.activeSoftErrorAbort = undefined;
    void this.resetAndClose();
    abort?.(err);
  }

  private scheduleSoftErrorCutoff(
    rawText: string,
    classified: { code: WorkerErrorCode; upstreamStatus: number; retryAfterMs?: number },
  ): void {
    if (this.softErrorTimer) return;
    this.softErrorTimer = setTimeout(() => {
      this.softErrorTimer = null;
      const err = new WorkerError(rawText, {
        code: classified.code,
        upstreamStatus: classified.upstreamStatus,
        retryAfterMs: classified.retryAfterMs,
        rawError: rawText,
      });
      void this.resetAndClose();
      this.activeSoftErrorAbort?.(err);
    }, Math.min(this.softErrorCutoffMs, 2800));
  }

  private clearSoftErrorTimer(): void {
    if (this.softErrorTimer) {
      clearTimeout(this.softErrorTimer);
      this.softErrorTimer = null;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.busy || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const err = new WorkerError("Stream idle timeout", {
        code: "TIMEOUT",
        upstreamStatus: 504,
      });
      const abort = this.activeSoftErrorAbort;
      void this.resetAndClose();
      abort?.(err);
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private handleExit(code: number | null, stderr: string): void {
    if (this.busy && this.activeSoftErrorAbort) {
      const classified = classifyUpstreamError(stderr) ?? {
        code: "TRANSPORT_ERROR" as const,
        upstreamStatus: 502,
      };
      this.activeSoftErrorAbort(
        new WorkerError(`agy worker exited (${code}): ${stderr}`, {
          ...classified,
          rawError: stderr,
        }),
      );
    }
  }

  async recycleSession(): Promise<boolean> {
    if (
      this.busy ||
      !this.transport ||
      !this.transport.isAlive() ||
      this.awaitingTools.size > 0 ||
      this.unemittedToolCalls.length > 0 ||
      (this.broker && this.broker.pendingCount > 0) ||
      this.inFlightPromptPromise !== null
    ) {
      return false;
    }

    const sid = this.sessionId;
    if (sid) {
      if (typeof this.transport.closeSession !== "function") {
        return false;
      }
      try {
        await this.transport.closeSession(sid);
      } catch {
        return false;
      }
    }

    this.sessionId = null;
    this.promptLog = undefined;
    this.modelSelection = {};
    this.stepUsageCursorState = null;
    this.clearSoftErrorTimer();
    this.clearIdleTimer();
    this.activeTurnOpen = false;
    this.resumingSession = false;
    this.internal429RetryCount = 0;
    this.stderrBuffer = "";
    this.stderrAbortTriggered = false;
    this.unemittedToolCalls = [];
    this.activeToolBatchResolve = undefined;
    this.awaitingTools.clear();
    this.committedSummaries = [];
    this.committedHashes = [];
    this.pendingRequestedModel = undefined;
    this.lastAssistantText = null;
    this.systemInstructionHash = "";
    this.toolsHash = "";
    this.sensitiveFilterFingerprint = "";
    this.mcpToOriginal.clear();
    this.registeredTools = [];
    this.persistedSession = null;
    this.stickyKey = undefined;
    this.onSessionStateChange = undefined;

    if (this.broker) {
      this.broker.cancelAllPending("Session recycled");
      this.broker = null;
    }
    if (this.registeredMcp) {
      this.registeredMcp.unregister();
      this.registeredMcp = null;
    }

    return true;
  }

  async resetAndClose(): Promise<void> {
    this.modelSelection = {};
    this.stepUsageCursorState = null;
    this.initCaps = null;
    this.clearSoftErrorTimer();
    this.clearIdleTimer();
    this.inFlightPromptPromise = null;
    this.promptLog = undefined;
    this.activeTurnOpen = false;
    this.resumingSession = false;
    this.internal429RetryCount = 0;
    this.stderrBuffer = "";
    this.stderrAbortTriggered = false;
    this.unemittedToolCalls = [];
    this.activeToolBatchResolve = undefined;
    this.awaitingTools.clear();
    this.committedSummaries = [];
    this.committedHashes = [];
    this.pendingRequestedModel = undefined;
    this.lastAssistantText = null;
    this.systemInstructionHash = "";
    this.toolsHash = "";
    this.sensitiveFilterFingerprint = "";
    this.registeredTools = [];

    if (this.broker) {
      this.broker.cancelAllPending("Worker reset");
      this.broker = null;
    }
    if (this.registeredMcp) {
      this.registeredMcp.unregister();
      this.registeredMcp = null;
    }
    if (this.prewarmedTransport) {
      const pw = this.prewarmedTransport;
      this.prewarmedTransport = null;
      await closeAgyTransport(pw.transport, pw.logFile).catch(() => {});
    }
    if (this.transport) {
      const t = this.transport;
      const logFile = this.logFile;
      this.transport = null;
      this.logFile = undefined;
      this.boundProxyUrl = undefined;
      const sid = this.sessionId;
      this.sessionId = null;
      try {
        if (sid) await t.cancel(sid).catch(() => {});
        await closeAgyTransport(t, logFile);
      } catch {}
    }
    this.boundProxyUrl = undefined;
  }
}
