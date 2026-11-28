import { randomUUID } from 'node:crypto';
import { isSuggestionModeRequest } from '../acp/suggestion-guard';
import { WorkerError } from '../acp/worker';
import { getConfig } from '../config/settings';
import { eventBus } from '../logs/events';
import {
  applyGenerationConfigGuardrails,
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
  AccountRecord,
  GeminiGenerateResponse,
  PhaseTimingsMs,
  RequestAttempt,
} from '../types';
import {
  OpenAiProtocolError,
  OpenAiStreamSerializer,
  convertGeminiToOpenAiResponse,
  convertOpenAiToGeminiRequest,
  formatOpenAiSseData,
  getOpenAiErrorInfo,
  resolveOpenAiSessionKey,
  type OpenAiErrorType,
} from './protocol';

export type OpenAiHandlerDeps = GeminiHandlerDeps;

export function extractOpenAiApiKey(req: Request): string {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const xApiKey = req.headers.get('x-api-key');
  if (xApiKey) return xApiKey.trim();

  return '';
}

function openAiJsonError(
  status: number,
  message: string,
  errorType?: OpenAiErrorType,
  code?: string | null,
  headers?: Record<string, string>
): Response {
  const fallback = getOpenAiErrorInfo(status);
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: errorType ?? fallback.type,
        param: null,
        code: code !== undefined ? code : fallback.code,
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

export function createOpenAiHandler(deps: OpenAiHandlerDeps = {}) {
  const inFlight = deps.inFlightControllers ?? new Map<string, AbortController>();

  return async function handleOpenAiRequest(req: Request, url: URL): Promise<Response | null> {
    const pathname = url.pathname;
    if (pathname !== '/v1/chat/completions') {
      return null;
    }

    const config = getConfig();
    if (config.apiKey) {
      const provided = extractOpenAiApiKey(req);
      if (!provided || provided !== config.apiKey) {
        return openAiJsonError(
          401,
          'Invalid or missing API key',
          'authentication_error',
          'invalid_api_key'
        );
      }
    }

    if (req.method !== 'POST') {
      return openAiJsonError(
        405,
        `Method ${req.method} not allowed`,
        'invalid_request_error',
        'method_not_allowed'
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return openAiJsonError(
        400,
        'Invalid JSON request body',
        'invalid_request_error',
        'invalid_json'
      );
    }

    let converted: ReturnType<typeof convertOpenAiToGeminiRequest>;
    try {
      converted = convertOpenAiToGeminiRequest(rawBody, {
        maxImagesPerRequest: config.maxImagesPerRequest,
      });
    } catch (err) {
      if (err instanceof OpenAiProtocolError) {
        return openAiJsonError(err.statusCode, err.message, err.errorType, err.code);
      }
      return openAiJsonError(
        400,
        err instanceof Error ? err.message : 'Invalid request',
        'invalid_request_error',
        'invalid_request'
      );
    }

    const parsedReq = converted.geminiRequest;
    const requestedModel = converted.requestedModel;
    const rawBodyObj =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>)
        : undefined;
    const model = resolveGatewayModel(requestedModel, {
      thinkingConfig: parsedReq.generationConfig?.thinkingConfig as Record<string, unknown> | undefined,
      reasoningEffort: typeof rawBodyObj?.reasoning_effort === 'string' ? rawBodyObj.reasoning_effort : undefined,
    });
    applyGenerationConfigGuardrails(parsedReq, getModelLimitsMap()[model]?.outputTokenLimit);

    if (isSuggestionModeRequest(parsedReq.contents)) {
      const guardRequestId = randomUUID();
      const guardCompletionId = `chatcmpl-${guardRequestId.replace(/-/g, '').slice(0, 24)}`;
      const guardCreated = Math.floor(Date.now() / 1000);
      const guardSessionHash = resolveOpenAiSessionKey(
        parsedReq,
        req.headers,
        converted.promptCacheKey,
        converted.userField
      );
      if (!converted.stream) {
        const openAiResp = convertGeminiToOpenAiResponse(
          {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: '' }] },
                finishReason: 'STOP',
              },
            ],
          },
          {
            completionId: guardCompletionId,
            model: requestedModel,
            created: guardCreated,
          }
        );
        return Response.json(openAiResp, {
          headers: {
            'X-Accel-Buffering': 'no',
            'X-Mapped-Model': model,
            'X-Session-Id': guardSessionHash,
          },
        });
      }
      const guardSerializer = new OpenAiStreamSerializer(
        guardCompletionId,
        requestedModel,
        guardCreated
      );
      const ssePayload = guardSerializer.finishStream('STOP', undefined, converted.includeUsage);
      return new Response(ssePayload, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Mapped-Model': model,
          'X-Session-Id': guardSessionHash,
        },
      });
    }

    if (!deps.scheduler || !deps.workerPool) {
      return openAiJsonError(
        503,
        'Gateway scheduler or worker pool is not initialized',
        'server_error',
        'service_unavailable'
      );
    }

    const isStream = converted.stream;
    const family = getModelFamily(model);
    const sessionHash = resolveOpenAiSessionKey(
      parsedReq,
      req.headers,
      converted.promptCacheKey,
      converted.userField
    );
    const requestId = randomUUID();
    const completionId = `chatcmpl-${requestId.replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
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
    let quotaSwitches = 0;
    let modelSelectionSwitches = 0;
    let attemptIndex = 0;
    let earliestRetryAt: number | undefined;
    let selectedAccountLabel = '';
    let lastClassifiedFailure: { status: number; reasonCode: string; reasonText: string } | null = null;
    let pendingThoughtOnlyAccount: AccountRecord | null = null;
    let sameAccountThoughtRetryUsed = false;
    let cancellationLogged = false;
    const cancelRequest = () => {
      if (!cancellationLogged) {
        cancellationLogged = true;
        eventBus.finishRequest(requestId, { state: 'cancelled', httpStatus: 499 });
      }
      return {
        errorResponse: openAiJsonError(499, 'Request cancelled', 'server_error', 'request_cancelled'),
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
            errorResponse: openAiJsonError(
              503,
              'Gateway is busy. All available account slots are in use. Please retry shortly.',
              'server_error',
              'service_unavailable'
            ),
          };
        }

        if (!selection.account) {
          if (pendingThoughtOnlyAccount && !sameAccountThoughtRetryUsed) {
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
                  errorResponse: openAiJsonError(
                    503,
                    'Gateway is busy. All available account slots are in use. Please retry shortly.',
                    'server_error',
                    'service_unavailable'
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
                    errorResponse: openAiJsonError(
                      lastClassifiedFailure.status,
                      lastClassifiedFailure.reasonText,
                      undefined,
                      undefined,
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
                  errorResponse: openAiJsonError(
                    429,
                    'All accounts are currently in cooldown or unavailable',
                    'rate_limit_error',
                    'rate_limit_exceeded',
                    { 'Retry-After': String(retryAfter) }
                  ),
                };
              }
              selection = fallbackSelection;
            } else {
              sameAccountRetryAccount = fallbackTarget;
            }
          } else if (sameAccountThoughtRetryUsed && lastClassifiedFailure) {
            eventBus.finishRequest(requestId, {
              state: 'failed',
              httpStatus: lastClassifiedFailure.status,
            });
            return {
              errorResponse: openAiJsonError(
                lastClassifiedFailure.status,
                lastClassifiedFailure.reasonText,
                undefined,
                undefined,
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
                eventBus.finishRequest(requestId, {
                  state: 'failed',
                  httpStatus: lastClassifiedFailure.status,
                });
                return {
                  errorResponse: openAiJsonError(
                    lastClassifiedFailure.status,
                    lastClassifiedFailure.reasonText,
                    undefined,
                    undefined,
                    noRetryHeaders
                  ),
                };
              }
            }
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
                errorResponse: openAiJsonError(
                  503,
                  lastClassifiedFailure.reasonText || 'Upstream model capacity unavailable across all accounts',
                  'server_error',
                  'service_unavailable',
                  { 'Retry-After': String(retryAfter) }
                ),
              };
            }
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 429 });
            return {
              errorResponse: openAiJsonError(
                429,
                'All accounts are currently in cooldown or unavailable',
                'rate_limit_error',
                'rate_limit_exceeded',
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
              errorResponse: openAiJsonError(
                classified.status,
                classified.reasonText,
                undefined,
                undefined,
                noRetryHeaders
              ),
            };
          }

          if (classified.reasonCode === 'MODEL_SELECTION_FAILED') {
            modelSelectionSwitches += 1;
            if (modelSelectionSwitches > 1) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              return {
                errorResponse: openAiJsonError(
                  classified.status,
                  classified.reasonText,
                  undefined,
                  undefined,
                  noRetryHeaders
                ),
              };
            }
          }

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
              errorResponse: openAiJsonError(
                classified.status,
                classified.reasonText,
                undefined,
                undefined,
                noRetryHeaders
              ),
            };
          }

          if (classified.reasonCode === 'TIMEOUT' || classified.status === 504) {
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: 504 });
            return {
              errorResponse: openAiJsonError(504, classified.reasonText, 'server_error', 'timeout'),
            };
          }

          if (!classified.retryable) {
            eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
            return {
              errorResponse: openAiJsonError(
                classified.status,
                classified.reasonText,
                undefined,
                undefined,
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
              errorResponse: openAiJsonError(
                classified.status,
                classified.reasonText,
                undefined,
                undefined,
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
                errorResponse: openAiJsonError(
                  classified.status,
                  classified.reasonText,
                  undefined,
                  undefined,
                  retryHeaders,
                ),
              };
            }
          } else {
            nonQuotaSwitches += 1;
            if (nonQuotaSwitches > config.maxAccountSwitches) {
              eventBus.finishRequest(requestId, { state: 'failed', httpStatus: classified.status });
              return {
                errorResponse: openAiJsonError(
                  classified.status,
                  classified.reasonText,
                  undefined,
                  undefined,
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
        const openAiResp = convertGeminiToOpenAiResponse(result.response ?? {}, {
          completionId,
          model: requestedModel,
          created,
        });
        return Response.json(openAiResp, {
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
    let stream: ReadableStream<Uint8Array> | undefined;
    let streamController: ReadableStreamController<Uint8Array> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let lastWriteAt = Date.now();
    let sentAnyChunk = false;

    const serializer = new OpenAiStreamSerializer(completionId, requestedModel, created);
    const streamThoughtImmediately = config.streamThoughtImmediately ?? true;
    const MAX_BUFFERED_STREAM_BYTES = 2 * 1024 * 1024;
    const bufferedChunks: GeminiGenerateResponse[] = [];
    let bufferedBytes = 0;
    const clearBufferedChunks = () => {
      bufferedChunks.length = 0;
      bufferedBytes = 0;
    };
    let executionFinished = false;
    let executionResult: {
      response?: GeminiGenerateResponse;
      errorResponse?: Response;
      accountLabel?: string;
    } | null = null;
    let executionError: unknown = null;

    const writeSse = (payload: string) => {
      if (!streamController || streamClosed || !payload) return;
      try {
        streamController.enqueue(encoder.encode(payload));
        lastWriteAt = Date.now();
      } catch (err) {
        streamController.error(err);
        stopStream();
      }
    };

    const writeChunkToStream = (chunk: GeminiGenerateResponse) => {
      if (!streamController || streamClosed) return;
      const sse = serializer.processChunk(chunk);
      if (sse) {
        sentAnyChunk = true;
        writeSse(sse);
      }
    };

    // 与 src/gemini/handler.ts、src/anthropic/handler.ts 同构的提前放行（early release）：
    // 关闭即时吐思考时，收到首个 thought 块或等待超过 earlyReleaseDeadlineMs 仍无有效正文，
    // 先放行 HTTP 200 text/event-stream 并立刻写 `: keepalive\n\n` 保活；
    // 保活绝不写入 bufferedChunks，也绝不动 sentAnyChunk / firstSettled，换号重试闸门保持畅通。
    const earlyReleaseAllowed = !streamThoughtImmediately;
    const earlyReleaseDeadlineMs = Math.max(0, config.streamThoughtEarlyReleaseMs ?? 3000);
    const KEEPALIVE_INTERVAL_MS = 5000;
    let earlyReleased = false;
    let earlyReleaseReason = '';
    let shouldFlushBufferedChunks = false;
    let bufferedFlushed = false;
    const flushBufferedChunks = () => {
      if (bufferedFlushed) return;
      bufferedFlushed = true;
      try {
        for (const chunk of bufferedChunks) {
          if (streamClosed) break;
          writeChunkToStream(chunk);
        }
      } finally {
        clearBufferedChunks();
      }
    };
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

    // 全池耗尽兜底：HTTP 200 提前放行后无法再改 HTTP 状态码，必须在 SSE 流内写标准 OpenAI 错误帧并 [DONE] 关闭。
    const writeInlineStreamErrorFrame = (
      status: number,
      message: string,
      errorType?: OpenAiErrorType,
      code?: string | null
    ) => {
      if (streamClosed || !streamController) return;
      const fallback = getOpenAiErrorInfo(status);
      writeSse(
        formatOpenAiSseData({
          error: {
            message,
            type: errorType ?? fallback.type,
            param: null,
            code: code !== undefined ? code : fallback.code,
          },
        })
      );
      writeSse('data: [DONE]\n\n');
    };
    const writeStreamErrorFrame = async (errorResponse: Response) => {
      const status = errorResponse.status || 502;
      const fallback = getOpenAiErrorInfo(status);
      let errorType: OpenAiErrorType = fallback.type;
      let code: string | null = fallback.code;
      let message = 'All upstream attempts failed';
      let raw = '';
      try {
        raw = await errorResponse.text();
      } catch {
        raw = '';
      }
      try {
        const parsed = JSON.parse(raw) as {
          error?: { type?: string; message?: string; code?: string | null };
        };
        if (typeof parsed.error?.type === 'string' && parsed.error.type) {
          errorType = parsed.error.type as OpenAiErrorType;
        }
        if (parsed.error && 'code' in parsed.error) {
          code = parsed.error.code ?? null;
        }
        if (typeof parsed.error?.message === 'string' && parsed.error.message) {
          message = parsed.error.message;
        }
      } catch {
        if (raw) message = raw.slice(0, 300);
      }
      writeInlineStreamErrorFrame(status, message, errorType, code);
    };

    if (earlyReleaseAllowed && earlyReleaseDeadlineMs > 0) {
      earlyReleaseTimer = setTimeout(() => {
        releaseStreamHeadersEarly('deadline');
      }, earlyReleaseDeadlineMs);
    }

    const runPromise = executeWithRetry(
      (chunk) => {
        if (streamClosed) return;
        if (bufferedFlushed) {
          writeChunkToStream(chunk);
          return;
        }

        bufferedChunks.push(chunk);
        bufferedBytes += Buffer.byteLength(JSON.stringify(chunk));
        const atBufferLimit = bufferedBytes >= MAX_BUFFERED_STREAM_BYTES;
        if (!firstSettled) {
          if (hasEffectiveContent(chunk, streamThoughtImmediately) || atBufferLimit) {
            firstSettled = true;
            shouldFlushBufferedChunks = true;
            clearEarlyReleaseTimer();
            if (!earlyReleased) {
              resolveFirst({ ok: true, firstChunk: chunk });
            }
            signalContentOrDone();
          } else if (earlyReleaseAllowed) {
            releaseStreamHeadersEarly('thought');
          }
        }
        if (atBufferLimit) {
          // Start synchronously if needed so an upstream burst cannot grow the buffer further.
          if (streamController) flushBufferedChunks();
          else stream ??= createStream();
        }
      },
      () => sentAnyChunk || firstSettled,
      () => {
        if (!firstSettled) {
          clearBufferedChunks();
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
            resolveFirst({ ok: false, errorResponse: openAiJsonError(500, msg) });
          }
        }
      });

    const onFirstAbort = () => {
      clearEarlyReleaseTimer();
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

    const streamSource: UnderlyingSource<Uint8Array> = {
      async start(controller) {
        streamController = controller;

        const writeKeepalive = () => {
          writeSse(': keepalive\n\n');
        };
        if (earlyReleased) writeKeepalive();
        if (!streamClosed) {
          pingTimer = setInterval(() => {
            if (Date.now() - lastWriteAt >= KEEPALIVE_INTERVAL_MS) writeKeepalive();
          }, 1000);
        }

        try {
          if (!firstSettled && !streamClosed) {
            await contentOrDonePromise;
          }
          if (streamClosed) return;

          if (!shouldFlushBufferedChunks) clearBufferedChunks();
          flushBufferedChunks();

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
                formatOpenAiSseData({
                  error: {
                    message: `Upstream interrupted: ${msg.slice(0, 200)}`,
                    type: 'server_error',
                    param: null,
                    code: 'stream_interrupted',
                  },
                })
              );
              writeSse('data: [DONE]\n\n');
            } else {
              await writeStreamErrorFrame(executionResult.errorResponse);
            }
          } else if (executionResult?.response) {
            if (!sentAnyChunk) {
              writeChunkToStream(executionResult.response);
            }
            const finishReason = executionResult.response.candidates?.[0]?.finishReason;
            writeSse(
              serializer.finishStream(
                finishReason,
                executionResult.response.usageMetadata,
                converted.includeUsage
              )
            );
          }
        } catch (err) {
          if (!streamClosed) {
            const msg = err instanceof Error ? err.message : String(err);
            if (sentAnyChunk) {
              writeSse(
                formatOpenAiSseData({
                  error: {
                    message: `Stream interrupted: ${msg.slice(0, 200)}`,
                    type: 'server_error',
                    param: null,
                    code: 'stream_interrupted',
                  },
                })
              );
              writeSse('data: [DONE]\n\n');
            } else {
              writeInlineStreamErrorFrame(502, msg.slice(0, 300), 'server_error', 'stream_interrupted');
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
      cancel: stopStream,
    };

    function createStream(): ReadableStream<Uint8Array> {
      return new ReadableStream(streamSource);
    }

    function stopStream() {
      streamClosed = true;
      streamController = null;
      clearBufferedChunks();
      clearEarlyReleaseTimer();
      signalContentOrDone();
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      abortController.abort();
      inFlight.delete(requestId);
      req.signal?.removeEventListener('abort', onReqAbort);
    }

    const firstOutcome = await firstReadyPromise;
    clearEarlyReleaseTimer();
    abortController.signal.removeEventListener('abort', onFirstAbort);
    if (!firstOutcome.ok) {
      inFlight.delete(requestId);
      req.signal?.removeEventListener('abort', onReqAbort);
      return firstOutcome.errorResponse;
    }

    return new Response(stream ??= createStream(), {
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
