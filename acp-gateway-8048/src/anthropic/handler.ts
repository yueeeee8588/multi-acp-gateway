import { randomUUID } from 'node:crypto';
import { WorkerError } from '../acp/worker';
import { getConfig } from '../config/settings';
import { eventBus } from '../logs/events';
import {
  applyGenerationConfigGuardrails,
  discoverAgyModels,
  getModelLimitsMap,
  type GeminiHandlerDeps,
  type SchedulerSelectResult,
  type WorkerHandle,
} from '../gemini/handler';
import {
  estimateTokens,
  getModelFamily,
  resolveGatewayModel,
} from '../gemini/protocol';
import type {
  GeminiGenerateResponse,
  PhaseTimingsMs,
  RequestAttempt,
} from '../types';
import {
  AnthropicProtocolError,
  AnthropicStreamSerializer,
  convertAnthropicToGeminiRequest,
  convertGeminiToAnthropicResponse,
  formatAnthropicSseEvent,
  getAnthropicErrorType,
  resolveAnthropicSessionKey,
  type AnthropicErrorType,
} from './protocol';

export type AnthropicHandlerDeps = GeminiHandlerDeps;

const ANTHROPIC_ERROR_TYPES = new Set<AnthropicErrorType>([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'overloaded_error',
  'api_error',
]);

export function extractAnthropicApiKey(req: Request): string {
  const xApiKey = req.headers.get('x-api-key');
  if (xApiKey) return xApiKey.trim();

  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return '';
}

function anthropicJsonError(
  status: number,
  message: string,
  errorType: AnthropicErrorType = getAnthropicErrorType(status),
  headers?: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: errorType,
        message,
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
            : err.code === 'VALIDATION_REQUIRED' || err.code === 'RESTRICTED'
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
        err.code === 'SOFT_ERROR' ||
        err.code === 'TRANSPORT_ERROR' ||
        err.code === 'TIMEOUT' ||
        status === 502 ||
        status === 503 ||
        status === 504);
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

export function createAnthropicHandler(deps: AnthropicHandlerDeps = {}) {
  const inFlight = deps.inFlightControllers ?? new Map<string, AbortController>();

  return async function handleAnthropicRequest(req: Request, url: URL): Promise<Response | null> {
    const pathname = url.pathname;
    if (
      pathname !== '/v1/messages' &&
      pathname !== '/v1/messages/count_tokens' &&
      pathname !== '/v1/models'
    ) {
      return null;
    }

    const config = getConfig();
    if (config.apiKey) {
      const provided = extractAnthropicApiKey(req);
      if (!provided || provided !== config.apiKey) {
        return anthropicJsonError(401, 'Invalid or missing API key', 'authentication_error');
      }
    }

    // GET /v1/models
    if (pathname === '/v1/models') {
      if (req.method !== 'GET') {
        return anthropicJsonError(405, `Method ${req.method} not allowed`, 'invalid_request_error');
      }
      const models = await discoverAgyModels();
      const data = models.map((m) => ({
        id: m.name.replace(/^models\//, ''),
        object: 'model' as const,
        created: 1735689600,
        owned_by: 'antigravity',
        type: 'model' as const,
        display_name: m.displayName,
        created_at: '2025-01-01T00:00:00Z',
      }));
      return Response.json({ object: 'list', data, has_more: false });
    }

    if (req.method !== 'POST') {
      return anthropicJsonError(405, `Method ${req.method} not allowed`, 'invalid_request_error');
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return anthropicJsonError(400, 'Invalid JSON request body', 'invalid_request_error');
    }

    const isCountTokens = pathname === '/v1/messages/count_tokens';
    let converted: ReturnType<typeof convertAnthropicToGeminiRequest>;
    try {
      converted = convertAnthropicToGeminiRequest(rawBody, {
        maxImagesPerRequest: config.maxImagesPerRequest,
        requireMaxTokens: !isCountTokens,
      });
    } catch (err) {
      if (err instanceof AnthropicProtocolError) {
        return anthropicJsonError(err.statusCode, err.message, err.errorType);
      }
      return anthropicJsonError(
        400,
        err instanceof Error ? err.message : 'Invalid request',
        'invalid_request_error'
      );
    }

    const parsedReq = converted.geminiRequest;

    if (isCountTokens) {
      return Response.json({ input_tokens: estimateTokens(parsedReq) });
    }

    const requestedModel = converted.requestedModel;
    const model = resolveGatewayModel(requestedModel, {
      thinkingConfig: parsedReq.generationConfig?.thinkingConfig as Record<string, unknown> | undefined,
    });
    applyGenerationConfigGuardrails(parsedReq, getModelLimitsMap()[model]?.outputTokenLimit);

    if (!deps.scheduler || !deps.workerPool) {
      return anthropicJsonError(
        503,
        'Gateway scheduler or worker pool is not initialized',
        'overloaded_error'
      );
    }

    const isStream = converted.stream;
    const family = getModelFamily(model);
    const sessionHash = resolveAnthropicSessionKey(
      parsedReq,
      req.headers,
      converted.metadataUserId
    );
    const requestId = randomUUID();
    const messageId = `msg_${requestId.replace(/-/g, '').slice(0, 24)}`;
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
      endpoint: pathname,
      stream: isStream,
      startedAt,
    });

    const excludeAccountIds: string[] = [];
    let nonQuotaSwitches = 0;
    let modelSelectionSwitches = 0;
    let attemptIndex = 0;
    let earliestRetryAt: number | undefined;
    let selectedAccountLabel = '';
    let cancellationLogged = false;
    // 单号池容错：记录刚刚以 EMPTY_OR_THOUGHT_ONLY_RESPONSE 失败的账号。
    // 重试循环优先换号；只有池中确实已无其他可用账号时，才回来对它放行 1 次同号重建重试。
    let pendingThoughtOnlyAccount: SchedulerSelectResult['account'] = null;
    let sameAccountThoughtRetryUsed = false;
    // 池中真的无号可用时，回最后一个真实失败原因（例如 502 SOFT_ERROR），而不是笼统的 429。
    let lastClassifiedFailure: { status: number; reasonCode: string; reasonText: string } | null = null;
    const cancelRequest = () => {
      if (!cancellationLogged) {
        cancellationLogged = true;
        eventBus.finishRequest(requestId, { state: 'cancelled', httpStatus: 499 });
      }
      return {
        errorResponse: anthropicJsonError(499, 'Request cancelled', 'api_error'),
      };
    };

    const executeWithRetry = async (
      onChunk?: (chunk: GeminiGenerateResponse) => void,
      hasEmittedFirstChunk?: () => boolean,
      onAttemptStart?: () => void
    ): Promise<{
      response?: GeminiGenerateResponse;
      errorResponse?: Response;
      accountLabel?: string;
    }> => {
      while (true) {
        onAttemptStart?.();
        if (abortController.signal.aborted) return cancelRequest();

        const queueStart = Date.now();
        let selection: SchedulerSelectResult;
        let sameAccountRetryAccount: SchedulerSelectResult['account'] = null;
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
            errorResponse: anthropicJsonError(
              503,
              'Gateway is busy. All available account slots are in use. Please retry shortly.',
              'overloaded_error'
            ),
          };
        }

        if (!selection.account) {
          if (pendingThoughtOnlyAccount && !sameAccountThoughtRetryUsed) {
            // 池中无号可换：对刚刚纯思考空响应的账号放行 1 次同号重试。
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
                  errorResponse: anthropicJsonError(
                    503,
                    'Gateway is busy. All available account slots are in use. Please retry shortly.',
                    'overloaded_error'
                  ),
                };
              }
              if (!fallbackSelection.account) {
                if (lastClassifiedFailure) {
                  eventBus.finishRequest(requestId, {
                    state: 'failed',
                    httpStatus: lastClassifiedFailure.status,
                  });
                  return {
                    errorResponse: anthropicJsonError(
                      lastClassifiedFailure.status,
                      lastClassifiedFailure.reasonText
                    ),
                  };
                }
                const retryAfter = fallbackSelection.retryAfterSeconds ?? 60;
                eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 429 });
                return {
                  errorResponse: anthropicJsonError(
                    429,
                    'All accounts are currently in cooldown or unavailable',
                    'rate_limit_error',
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
            eventBus.finishRequest(requestId, {
              state: 'failed',
              httpStatus: lastClassifiedFailure.status,
            });
            return {
              errorResponse: anthropicJsonError(
                lastClassifiedFailure.status,
                lastClassifiedFailure.reasonText
              ),
            };
          } else {
            const attemptedRetryAfter =
              earliestRetryAt === undefined
                ? Infinity
                : Math.max(0, Math.ceil((earliestRetryAt - Date.now()) / 1000));
            const nextRetryAfter = Math.min(
              selection.retryAfterSeconds ?? Infinity,
              attemptedRetryAfter
            );
            const retryAfter = Number.isFinite(nextRetryAfter) ? nextRetryAfter : 60;
            if (
              lastClassifiedFailure?.status === 503 ||
              lastClassifiedFailure?.reasonCode === 'UNAVAILABLE'
            ) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 503 });
              return {
                errorResponse: anthropicJsonError(
                  503,
                  lastClassifiedFailure.reasonText || 'Upstream model capacity unavailable across all accounts',
                  getAnthropicErrorType(503),
                  { 'Retry-After': String(retryAfter) }
                ),
              };
            }
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 429 });
            return {
              errorResponse: anthropicJsonError(
                429,
                'All accounts are currently in cooldown or unavailable',
                'rate_limit_error',
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
          worker = await deps.workerPool!.acquire({
            account,
            sessionHash,
            model,
            request: parsedReq,
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
          const inputTokens =
            response.usageMetadata?.promptTokenCount ?? estimateTokens(parsedReq);
          const cachedTokens =
            typeof response.cachedTokens === 'number'
              ? Math.max(
                  0,
                  Math.min(
                    Number.isFinite(response.cachedTokens) ? response.cachedTokens : 0,
                    inputTokens ?? response.cachedTokens
                  )
                )
              : undefined;

          eventBus.recordAttempt(requestId, attempt);
          deps.scheduler!.reportSuccess?.(account.id, model, sessionHash, {
            inputTokens,
            cachedTokens,
          });

          const { cachedContentTokenCount: _prevCached, ...usage } =
            response.usageMetadata ?? {};
          response.usageMetadata = {
            ...usage,
            promptTokenCount: inputTokens,
            ...(cachedTokens !== undefined && cachedTokens > 0
              ? { cachedContentTokenCount: cachedTokens }
              : {}),
          };

          const outputTokens =
            (response.usageMetadata?.candidatesTokenCount ?? 0) +
            (response.usageMetadata?.thoughtsTokenCount ?? 0);

          eventBus.finishRequest(requestId, {
            state: 'completed',
            httpStatus: 200,
            inputTokens,
            outputTokens,
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
            rawError:
              workerError?.rawError ??
              (err instanceof Error ? err.stack ?? err.message : String(err)),
            phaseTimingsMs,
          };
          eventBus.recordAttempt(requestId, attempt);

          if (
            classified.status === 429 ||
            classified.status === 403 ||
            classified.reasonCode === 'VALIDATION_REQUIRED' ||
            classified.reasonCode === 'RESTRICTED'
          ) {
            deps.scheduler!.abandonSession?.(sessionHash, model);
          }

          if (abortController.signal.aborted || classified.reasonCode === 'CANCELLED') {
            return cancelRequest();
          }
          if (classified.reasonCode === 'MODEL_SELECTION_FAILED' && !classified.retryable) {
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
            return {
              errorResponse: anthropicJsonError(classified.status, classified.reasonText),
            };
          }

          if (classified.reasonCode === 'MODEL_SELECTION_FAILED') {
            modelSelectionSwitches += 1;
            if (modelSelectionSwitches > 1) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              return {
                errorResponse: anthropicJsonError(classified.status, classified.reasonText),
              };
            }
          }

          // 纯思考/空响应：换号优先；真到无号可换时用它做 1 次同号重建重试。
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
              errorResponse: anthropicJsonError(classified.status, classified.reasonText),
            };
          }

          if (classified.reasonCode === 'TIMEOUT' || classified.status === 504) {
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 504 });
            return {
              errorResponse: anthropicJsonError(504, classified.reasonText, 'api_error'),
            };
          }

          if (!classified.retryable) {
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
            return {
              errorResponse: anthropicJsonError(classified.status, classified.reasonText),
            };
          }

          if (!classified.isQuotaError) {
            nonQuotaSwitches += 1;
            if (nonQuotaSwitches > config.maxAccountSwitches) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              return {
                errorResponse: anthropicJsonError(classified.status, classified.reasonText),
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
        const anthropicResp = convertGeminiToAnthropicResponse(
          result.response ?? {},
          parsedReq,
          requestedModel,
          messageId
        );
        return Response.json(anthropicResp, {
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

    // Streaming SSE response: wait for first effective chunk or pre-stream error BEFORE HTTP 200
    const encoder = new TextEncoder();

    type FirstOutcome =
      | {
          ok: true;
          firstChunk?: GeminiGenerateResponse;
          doneResult?: {
            response?: GeminiGenerateResponse;
            errorResponse?: Response;
            accountLabel?: string;
          };
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
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let lastWriteAt = Date.now();
    let sentAnyChunk = false;

    const serializer = new AnthropicStreamSerializer(messageId, requestedModel);
    const streamThoughtImmediately = config.streamThoughtImmediately ?? true;
    const bufferedChunks: GeminiGenerateResponse[] = [];
    let executionFinished = false;
    let executionResult: {
      response?: GeminiGenerateResponse;
      errorResponse?: Response;
      accountLabel?: string;
    } | null = null;
    let executionError: unknown = null;

    const writeSse = (payload: string) => {
      if (!streamController || streamClosed || !payload) return;
      streamController.enqueue(encoder.encode(payload));
      lastWriteAt = Date.now();
    };

    const writeChunkToStream = (chunk: GeminiGenerateResponse) => {
      if (!streamController || streamClosed) return;
      const sse = serializer.processChunk(chunk);
      if (sse) {
        sentAnyChunk = true;
        writeSse(sse);
      }
    };

    // 与 src/gemini/handler.ts 同构的提前放行（early release）。
    //
    // 背景：关掉即时吐思考后，第一个 thinking 块不再算"有效正文"，响应头会被一直押着不发，
    // 一个长思考的 turn 会把客户端挂在"等响应头"上。这里改为：
    //   * 收到首个 thinking 块，或
    //   * 进入排队 / worker 执行超过 EARLY_RELEASE_DEADLINE_MS 仍无有效正文
    // 就先回 HTTP 200 text/event-stream 并每 KEEPALIVE_INTERVAL_MS 写一次 SSE 注释保活。
    //
    // 红线：`: keepalive\n\n` 与 `event: ping` 只走流通道，绝不写入 bufferedChunks，
    // 也绝不动 sentAnyChunk / firstSettled；hasEmittedFirstChunk() 只有在真正下发第一个有效
    // data 事件之后才为 true，因此 EMPTY_OR_THOUGHT_ONLY_RESPONSE 依旧可以无感换号重试。
    const earlyReleaseAllowed = !streamThoughtImmediately;
    const EARLY_RELEASE_DEADLINE_MS = Math.max(0, config.streamThoughtEarlyReleaseMs ?? 3000);
    const KEEPALIVE_INTERVAL_MS = 5000;
    let earlyReleased = false;
    let earlyReleaseReason = '';
    let contentSettledByChunk = false;
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

    // 全池耗尽兜底：HTTP 200 已经提前放行就再也改不回来，只能在已打开的 SSE 流里写标准
    // Anthropic 错误事件并正常关闭，让客户端 fail-fast，绝不静默假装成功。
    const writeInlineStreamErrorFrame = (
      status: number,
      message: string,
      errorType: AnthropicErrorType
    ) => {
      if (streamClosed || !streamController) return;
      writeSse(
        formatAnthropicSseEvent('error', {
          type: 'error',
          error: { type: errorType, message },
        })
      );
    };
    const writeStreamErrorFrame = async (errorResponse: Response) => {
      let status = errorResponse.status || 502;
      let errorType: AnthropicErrorType = getAnthropicErrorType(status);
      let message = 'All upstream attempts failed';
      let raw = '';
      try {
        raw = await errorResponse.text();
      } catch {
        raw = '';
      }
      try {
        const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string } };
        const parsedType = parsed.error?.type;
        if (parsedType && ANTHROPIC_ERROR_TYPES.has(parsedType as AnthropicErrorType)) {
          errorType = parsedType as AnthropicErrorType;
        }
        message = parsed.error?.message ?? message;
      } catch {
        if (raw) message = raw.slice(0, 300);
      }
      writeInlineStreamErrorFrame(status, message, errorType);
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
            // 真正拿到有效正文：这才是"已向客户端下发 data 事件"的判定点。
            firstSettled = true;
            contentSettledByChunk = true;
            clearEarlyReleaseTimer();
            if (!earlyReleased) {
              resolveFirst({ ok: true, firstChunk: chunk });
            }
            signalContentOrDone();
          } else if (earlyReleaseAllowed) {
            // 只出 thinking、不出正文：先把 200 响应头放行 + 起保活，让客户端不干等，
            // 但 sentAnyChunk / firstSettled 保持 false —— 换号重试依旧无感。
            releaseStreamHeadersEarly('thought');
          }
        } else if (streamController) {
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
            // 响应头已提前放行且从未下发 data 事件：不能再回非 200，流内收尾。
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
            resolveFirst({
              ok: false,
              errorResponse: anthropicJsonError(500, msg, 'api_error'),
            });
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

        writeSse(serializer.startMessage(estimateTokens(parsedReq)));

        // 保活：`: keepalive` 是 SSE 注释行（任何严格 SSE 解析器都会跳过），
        // 再补一个 Anthropic 原生的 `event: ping`，两类客户端都能靠它保活。
        // 两者都只走流通道，绝不碰 sentAnyChunk / firstSettled / bufferedChunks。
        const writeKeepalive = () => {
          if (streamClosed || !streamController) return;
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
            controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
            lastWriteAt = Date.now();
          } catch {
            // ignore if closed
          }
        };

        if (earlyReleased) {
          // 响应头是提前放行的：立刻写保活帧，让 200 + 首字节马上到达客户端。
          writeKeepalive();
        }

        pingTimer = setInterval(() => {
          if (streamClosed || !streamController) return;
          if (Date.now() - lastWriteAt >= KEEPALIVE_INTERVAL_MS) {
            writeKeepalive();
          }
        }, 1000);

        try {
          // 提前放行后这里等"有效正文到达 / 执行结束"；其余路径 firstSettled 早已为 true，立即返回。
          if (!firstSettled && !streamClosed) {
            await contentOrDonePromise;
          }
          if (streamClosed) return;

          // 整个 turn 从未出现有效正文（执行已结束）→ 缓冲的 thinking 块作废，改由 executionResult.response 整体下发。
          if (!contentSettledByChunk && executionResult?.response && !sentAnyChunk) {
            bufferedChunks.length = 0;
          }
          while (bufferedChunks.length > 0 && !streamClosed) {
            const c = bufferedChunks.shift()!;
            writeChunkToStream(c);
          }

          if (!executionFinished) {
            await runPromise;
          }

          if (executionError) {
            throw executionError;
          }

          if (executionResult?.errorResponse) {
            if (sentAnyChunk) {
              const msg = await executionResult.errorResponse.text();
              writeSse(
                formatAnthropicSseEvent('error', {
                  type: 'error',
                  error: {
                    type: 'api_error',
                    message: `Upstream interrupted: ${msg.slice(0, 200)}`,
                  },
                })
              );
            } else {
              // 200 已放行却一个 data 事件都没发出，而全部重试均失败：
              // 不能再改状态码，必须在已打开的流里写标准 Anthropic 错误事件后正常关闭。
              await writeStreamErrorFrame(executionResult.errorResponse);
            }
          } else if (executionResult?.response) {
            if (!sentAnyChunk) {
              writeChunkToStream(executionResult.response);
            }
            const finishReason = executionResult.response.candidates?.[0]?.finishReason;
            writeSse(
              serializer.finishMessage(
                parsedReq,
                finishReason,
                executionResult.response.usageMetadata
              )
            );
          }
        } catch (err) {
          if (!streamClosed) {
            const msg = err instanceof Error ? err.message : String(err);
            if (sentAnyChunk) {
              writeSse(
                formatAnthropicSseEvent('error', {
                  type: 'error',
                  error: {
                    type: 'api_error',
                    message: `Stream interrupted: ${msg.slice(0, 200)}`,
                  },
                })
              );
            } else {
              // 响应头已经 200 出去了却一个 data 事件都没发：流内报错，避免客户端挂在半开流上。
              writeInlineStreamErrorFrame(502, msg.slice(0, 300), 'api_error');
            }
          }
        } finally {
          clearEarlyReleaseTimer();
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
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
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        abortController.abort();
        inFlight.delete(requestId);
        req.signal?.removeEventListener('abort', onReqAbort);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(earlyReleased ? { 'X-Early-Release': earlyReleaseReason } : {}),
        'X-Mapped-Model': model,
        'X-Account-Email': maskAccountLabel(selectedAccountLabel),
        'X-Session-Id': sessionHash,
      },
    });
  };
}
