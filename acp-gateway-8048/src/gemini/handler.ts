import { randomUUID } from 'node:crypto';
import { checkProxyReachable } from '../accounts/exit-probe';
import { buildIsolatedAgyEnv, resolveAgyBinary } from '../acp/env';
import { isSuggestionModeRequest } from '../acp/suggestion-guard';
import { WorkerError, type WorkerModelSelection } from '../acp/worker';
import { getConfig, resolveEffectiveProxy } from '../config/settings';
import { store } from '../db/store';
import { eventBus } from '../logs/events';
import type {
  AccountRecord,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  PhaseTimingsMs,
  RequestAttempt,
} from '../types';
import {
  GeminiProtocolError,
  computeSessionHash,
  estimateTokens,
  formatSseChunk,
  getGoogleRpcStatus,
  getModelFamily,
  normalizeModelName,
  resolveGatewayModel,
  resolveSessionKey,
  validateAndParseGeminiRequest,
} from './protocol';

export interface WorkerGenerateParams {
  model: string;
  request: GeminiGenerateRequest;
  sessionHash: string;
  stream: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: GeminiGenerateResponse) => void;
}

export interface WorkerHandle {
  id: string;
  accountId: string;
  generate(params: WorkerGenerateParams): Promise<
    GeminiGenerateResponse & {
      cacheHit?: boolean;
      cachedTokens?: number;
      timings?: Partial<PhaseTimingsMs>;
      modelSelection?: WorkerModelSelection;
    }
  >;
}

export interface WorkerPoolLike {
  acquire(params: {
    account: AccountRecord;
    sessionHash: string;
    model: string;
    request: GeminiGenerateRequest;
    stateless?: boolean;
  }): Promise<WorkerHandle>;
  release(worker: WorkerHandle): void;
}

export interface SchedulerSelectResult {
  account: AccountRecord | null;
  retryAfterSeconds?: number;
  queueTimedOut?: boolean;
  release?: () => void;
  onWorkerAcquired?: () => void;
}

export interface SchedulerLike {
  selectAccount(params: {
    family: string;
    sessionHash: string;
    excludeAccountIds: string[];
    signal: AbortSignal;
  }): Promise<SchedulerSelectResult> | SchedulerSelectResult;
  selectFallbackAccount?(params: {
    accountId: string;
    family: string;
    sessionHash: string;
    signal: AbortSignal;
  }): Promise<SchedulerSelectResult> | SchedulerSelectResult;
  reportSuccess?(
    accountId: string,
    family: string,
    sessionHash: string,
    usage?: { inputTokens?: number; cachedTokens?: number }
  ): void;
  abandonSession?(sessionHash: string, family: string): void;
  reportFailure?(params: {
    accountId: string;
    family: string;
    status?: number;
    reasonCode?: string;
    errorMessage?: string;
    isQuotaError?: boolean;
    retryAfterMs?: number;
  }): { retryAfterSeconds?: number } | void;
  releaseSlot?(accountId: string): void;
}

export interface GeminiHandlerDeps {
  scheduler?: SchedulerLike;
  workerPool?: WorkerPoolLike;
  inFlightControllers?: Map<string, AbortController>;
}

const SUPPORTED_METHODS = ['generateContent', 'streamGenerateContent', 'countTokens'];

export interface ModelLimitEntry {
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export type ModelLimitsMap = Record<string, ModelLimitEntry>;

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function getModelLimitsMap(): ModelLimitsMap {
  return store.getConfigValue<ModelLimitsMap>('model_limits') ?? {};
}

function buildModelEntry(
  id: string,
  displayName?: string,
  limitsMap: ModelLimitsMap = getModelLimitsMap()
) {
  const label =
    displayName ||
    id
      .split('-')
      .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
      .join(' ');
  const custom = limitsMap[id];
  const entry: {
    name: string;
    version: string;
    displayName: string;
    description: string;
    supportedGenerationMethods: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
  } = {
    name: `models/${id}`,
    version: '001',
    displayName: label,
    description: `${label} via Antigravity ACP`,
    supportedGenerationMethods: SUPPORTED_METHODS,
  };
  if (isPositiveSafeInt(custom?.inputTokenLimit)) {
    entry.inputTokenLimit = custom.inputTokenLimit;
  }
  if (isPositiveSafeInt(custom?.outputTokenLimit)) {
    entry.outputTokenLimit = custom.outputTokenLimit;
  }
  return entry;
}

const STATIC_MODEL_IDS = [
  // agy.exe models
  'gemini-4-argon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-4-hydrogen-low',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-xhigh',
  'gemini-4-neon',
  'gemini-4-neon-low',
  'gemini-4-neon-medium',
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
];

export const SUPPORTED_GEMINI_MODELS = STATIC_MODEL_IDS.map((id) => buildModelEntry(id));

const MODEL_DISCOVERY_TTL_MS = 5 * 60 * 1000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
let cachedModels: typeof SUPPORTED_GEMINI_MODELS | null = null;
let cachedModelsAt = 0;
let modelsRefreshInFlight: Promise<void> | null = null;

export function parseAgyModelsOutput(stdout: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith('#') ||
      line.startsWith('---') ||
      /^fetching\b/i.test(line) ||
      /^loading\b/i.test(line) ||
      /^model(s|\s+id)?(\s|$)/i.test(line) ||
      /^id(\s|$)/i.test(line)
    ) {
      continue;
    }
    const tabIdx = line.indexOf('\t');
    const firstCol = tabIdx >= 0 ? line.slice(0, tabIdx).trim() : (line.split(/\s+/)[0] ?? '');
    const token = firstCol.replace(/^models\//, '');
    if (
      token &&
      !/\.\./.test(token) &&
      !token.endsWith('.') &&
      /^[a-z0-9][a-z0-9._-]+$/i.test(token) &&
      !seen.has(token)
    ) {
      seen.add(token);
      ids.push(token);
    }
  }
  return ids;
}

/**
 * Spawn `agy models` in a fully bounded, non-throwing way. It never rejects and
 * never resolves later than MODEL_DISCOVERY_TIMEOUT_MS, so a hung, slow or
 * crashing agy.exe can never stall or break the caller.
 */
function spawnAgyModelsList(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    let settled = false;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (ids: string[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ids);
    };

    void (async () => {
      try {
        const readyAccount = store.listAccounts().find((acc) => acc.status === 'ready');
        if (!readyAccount) {
          settle([]);
          return;
        }
        const cfg = getConfig();
        const effectiveProxy = resolveEffectiveProxy(readyAccount.proxyUrl, cfg);
        if (effectiveProxy && cfg.strictProxyBinding) {
          const reach = await checkProxyReachable(effectiveProxy);
          if (!reach.ok) {
            settle([]);
            return;
          }
        }
        const binaryPath = resolveAgyBinary(cfg.agyPath);
        const env = buildIsolatedAgyEnv({
          homeDir: readyAccount.homeDir,
          proxyUrl: effectiveProxy,
          agyPath: binaryPath,
        });
        proc = Bun.spawn([binaryPath, 'models'], {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        timer = setTimeout(() => {
          try {
            proc?.kill();
          } catch {
            // ignore
          }
          settle([]);
        }, MODEL_DISCOVERY_TIMEOUT_MS);
        if (proc.stdout && typeof proc.stdout !== 'number') {
          new Response(proc.stdout)
            .text()
            .then((stdout) => settle(parseAgyModelsOutput(stdout)))
            .catch(() => settle([]));
        } else {
          settle([]);
        }
        // Never surface the child's exit as an unhandled rejection.
        void proc.exited.catch(() => {});
      } catch {
        settle([]);
      }
    })();
  });
}

export type ModelsFetcher = () => Promise<string[]>;
let modelsFetcher: ModelsFetcher = spawnAgyModelsList;

export function setModelsFetcherForTest(fetcher: ModelsFetcher | null): void {
  modelsFetcher = fetcher ?? spawnAgyModelsList;
}

export function resetModelCatalogCacheForTest(): void {
  cachedModels = null;
  cachedModelsAt = 0;
  modelsRefreshInFlight = null;
}

export async function refreshModelCatalogOnce(fetcher: ModelsFetcher = modelsFetcher): Promise<void> {
  try {
    const ids = await fetcher();
    if (ids.length > 0) {
      cachedModels = ids.map((id) => buildModelEntry(id));
      cachedModelsAt = Date.now();
      return;
    }
  } catch {
    // Keep the previous (or static) catalog on any discovery failure.
  }
  if (!cachedModels) {
    cachedModels = SUPPORTED_GEMINI_MODELS;
    cachedModelsAt = Date.now();
  }
}

export function isForceRefresh(url: URL): boolean {
  const val = url.searchParams.get('refresh')?.trim().toLowerCase();
  return val === '1' || val === 'true';
}

/** Refresh the cached catalog off the request path; single-flight per process. */
function refreshModelsInBackground(): Promise<void> {
  if (!modelsRefreshInFlight) {
    modelsRefreshInFlight = refreshModelCatalogOnce().finally(() => {
      modelsRefreshInFlight = null;
    });
  }
  return modelsRefreshInFlight;
}

/**
 * Return the model catalog.
 * - When `forceRefresh` is false (default), discovery never sits on the request
 *   path: when the cache is stale a background refresh is kicked off and the
 *   current/static list is returned right away.
 * - When `forceRefresh` is true (e.g. `?refresh=1`), waits for the single-flight
 *   discovery (bounded by MODEL_DISCOVERY_TIMEOUT_MS) before returning.
 */
export async function discoverAgyModels(forceRefresh = false): Promise<ReturnType<typeof buildModelEntry>[]> {
  const now = Date.now();
  const isFresh = cachedModels !== null && now - cachedModelsAt < MODEL_DISCOVERY_TTL_MS;
  if (forceRefresh) {
    await refreshModelsInBackground();
  } else if (!isFresh) {
    void refreshModelsInBackground();
  }
  const base = cachedModels ?? SUPPORTED_GEMINI_MODELS;
  const limitsMap = getModelLimitsMap();
  const entries = base.map((m) => {
    const id = m.name.replace(/^models\//, '');
    return buildModelEntry(id, m.displayName, limitsMap);
  });
  const hasNeonVariant = entries.some((m) => /^models\/gemini-4-neon-.+/i.test(m.name));
  const hasBareNeon = entries.some((m) => m.name.toLowerCase() === 'models/gemini-4-neon');
  if (hasNeonVariant && !hasBareNeon) {
    entries.push(buildModelEntry('gemini-4-neon', undefined, limitsMap));
  }
  return entries;
}

export function extractApiKey(req: Request, url: URL): string {
  const xGoog = req.headers.get('x-goog-api-key');
  if (xGoog) return xGoog.trim();

  const queryKey = url.searchParams.get('key');
  if (queryKey) return queryKey.trim();

  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return '';
}

function jsonError(
  status: number,
  message: string,
  statusText = getGoogleRpcStatus(status),
  headers?: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message,
        status: statusText,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...headers,
      },
    }
  );
}

function maskAccountLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return 'unknown';
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 1) {
    const local = trimmed.slice(0, atIdx);
    const domain = trimmed.slice(atIdx);
    return `${local.slice(0, 2)}***${domain}`;
  }
  return trimmed.length > 6 ? `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}` : trimmed;
}

function enrichChunk(
  chunk: GeminiGenerateResponse,
  model: string,
  responseId: string
): GeminiGenerateResponse {
  const {
    cacheHit: _cacheHit,
    cachedTokens: _cachedTokens,
    timings: _timings,
    modelSelection: _modelSelection,
    ...rest
  } = chunk as Awaited<ReturnType<WorkerHandle['generate']>>;
  return {
    ...rest,
    modelVersion: rest.modelVersion ?? model,
    responseId: rest.responseId ?? responseId,
  };
}

function hasEffectiveContent(chunk: GeminiGenerateResponse, includeThought: boolean): boolean {
  for (const cand of chunk.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        if (includeThought || !part.thought) {
          return true;
        }
      }
      if (part.functionCall || part.inlineData || part.functionResponse) {
        return true;
      }
    }
  }
  return false;
}

function measureResponseTextLengths(resp: GeminiGenerateResponse): {
  outputTextLength: number;
  thoughtTextLength: number;
} {
  let outputTextLength = 0;
  let thoughtTextLength = 0;
  for (const cand of resp.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (typeof part.text === 'string') {
        if (part.thought === true) {
          thoughtTextLength += part.text.length;
        } else {
          outputTextLength += part.text.length;
        }
      }
    }
  }
  return { outputTextLength, thoughtTextLength };
}

function buildUsageMetadata(
  req: GeminiGenerateRequest,
  existing?: GeminiGenerateResponse['usageMetadata'],
  outputTextLength = 0,
  thoughtTextLength = 0
): NonNullable<GeminiGenerateResponse['usageMetadata']> {
  const promptTokenCount = existing?.promptTokenCount ?? estimateTokens(req);
  const candidatesTokenCount =
    existing?.candidatesTokenCount ??
    (outputTextLength > 0 ? Math.max(1, Math.ceil(outputTextLength / 4)) : 0);
  const thoughtsTokenCount =
    existing?.thoughtsTokenCount ??
    (thoughtTextLength > 0 ? Math.ceil(thoughtTextLength / 4) : 0);
  const totalTokenCount =
    existing?.totalTokenCount ?? promptTokenCount + candidatesTokenCount + thoughtsTokenCount;
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount,
    thoughtsTokenCount,
    ...(typeof existing?.cachedContentTokenCount === 'number' && existing.cachedContentTokenCount > 0
      ? { cachedContentTokenCount: existing.cachedContentTokenCount }
      : {}),
  };
}

function isLocationUnsupportedError(reasonCode?: string, reasonText?: string): boolean {
  if (reasonCode === 'LOCATION_UNSUPPORTED') return true;
  if (!reasonText) return false;
  return /location[_ ]is[_ ]not[_ ]supported|location[_ ]unsupported/i.test(reasonText);
}

function getNoRetryHeaders(
  status: number,
  reasonCode?: string,
  reasonText?: string
): Record<string, string> | undefined {
  if (isLocationUnsupportedError(reasonCode, reasonText)) return undefined;
  if (
    status === 403 ||
    reasonCode === 'VALIDATION_REQUIRED' ||
    reasonCode === 'RESTRICTED' ||
    reasonCode === 'ACCOUNT_DISABLED_REFUSED'
  ) {
    return { 'x-should-retry': 'false' };
  }
  return undefined;
}

function classifyError(err: unknown): {
  status: number;
  reasonCode: string;
  reasonText: string;
  isQuotaError: boolean;
  retryable: boolean;
  retryAfterMs?: number;
} {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof WorkerError) {
    const status =
      err.upstreamStatus ??
      (err.code === 'QUOTA_EXHAUSTED'
        ? 429
        : err.code === 'CAPACITY_UNAVAILABLE'
          ? 503
          : err.code === 'AUTH_REQUIRED'
            ? 401
            : err.code === 'VALIDATION_REQUIRED' ||
                err.code === 'RESTRICTED' ||
                (err.code as string) === 'ACCOUNT_DISABLED_REFUSED'
              ? 403
              : err.code === 'CANCELLED'
                ? 499
                : err.code === 'TIMEOUT'
                  ? 504
                  : 502);
    const isQuotaError = err.code === 'QUOTA_EXHAUSTED' || status === 429;
    // 账号级模型清单拉取失败（CLI 拉不到 availableModels 时报 Unknown model ID）不是"请求本身非法"，
    // 换一个号往往就能成功，因此允许按可重试处理，由调用方决定最多再试几个号。
    const modelSelectionRecoverable =
      err.code === 'MODEL_SELECTION_FAILED' &&
      /unknown model id/i.test(`${message} ${err.rawError ?? ''}`);
    const retryable =
      (err.code !== 'MODEL_SELECTION_FAILED' || modelSelectionRecoverable) &&
      (isQuotaError ||
      err.code === 'CAPACITY_UNAVAILABLE' ||
      err.code === 'AUTH_REQUIRED' ||
      err.code === 'VALIDATION_REQUIRED' ||
      err.code === 'RESTRICTED' ||
      (err.code as string) === 'ACCOUNT_DISABLED_REFUSED' ||
      err.code === 'SOFT_ERROR' ||
      err.code === 'TRANSPORT_ERROR' ||
      err.code === 'TIMEOUT' ||
      status === 403 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
    return {
      status,
      reasonCode: isQuotaError
        ? 'RESOURCE_EXHAUSTED'
        : err.code === 'CAPACITY_UNAVAILABLE'
          ? 'UNAVAILABLE'
          : err.code,
      reasonText: message.slice(0, 300),
      isQuotaError,
      retryable,
      retryAfterMs: err.retryAfterMs,
    };
  }
  const lower = message.toLowerCase();
  const status =
    (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { status?: number })?.status ??
    (lower.includes('429') || lower.includes('quota') || lower.includes('resource_exhausted')
      ? 429
      : lower.includes('401') || lower.includes('403') || lower.includes('auth')
        ? 403
        : 500);

  const isQuotaError =
    status === 429 ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted');

  const retryable =
    isQuotaError ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('eof') ||
    lower.includes('socket hang up') ||
    lower.includes('terminated') ||
    lower.includes('epipe') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed');

  return {
    status,
    reasonCode: isQuotaError ? 'RESOURCE_EXHAUSTED' : status === 403 ? 'PERMISSION_DENIED' : 'INTERNAL',
    reasonText: message.slice(0, 300),
    isQuotaError,
    retryable,
  };
}

export function applyGenerationConfigGuardrails(
  req: GeminiGenerateRequest,
  outputTokenLimit?: number
): void {
  const genConfig = req.generationConfig;
  if (!genConfig || typeof genConfig !== 'object') {
    return;
  }
  const maxOutputTokens =
    typeof genConfig.maxOutputTokens === 'number' && Number.isFinite(genConfig.maxOutputTokens)
      ? genConfig.maxOutputTokens
      : undefined;
  const thinkingConfig =
    genConfig.thinkingConfig && typeof genConfig.thinkingConfig === 'object'
      ? (genConfig.thinkingConfig as Record<string, unknown>)
      : undefined;
  const thinkingBudget =
    thinkingConfig &&
    typeof thinkingConfig.thinkingBudget === 'number' &&
    Number.isFinite(thinkingConfig.thinkingBudget)
      ? thinkingConfig.thinkingBudget
      : undefined;

  if (
    maxOutputTokens !== undefined &&
    thinkingBudget !== undefined &&
    thinkingBudget > 0 &&
    maxOutputTokens < thinkingBudget
  ) {
    const expanded = thinkingBudget + Math.max(maxOutputTokens, 1024);
    genConfig.maxOutputTokens =
      typeof outputTokenLimit === 'number' && Number.isFinite(outputTokenLimit) && outputTokenLimit > 0
        ? Math.min(outputTokenLimit, expanded)
        : expanded;
  }
}

export function createGeminiHandler(deps: GeminiHandlerDeps = {}) {
  const inFlight = deps.inFlightControllers ?? new Map<string, AbortController>();

  return async function handleGeminiRequest(req: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith('/v1beta')) {
      return null;
    }

    const config = getConfig();
    if (config.apiKey) {
      const provided = extractApiKey(req, url);
      if (!provided || provided !== config.apiKey) {
        return jsonError(401, 'Invalid or missing API key', 'UNAUTHENTICATED');
      }
    }

    // GET /v1beta/models
    if (req.method === 'GET' && (url.pathname === '/v1beta/models' || url.pathname === '/v1beta/models/')) {
      return Response.json({ models: await discoverAgyModels(isForceRefresh(url)) });
    }

    // GET /v1beta/models/{model}
    if (req.method === 'GET' && url.pathname.startsWith('/v1beta/models/')) {
      const rawModel = url.pathname.slice('/v1beta/models/'.length);
      if (rawModel && !rawModel.includes(':')) {
        const decodedModel = normalizeModelName(decodeURIComponent(rawModel));
        const modelId = resolveGatewayModel(decodedModel);
        const models = await discoverAgyModels();
        const found =
          models.find((m) => m.name === `models/${decodedModel}`) ??
          models.find((m) => m.name === `models/${modelId}`);
        if (!found) {
          return jsonError(404, `Model 'models/${modelId}' not found`, 'NOT_FOUND');
        }
        return Response.json(found);
      }
    }

    // POST /v1beta/models/{model}:{action}
    if (req.method === 'POST' && url.pathname.startsWith('/v1beta/models/')) {
      const rest = url.pathname.slice('/v1beta/models/'.length);
      const colonIdx = rest.lastIndexOf(':');
      if (colonIdx <= 0) {
        return jsonError(404, `Unknown Gemini endpoint: ${url.pathname}`, 'NOT_FOUND');
      }

      const requestedModel = decodeURIComponent(rest.slice(0, colonIdx));
      const action = rest.slice(colonIdx + 1);

      let rawBody: unknown;
      try {
        rawBody = await req.json();
      } catch {
        return jsonError(400, 'Invalid JSON request body');
      }

      let parsedReq: GeminiGenerateRequest;
      try {
        parsedReq = validateAndParseGeminiRequest(rawBody, config.maxImagesPerRequest);
      } catch (err) {
        if (err instanceof GeminiProtocolError) {
          return jsonError(err.statusCode, err.message, err.reasonCode);
        }
        return jsonError(400, err instanceof Error ? err.message : 'Invalid request');
      }

      const model = resolveGatewayModel(requestedModel, {
        thinkingConfig: parsedReq.generationConfig?.thinkingConfig as Record<string, unknown> | undefined,
      });

      if (action === 'countTokens') {
        return Response.json({ totalTokens: estimateTokens(parsedReq) });
      }

      if (action !== 'generateContent' && action !== 'streamGenerateContent') {
        return jsonError(404, `Unsupported action: ${action}`, 'NOT_FOUND');
      }

      applyGenerationConfigGuardrails(parsedReq, getModelLimitsMap()[model]?.outputTokenLimit);

      if (isSuggestionModeRequest(parsedReq.contents)) {
        const guardResponseId = `resp_${randomUUID()}`;
        const guardSessionHash = resolveSessionKey(parsedReq, req.headers);
        const emptyResp = enrichChunk(
          {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: '' }] },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          model,
          guardResponseId
        );
        emptyResp.usageMetadata = buildUsageMetadata(parsedReq, undefined, 0, 0);
        if (action !== 'streamGenerateContent') {
          return Response.json(emptyResp, {
            headers: {
              'X-Accel-Buffering': 'no',
              'X-Mapped-Model': model,
              'X-Session-Id': guardSessionHash,
            },
          });
        }
        const altSse = url.searchParams.get('alt') === 'sse';
        const body = altSse ? formatSseChunk(emptyResp) : `[${JSON.stringify(emptyResp)}]`;
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': altSse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Mapped-Model': model,
            'X-Session-Id': guardSessionHash,
          },
        });
      }

      if (!deps.scheduler || !deps.workerPool) {
        return jsonError(503, 'Gateway scheduler or worker pool is not initialized', 'UNAVAILABLE');
      }

      const isStream = action === 'streamGenerateContent';
      const family = getModelFamily(model);
      const sessionHash = resolveSessionKey(parsedReq, req.headers);
      const requestId = randomUUID();
      const startedAt = Date.now();
      const abortController = new AbortController();
      inFlight.set(requestId, abortController);
      const onReqAbort = () => {
        abortController.abort();
      };
      if (req.signal) {
        if (req.signal.aborted) {
          abortController.abort();
        } else {
          req.signal.addEventListener('abort', onReqAbort, { once: true });
        }
      }

      eventBus.startRequest({
        id: requestId,
        model,
        family,
        endpoint: url.pathname,
        stream: isStream,
        startedAt,
      });

      const excludeAccountIds: string[] = [];
      let nonQuotaSwitches = 0;
      let quotaSwitches = 0;
      let modelSelectionSwitches = 0;
      let attemptIndex = 0;
      let earliestRetryAt: number | undefined;
      const responseId = `resp_${requestId}`;
      let selectedAccountLabel = '';
      let cancellationLogged = false;
      // (c) 单号池容错：记录刚刚以 EMPTY_OR_THOUGHT_ONLY_RESPONSE 失败的账号。
      // 重试循环优先换号；只有当池中确实已无其他可用账号时，才回来对该账号放行 1 次同号重建重试。
      let pendingThoughtOnlyAccount: AccountRecord | null = null;
      let sameAccountThoughtRetryUsed = false;
      // 池中真的无号可用时，回最后一个真实失败原因（例如 502 SOFT_ERROR），而不是笼统的 429。
      let lastClassifiedFailure: { status: number; reasonCode: string; reasonText: string } | null = null;
      const cancelRequest = () => {
        if (!cancellationLogged) {
          cancellationLogged = true;
          eventBus.finishRequest(requestId, { state: 'cancelled', httpStatus: 499 });
        }
        return { errorResponse: jsonError(499, 'Request cancelled', 'CANCELLED') };
      };

      const executeWithRetry = async (
        onChunk?: (chunk: GeminiGenerateResponse) => void,
        hasEmittedFirstChunk?: () => boolean,
        onAttemptStart?: () => void
      ): Promise<{ response?: GeminiGenerateResponse; errorResponse?: Response; accountLabel?: string }> => {
        while (true) {
          onAttemptStart?.();
          if (abortController.signal.aborted) return cancelRequest();

          const queueStart = Date.now();
          let selection: SchedulerSelectResult;
          let sameAccountRetryAccount: AccountRecord | null = null;
          try {
            selection = await deps.scheduler!.selectAccount({
              family: model,
              sessionHash,
              excludeAccountIds,
              signal: abortController.signal,
            });
          } catch (err) {
            if (abortController.signal.aborted) return cancelRequest();
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 500 });
            throw err;
          }
          if (abortController.signal.aborted) {
            selection.release?.();
            return cancelRequest();
          }

          if (selection.queueTimedOut) {
            selection.release?.();
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 503 });
            return {
              errorResponse: jsonError(503, 'Gateway is busy. All available account slots are in use. Please retry shortly.', 'UNAVAILABLE'),
            };
          }

          if (!selection.account) {
            if (pendingThoughtOnlyAccount && !sameAccountThoughtRetryUsed) {
              // (c) 池中无号可换：对刚刚纯思考空响应的账号放行 1 次同号重试。
              // 通过调度器走容量预留检查（仅允许绕过 family 级 SOFT_ERROR 软避让，不清除/不绕过其他冷却）。
              sameAccountThoughtRetryUsed = true;
              const fallbackTarget = pendingThoughtOnlyAccount;
              pendingThoughtOnlyAccount = null;
              if (deps.scheduler!.selectFallbackAccount) {
                let fallbackSelection: SchedulerSelectResult;
                try {
                  fallbackSelection = await deps.scheduler!.selectFallbackAccount({
                    accountId: fallbackTarget.id,
                    family: model,
                    sessionHash,
                    signal: abortController.signal,
                  });
                } catch (err) {
                  if (abortController.signal.aborted) return cancelRequest();
                  eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 500 });
                  throw err;
                }
                if (abortController.signal.aborted) {
                  fallbackSelection.release?.();
                  return cancelRequest();
                }
                if (fallbackSelection.queueTimedOut) {
                  fallbackSelection.release?.();
                  eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 503 });
                  return {
                    errorResponse: jsonError(503, 'Gateway is busy. All available account slots are in use. Please retry shortly.', 'UNAVAILABLE'),
                  };
                }
                if (!fallbackSelection.account) {
                  if (lastClassifiedFailure) {
                    eventBus.finishRequest(requestId, { state: 'failed', httpStatus: lastClassifiedFailure.status });
                    return {
                      errorResponse: jsonError(
                        lastClassifiedFailure.status,
                        lastClassifiedFailure.reasonText,
                        lastClassifiedFailure.reasonCode,
                        getNoRetryHeaders(
                          lastClassifiedFailure.status,
                          lastClassifiedFailure.reasonCode,
                          lastClassifiedFailure.reasonText
                        )
                      ),
                    };
                  }
                  const retryAfter = fallbackSelection.retryAfterSeconds ?? 60;
                  eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 429 });
                  return {
                    errorResponse: jsonError(
                      429,
                      'All accounts are currently in cooldown or unavailable',
                      'RESOURCE_EXHAUSTED',
                      { 'Retry-After': String(retryAfter) }
                    ),
                  };
                }
                selection = fallbackSelection;
              } else {
                sameAccountRetryAccount = fallbackTarget;
              }
            } else if (sameAccountThoughtRetryUsed && lastClassifiedFailure) {
              // 同号重试已经用过且池中再无账号：如实回最后一个真实失败原因。
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: lastClassifiedFailure.status });
              return {
                errorResponse: jsonError(
                  lastClassifiedFailure.status,
                  lastClassifiedFailure.reasonText,
                  lastClassifiedFailure.reasonCode,
                  getNoRetryHeaders(
                    lastClassifiedFailure.status,
                    lastClassifiedFailure.reasonCode,
                    lastClassifiedFailure.reasonText
                  )
                ),
              };
            } else {
              if (lastClassifiedFailure) {
                const noRetryHeaders = getNoRetryHeaders(
                  lastClassifiedFailure.status,
                  lastClassifiedFailure.reasonCode,
                  lastClassifiedFailure.reasonText
                );
                if (noRetryHeaders) {
                  eventBus.finishRequest(requestId, { state: 'failed', httpStatus: lastClassifiedFailure.status });
                  return {
                    errorResponse: jsonError(
                      lastClassifiedFailure.status,
                      lastClassifiedFailure.reasonText,
                      lastClassifiedFailure.reasonCode,
                      noRetryHeaders
                    ),
                  };
                }
              }
              const attemptedRetryAfter = earliestRetryAt === undefined
                ? Infinity
                : Math.max(0, Math.ceil((earliestRetryAt - Date.now()) / 1000));
              const nextRetryAfter = Math.min(selection.retryAfterSeconds ?? Infinity, attemptedRetryAfter);
              const retryAfter = Number.isFinite(nextRetryAfter) ? nextRetryAfter : 60;
              if (
                lastClassifiedFailure?.status === 503 ||
                lastClassifiedFailure?.reasonCode === 'UNAVAILABLE'
              ) {
                eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 503 });
                return {
                  errorResponse: jsonError(
                    503,
                    lastClassifiedFailure.reasonText || 'Upstream model capacity unavailable across all accounts',
                    'UNAVAILABLE',
                    { 'Retry-After': String(retryAfter) }
                  ),
                };
              }
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 429 });
              return {
                errorResponse: jsonError(
                  429,
                  'All accounts are currently in cooldown or unavailable',
                  'RESOURCE_EXHAUSTED',
                  { 'Retry-After': String(retryAfter) }
                ),
              };
            }
          }

          const account = selection.account ?? sameAccountRetryAccount!;
          const releaseLease = selection.release;
          const onWorkerAcquired = selection.onWorkerAcquired;
          selectedAccountLabel = account.label || account.id;
          if (!excludeAccountIds.includes(account.id)) {
            excludeAccountIds.push(account.id);
          }
          const phaseTimingsMs: PhaseTimingsMs = {
            queue: Date.now() - queueStart,
          };

          let worker: WorkerHandle | null = null;
          const acquireStart = Date.now();
          try {
            const isStateless =
              (!parsedReq.tools || parsedReq.tools.length === 0) &&
              parsedReq.contents?.length === 1 &&
              (parsedReq.contents[0]?.role ?? 'user') === 'user';
            worker = await deps.workerPool!.acquire({
              account,
              sessionHash,
              model,
              request: parsedReq,
              ...(isStateless ? { stateless: true } : {}),
            });
            onWorkerAcquired?.();
            phaseTimingsMs.workerAcquire = Date.now() - acquireStart;
            if (abortController.signal.aborted) return cancelRequest();

            const genStart = Date.now();
            let firstEventRecorded = false;
            const response = await worker.generate({
              model,
              request: parsedReq,
              sessionHash,
              stream: isStream,
              signal: abortController.signal,
              onChunk: (chunk: GeminiGenerateResponse) => {
                if (!firstEventRecorded) {
                  firstEventRecorded = true;
                  phaseTimingsMs.firstEvent = Date.now() - genStart;
                }
                onChunk?.(chunk);
              },
            });

            if (abortController.signal.aborted) return cancelRequest();

            phaseTimingsMs.total = Date.now() - queueStart;
            if (response.timings) {
              Object.assign(phaseTimingsMs, response.timings);
            }

            const attempt: RequestAttempt = {
              index: attemptIndex++,
              accountId: account.id,
              accountLabel: account.label,
              requestedModel,
              ...response.modelSelection,
              outcome: 'success',
              upstreamStatus: 200,
              phaseTimingsMs,
            };
            const inputTokens = response.usageMetadata?.promptTokenCount ?? estimateTokens(parsedReq);
            const cachedTokens = typeof response.cachedTokens === 'number'
              ? Math.max(0, Math.min(
                  Number.isFinite(response.cachedTokens) ? response.cachedTokens : 0,
                  inputTokens ?? response.cachedTokens,
                ))
              : undefined;

            eventBus.recordAttempt(requestId, attempt);
            deps.scheduler!.reportSuccess?.(account.id, model, sessionHash, {
              inputTokens,
              cachedTokens,
            });
            // Keep the normalized count identical in HTTP usage and persisted logs.
            const { cachedContentTokenCount: _previousCachedCount, ...usage } = response.usageMetadata ?? {};
            response.usageMetadata = {
              ...usage,
              promptTokenCount: inputTokens,
              ...(cachedTokens !== undefined && cachedTokens > 0
                ? { cachedContentTokenCount: cachedTokens }
                : {}),
            };

            eventBus.finishRequest(requestId, {
              state: 'completed',
              httpStatus: 200,
              inputTokens,
              outputTokens: response.usageMetadata?.candidatesTokenCount,
              cacheHit: typeof response.cacheHit === 'boolean' ? response.cacheHit : undefined,
              cachedTokens,
            });

            return { response, accountLabel: selectedAccountLabel };
          } catch (err) {
            phaseTimingsMs.total = Date.now() - queueStart;
            const workerError = err instanceof WorkerError ? err : undefined;
            if (workerError?.timings) Object.assign(phaseTimingsMs, workerError.timings);
            const classified = classifyError(err);
            lastClassifiedFailure = {
              status: classified.status,
              reasonCode: classified.reasonCode,
              reasonText: classified.reasonText,
            };
            const attempt: RequestAttempt = {
              index: attemptIndex++,
              accountId: account.id,
              accountLabel: account.label,
              requestedModel,
              ...workerError?.modelSelection,
              outcome: abortController.signal.aborted ? 'cancelled' : 'failed',
              upstreamStatus: classified.status,
              reasonCode: classified.reasonCode,
              reasonText: classified.reasonText,
              rawError: workerError?.rawError ?? (err instanceof Error ? err.stack ?? err.message : String(err)),
              phaseTimingsMs,
            };
            eventBus.recordAttempt(requestId, attempt);

            if (
              classified.status === 429 ||
              classified.status === 403 ||
              classified.reasonCode === 'VALIDATION_REQUIRED' ||
              classified.reasonCode === 'RESTRICTED' ||
              classified.reasonCode === 'ACCOUNT_DISABLED_REFUSED'
            ) {
              deps.scheduler!.abandonSession?.(sessionHash, model);
            }

            const noRetryHeaders = getNoRetryHeaders(
              classified.status,
              classified.reasonCode,
              classified.reasonText
            );

            if (abortController.signal.aborted || classified.reasonCode === 'CANCELLED') {
              return cancelRequest();
            }
            if (classified.reasonCode === 'MODEL_SELECTION_FAILED' && !classified.retryable) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              return {
                errorResponse: jsonError(
                  classified.status,
                  classified.reasonText,
                  classified.reasonCode,
                  noRetryHeaders
                ),
              };
            }

            if (classified.reasonCode === 'MODEL_SELECTION_FAILED') {
              modelSelectionSwitches += 1;
              if (modelSelectionSwitches > 1) {
                eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
                return {
                  errorResponse: jsonError(
                    classified.status,
                    classified.reasonText,
                    classified.reasonCode,
                    noRetryHeaders
                  ),
                };
              }
            }

            // (c) 纯思考/空响应：换号优先；真到无号可换时用它做 1 次同号重建重试。
            if (
              workerError?.rawError === 'EMPTY_OR_THOUGHT_ONLY_RESPONSE' &&
              !sameAccountThoughtRetryUsed
            ) {
              pendingThoughtOnlyAccount = account;
            }

            const failResult = deps.scheduler!.reportFailure?.({
              accountId: account.id,
              family: model,
              status: classified.status,
              reasonCode: classified.reasonCode,
              errorMessage: classified.reasonText,
              isQuotaError: classified.isQuotaError,
              retryAfterMs: classified.retryAfterMs,
            });
            if (failResult?.retryAfterSeconds !== undefined) {
              const retryAt = Date.now() + failResult.retryAfterSeconds * 1000;
              earliestRetryAt = Math.min(earliestRetryAt ?? Infinity, retryAt);
            }

            if (hasEmittedFirstChunk?.()) {
              eventBus.finishRequest(requestId, {
                state: abortController.signal.aborted ? 'cancelled' : 'failed',
                httpStatus: classified.status,
              });
              return {
                errorResponse: jsonError(
                  classified.status,
                  classified.reasonText,
                  classified.reasonCode,
                  noRetryHeaders
                ),
              };
            }

            // Do not replay across accounts on pre-first-chunk TIMEOUT to avoid repeated prefill of large contexts.
            if (classified.reasonCode === 'TIMEOUT' || classified.status === 504) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 504 });
              return { errorResponse: jsonError(504, classified.reasonText, 'TIMEOUT') };
            }

            if (!classified.retryable) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              return {
                errorResponse: jsonError(
                  classified.status,
                  classified.reasonText,
                  classified.reasonCode,
                  noRetryHeaders
                ),
              };
            }

            const isAccountFailoverError =
              classified.isQuotaError ||
              classified.status === 401 ||
              classified.status === 402 ||
              classified.status === 403 ||
              classified.status === 429 ||
              classified.reasonCode === 'QUOTA_EXHAUSTED' ||
              classified.reasonCode === 'RESOURCE_EXHAUSTED' ||
              classified.reasonCode === 'AUTH_REQUIRED' ||
              classified.reasonCode === 'RESTRICTED' ||
              classified.reasonCode === 'VALIDATION_REQUIRED' ||
              classified.reasonCode === 'ACCOUNT_DISABLED_REFUSED';

            const getQuotaRetryHeaders = (): Record<string, string> | undefined => {
              if (classified.status !== 429 && !classified.isQuotaError) {
                return undefined;
              }
              const seconds =
                failResult?.retryAfterSeconds !== undefined
                  ? Math.max(1, failResult.retryAfterSeconds)
                  : earliestRetryAt !== undefined
                    ? Math.max(1, Math.ceil((earliestRetryAt - Date.now()) / 1000))
                    : typeof classified.retryAfterMs === 'number' && Number.isFinite(classified.retryAfterMs)
                      ? Math.max(1, Math.ceil(classified.retryAfterMs / 1000))
                      : Math.max(1, Math.round((config.cooldownStepsMinutes[0] ?? 1) * 60));
              return { 'Retry-After': String(seconds) };
            };

            if (!config.accountFailover && isAccountFailoverError) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              const mergedHeaders =
                getQuotaRetryHeaders() || noRetryHeaders
                  ? { ...getQuotaRetryHeaders(), ...noRetryHeaders }
                  : undefined;
              return {
                errorResponse: jsonError(
                  classified.status,
                  classified.reasonText,
                  classified.reasonCode,
                  mergedHeaders,
                ),
              };
            }

            if (classified.isQuotaError) {
              quotaSwitches += 1;
              if (quotaSwitches > config.maxQuotaAccountSwitches) {
                const retryHeaders =
                  earliestRetryAt !== undefined
                    ? { 'Retry-After': String(Math.max(1, Math.ceil((earliestRetryAt - Date.now()) / 1000))) }
                    : getQuotaRetryHeaders();
                eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
                return {
                  errorResponse: jsonError(
                    classified.status,
                    classified.reasonText,
                    classified.reasonCode,
                    retryHeaders,
                  ),
                };
              }
            } else {
              nonQuotaSwitches += 1;
              if (nonQuotaSwitches > config.maxAccountSwitches) {
                eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
                return {
                  errorResponse: jsonError(
                    classified.status,
                    classified.reasonText,
                    classified.reasonCode,
                    noRetryHeaders
                  ),
                };
              }
            }
          } finally {
            if (worker) {
              deps.workerPool!.release(worker);
            }
            releaseLease?.();
          }
        }
      };

      if (!isStream) {
        try {
          const result = await executeWithRetry();
          if (result.errorResponse) return result.errorResponse;
          const resp = enrichChunk(result.response ?? {}, model, responseId);
          const { outputTextLength, thoughtTextLength } = measureResponseTextLengths(resp);
          resp.usageMetadata = buildUsageMetadata(
            parsedReq,
            resp.usageMetadata,
            outputTextLength,
            thoughtTextLength
          );
          return Response.json(resp, {
            headers: {
              'X-Accel-Buffering': 'no',
              'X-Mapped-Model': model,
              'X-Account-Email': maskAccountLabel(result.accountLabel || selectedAccountLabel),
              'X-Session-Id': sessionHash,
            },
          });
        } finally {
          inFlight.delete(requestId);
          req.signal?.removeEventListener('abort', onReqAbort);
        }
      }

      // Streaming response: wait for first chunk or pre-stream error BEFORE sending HTTP 200
      const altSse = url.searchParams.get('alt') === 'sse';
      const encoder = new TextEncoder();

      type FirstOutcome =
        | {
            ok: true;
            firstChunk?: GeminiGenerateResponse;
            doneResult?: { response?: GeminiGenerateResponse; errorResponse?: Response; accountLabel?: string };
            earlyRelease?: boolean;
            earlyReleaseReason?: string;
          }
        | { ok: false; errorResponse: Response };
      let resolveFirst!: (val: FirstOutcome) => void;
      const firstReadyPromise = new Promise<FirstOutcome>((r) => {
        resolveFirst = r;
      });

      let firstSettled = false;
      let streamClosed = false;
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let lastWriteAt = Date.now();
      let sentAnyChunk = false;
      let sawFinishReason = false;
      let outputTextLength = 0;
      let thoughtTextLength = 0;
      let jsonArrayFirst = true;

      const writeChunkToStream = (chunk: GeminiGenerateResponse) => {
        if (!streamController || streamClosed) return;
        const enriched = enrichChunk(chunk, model, responseId);
        for (const cand of enriched.candidates ?? []) {
          if (cand.finishReason) sawFinishReason = true;
          for (const part of cand.content?.parts ?? []) {
            if (typeof part.text === 'string') {
              if (part.thought === true) {
                thoughtTextLength += part.text.length;
              } else {
                outputTextLength += part.text.length;
              }
            }
          }
        }
        sentAnyChunk = true;
        lastWriteAt = Date.now();
        try {
          if (altSse) {
            streamController.enqueue(encoder.encode(formatSseChunk(enriched)));
          } else {
            const prefix = jsonArrayFirst ? '[' : ',';
            jsonArrayFirst = false;
            streamController.enqueue(encoder.encode(`${prefix}${JSON.stringify(enriched)}`));
          }
        } catch {
          streamClosed = true;
        }
      };

      const streamThoughtImmediately = config.streamThoughtImmediately ?? true;
      const bufferedChunks: GeminiGenerateResponse[] = [];
      let executionFinished = false;
      let executionResult: { response?: GeminiGenerateResponse; errorResponse?: Response; accountLabel?: string } | null = null;
      let executionError: unknown = null;

      // (b) alt=sse + 关闭"即时吐思考"时的提前放行（early release）。
      //
      // 背景：关掉即时吐思考后，第一个 thought 块不再算"有效正文"，于是响应头会被一直押着不发，
      // 于是一个长思考的 turn 会把客户端挂在"等响应头"上。这里改为：
      //   * 收到首个 thought 块，或
      //   * 进入排队 / worker 执行超过 EARLY_RELEASE_DEADLINE_MS 仍无有效正文
      // 就先回 HTTP 200 text/event-stream 并每 KEEPALIVE_INTERVAL_MS 写一次 `: keepalive\n\n`。
      //
      // 红线：keepalive 是 SSE 注释行，绝不写入 bufferedChunks，也绝不动 sentAnyChunk / firstSettled；
      // hasEmittedFirstChunk() 只在真正向客户端下发第一个 `data:` 块之后才为 true，因此
      // EMPTY_OR_THOUGHT_ONLY_RESPONSE 这类首块前错误依旧可以无感换号重试。
      const earlyReleaseAllowed = altSse && !streamThoughtImmediately;
      const EARLY_RELEASE_DEADLINE_MS = Math.max(0, config.streamThoughtEarlyReleaseMs ?? 3000);
      const KEEPALIVE_INTERVAL_MS = 5000;
      let earlyReleased = false;
      let earlyReleaseReason = '';
      let contentSettledByChunk = false;
      let bufferedFlushed = false;
      let earlyReleaseTimer: ReturnType<typeof setTimeout> | null = null;
      let contentOrDoneSettled = false;
      let resolveContentOrDone!: () => void;
      const contentOrDonePromise = new Promise<void>((resolve) => {
        resolveContentOrDone = resolve;
      });
      const signalContentOrDone = () => {
        if (!contentOrDoneSettled) {
          contentOrDoneSettled = true;
          resolveContentOrDone();
        }
      };
      const clearEarlyReleaseTimer = () => {
        if (earlyReleaseTimer) {
          clearTimeout(earlyReleaseTimer);
          earlyReleaseTimer = null;
        }
      };
      const releaseStreamHeadersEarly = (reason: 'thought' | 'deadline') => {
        if (!earlyReleaseAllowed || earlyReleased || firstSettled || streamClosed) return;
        if (abortController.signal.aborted) return;
        earlyReleased = true;
        earlyReleaseReason = reason;
        clearEarlyReleaseTimer();
        resolveFirst({ ok: true, earlyRelease: true, earlyReleaseReason: reason });
      };

      // 全池耗尽兜底：HTTP 200 已经提前放行就再也改不回来，只能在已打开的流里写标准错误帧
      // 并正常关闭，让客户端 fail-fast 而不是挂在半开连接上。绝不静默假装成功。
      const writeInlineStreamErrorFrame = (code: number, message: string, status: string) => {
        if (streamClosed || !streamController) return;
        const finishFrame: GeminiGenerateResponse = {
          candidates: [
            {
              content: { role: 'model', parts: [] },
              finishReason: 'OTHER',
              finishMessage: `Upstream failed: ${message.slice(0, 200)}`,
              index: 0,
            },
          ],
          usageMetadata: buildUsageMetadata(parsedReq, undefined, outputTextLength, thoughtTextLength),
        };
        try {
          if (altSse) {
            // 先给 Gemini 系客户端一个标准终止帧，再补一个显式错误事件：两类客户端都能拿到明确失败。
            streamController.enqueue(encoder.encode(formatSseChunk(enrichChunk(finishFrame, model, responseId))));
            sawFinishReason = true;
            streamController.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ error: { code, message, status } })}\n\n`),
            );
          } else {
            streamController.enqueue(encoder.encode(JSON.stringify({ error: { code, message, status } })));
          }
          lastWriteAt = Date.now();
        } catch {
          streamClosed = true;
        }
      };
      const writeStreamErrorFrame = async (errorResponse: Response) => {
        let code = errorResponse.status || 502;
        let status = getGoogleRpcStatus(code);
        let message = 'All upstream attempts failed';
        let raw = '';
        try {
          raw = await errorResponse.text();
        } catch {
          raw = '';
        }
        try {
          const parsed = JSON.parse(raw) as { error?: { code?: number; status?: string; message?: string } };
          code = parsed.error?.code ?? code;
          status = parsed.error?.status ?? status;
          message = parsed.error?.message ?? message;
        } catch {
          if (raw) message = raw.slice(0, 300);
        }
        writeInlineStreamErrorFrame(code, message, status);
      };

      if (earlyReleaseAllowed && EARLY_RELEASE_DEADLINE_MS > 0) {
        earlyReleaseTimer = setTimeout(() => {
          releaseStreamHeadersEarly('deadline');
        }, EARLY_RELEASE_DEADLINE_MS);
      }

      const runPromise = executeWithRetry(
        (chunk) => {
          if (streamClosed) return;
          if (!firstSettled) {
            bufferedChunks.push(chunk);
            if (hasEffectiveContent(chunk, streamThoughtImmediately)) {
              // 真正拿到有效正文：这才是"已向客户端下发 data 块"的判定点。
              firstSettled = true;
              contentSettledByChunk = true;
              clearEarlyReleaseTimer();
              if (!earlyReleased) {
                resolveFirst({ ok: true, firstChunk: chunk });
              }
              signalContentOrDone();
            } else if (earlyReleaseAllowed) {
              // 只出思考、不出正文：先把 200 响应头放行 + 起 keepalive，让客户端不干等，
              // 但 sentAnyChunk / firstSettled 保持 false —— 换号重试依旧无感。
              releaseStreamHeadersEarly('thought');
            }
          } else if (streamController && bufferedFlushed) {
            writeChunkToStream(chunk);
          } else {
            bufferedChunks.push(chunk);
          }
        },
        () => sentAnyChunk || firstSettled,
        () => {
          if (!firstSettled) {
            bufferedChunks.length = 0;
          }
        }
      )
        .then((res) => {
          executionFinished = true;
          executionResult = res;
          clearEarlyReleaseTimer();
          if (!firstSettled) {
            firstSettled = true;
            if (earlyReleased) {
              // 响应头已提前放行且从未下发 data 块：不能再回非 200，流内收尾。
              signalContentOrDone();
            } else if (res.errorResponse) {
              resolveFirst({ ok: false, errorResponse: res.errorResponse });
            } else {
              resolveFirst({ ok: true, doneResult: res });
            }
          }
          return res;
        })
        .catch((err) => {
          executionFinished = true;
          executionError = err;
          clearEarlyReleaseTimer();
          if (!firstSettled) {
            firstSettled = true;
            if (earlyReleased) {
              signalContentOrDone();
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              resolveFirst({ ok: false, errorResponse: jsonError(500, msg, 'INTERNAL') });
            }
          }
        });

      const onFirstAbort = () => {
        clearEarlyReleaseTimer();
        // cancelRequest() 负责写 499 日志，无论响应头有没有提前放行都必须调用。
        const cancelled = cancelRequest();
        if (!firstSettled) {
          firstSettled = true;
          if (!earlyReleased) {
            resolveFirst({ ok: false, ...cancelled });
          }
        }
        signalContentOrDone();
      };
      if (abortController.signal.aborted) {
        onFirstAbort();
      } else {
        abortController.signal.addEventListener('abort', onFirstAbort, { once: true });
      }

      const firstOutcome = await firstReadyPromise;
      clearEarlyReleaseTimer();
      abortController.signal.removeEventListener('abort', onFirstAbort);
      if (!firstOutcome.ok) {
        inFlight.delete(requestId);
        req.signal?.removeEventListener('abort', onReqAbort);
        return firstOutcome.errorResponse;
      }

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          streamController = controller;

          if (altSse) {
            if (earlyReleased) {
              // 响应头是提前放行的：立刻写一帧 SSE 注释，让 200 + 首字节马上到达客户端。
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
                lastWriteAt = Date.now();
              } catch {
                // ignore if closed
              }
            }
            keepaliveTimer = setInterval(() => {
              if (streamClosed || !streamController) return;
              if (Date.now() - lastWriteAt >= KEEPALIVE_INTERVAL_MS) {
                try {
                  controller.enqueue(encoder.encode(': keepalive\n\n'));
                  lastWriteAt = Date.now();
                } catch {
                  // ignore if closed
                }
              }
            }, 1000);
          }

          try {
            // 提前放行后这里等"有效正文到达 / 执行结束"；其余路径 firstSettled 早已为 true，立即返回。
            if (!firstSettled && !streamClosed) {
              await contentOrDonePromise;
            }
            if (streamClosed) return;

            // 整个 turn 从未出现有效正文（执行已结束）→ 缓冲的思考块作废。
            if (!contentSettledByChunk && !sentAnyChunk) {
              bufferedChunks.length = 0;
            }
            // Flush any chunks buffered before stream started
            while (bufferedChunks.length > 0 && !streamClosed) {
              const c = bufferedChunks.shift()!;
              writeChunkToStream(c);
            }
            bufferedFlushed = true;

            if (!executionFinished) {
              await runPromise;
            }

            if (executionError) {
              throw executionError;
            }

            if (executionResult?.errorResponse) {
              if (sentAnyChunk && !sawFinishReason) {
                const msg = await executionResult.errorResponse.text();
                writeChunkToStream({
                  candidates: [
                    {
                      content: { role: 'model', parts: [] },
                      finishReason: 'OTHER',
                      finishMessage: `Upstream interrupted: ${msg.slice(0, 200)}`,
                      index: 0,
                    },
                  ],
                  usageMetadata: buildUsageMetadata(
                    parsedReq,
                    undefined,
                    outputTextLength,
                    thoughtTextLength
                  ),
                });
              } else if (!sentAnyChunk) {
                // 响应头已放行却一个 data 块都没发出，而全部重试均失败：
                // 不能再改状态码，必须在已打开的流里写标准错误帧后正常关闭，绝不静默假装成功。
                await writeStreamErrorFrame(executionResult.errorResponse);
              }
            } else if (executionResult?.response) {
              if (!sentAnyChunk) {
                const fullResp = enrichChunk(executionResult.response, model, responseId);
                const fullLengths = measureResponseTextLengths(fullResp);
                fullResp.usageMetadata = buildUsageMetadata(
                  parsedReq,
                  fullResp.usageMetadata,
                  fullLengths.outputTextLength,
                  fullLengths.thoughtTextLength
                );
                if (fullResp.candidates?.[0] && !fullResp.candidates[0].finishReason) {
                  fullResp.candidates[0].finishReason = 'STOP';
                }
                writeChunkToStream(fullResp);
              } else if (!sawFinishReason) {
                writeChunkToStream({
                  candidates: [
                    {
                      content: { role: 'model', parts: [] },
                      finishReason: executionResult.response.candidates?.[0]?.finishReason ?? 'STOP',
                      index: 0,
                    },
                  ],
                  usageMetadata: buildUsageMetadata(
                    parsedReq,
                    executionResult.response.usageMetadata,
                    outputTextLength,
                    thoughtTextLength
                  ),
                });
              }
            }

            if (!altSse && !streamClosed) {
              if (jsonArrayFirst) {
                controller.enqueue(encoder.encode('[]'));
              } else {
                controller.enqueue(encoder.encode(']'));
              }
            }
          } catch (err) {
            if (!streamClosed) {
              const msg = err instanceof Error ? err.message : String(err);
              if (sentAnyChunk && !sawFinishReason) {
                writeChunkToStream({
                  candidates: [
                    {
                      content: { role: 'model', parts: [] },
                      finishReason: 'OTHER',
                      finishMessage: `Stream interrupted: ${msg.slice(0, 200)}`,
                      index: 0,
                    },
                  ],
                  usageMetadata: buildUsageMetadata(
                    parsedReq,
                    undefined,
                    outputTextLength,
                    thoughtTextLength
                  ),
                });
              } else if (!sentAnyChunk) {
                // 响应头已经 200 出去了却一个 data 块都没发：流内报错，避免客户端挂在半开流上等超时。
                writeInlineStreamErrorFrame(502, msg.slice(0, 300), 'INTERNAL');
              }
              if (!altSse && !jsonArrayFirst) {
                controller.enqueue(encoder.encode(']'));
              }
            }
          } finally {
            clearEarlyReleaseTimer();
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
            inFlight.delete(requestId);
            req.signal?.removeEventListener('abort', onReqAbort);
            if (!streamClosed) {
              streamClosed = true;
              streamController = null;
              try {
                controller.close();
              } catch {
                // ignore if already closed
              }
            }
          }
        },
        cancel() {
          streamClosed = true;
          streamController = null;
          bufferedChunks.length = 0;
          clearEarlyReleaseTimer();
          signalContentOrDone();
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          abortController.abort();
          inFlight.delete(requestId);
          req.signal?.removeEventListener('abort', onReqAbort);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': altSse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...(earlyReleased ? { 'X-Early-Release': earlyReleaseReason } : {}),
          'X-Mapped-Model': model,
          'X-Account-Email': maskAccountLabel(selectedAccountLabel),
          'X-Session-Id': sessionHash,
        },
      });
    }

    return jsonError(404, `Not found: ${url.pathname}`, 'NOT_FOUND');
  };
}
