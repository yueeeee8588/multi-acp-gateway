import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { AccountManager } from './accounts/manager';
import {
  authorizeChromeProfiles,
  openUrlInAccountChrome,
  scanChromeProfiles,
  type ChromeOAuthProfileRequest,
} from './accounts/chrome-scan';
import {
  AccountQueueTimeoutError,
  AccountScheduler,
  accountScheduler as globalAccountScheduler,
  AllAccountsCooldownError,
  NoReadyAccountsError,
  isFullProAccount,
} from './accounts/scheduler';
import { aggregateExits } from './accounts/exit-probe';
import { LoopbackMcpServer } from './acp/loopback-mcp';
import { AcpWorkerPool } from './acp/pool';
import {
  getConfig,
  getPublicConfig,
  updateConfig,
  validateRiskControlPatch,
  validateSensitiveFilterPatch,
} from './config/settings';
import { store } from './db/store';
import { createAnthropicHandler } from './anthropic/handler';
import { createOpenAiHandler } from './openai/handler';
import {
  createGeminiHandler,
  discoverAgyModels,
  isForceRefresh,
  type GeminiHandlerDeps,
  type ModelLimitEntry,
  type ModelLimitsMap,
  type SchedulerLike,
  type SchedulerSelectResult,
  type WorkerHandle,
  type WorkerPoolLike,
} from './gemini/handler';
import { eventBus } from './logs/events';
import type { AccountRecord, GatewayConfig } from './types';

function mapSchedulerError(err: unknown): SchedulerSelectResult {
  if (err instanceof AccountQueueTimeoutError) {
    return { account: null, queueTimedOut: true };
  }
  if (err instanceof AllAccountsCooldownError) {
    return { account: null, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof NoReadyAccountsError) {
    return { account: null };
  }
  throw err;
}

function adaptScheduler(scheduler: AccountScheduler): SchedulerLike {
  return {
    async selectAccount({ family, sessionHash, excludeAccountIds, signal }) {
      try {
        const { account, release, onWorkerAcquired } = await scheduler.acquireAccountLease(
          family,
          sessionHash,
          new Set(excludeAccountIds),
          signal,
        );
        return { account, release, onWorkerAcquired };
      } catch (err) {
        return mapSchedulerError(err);
      }
    },
    async selectFallbackAccount({ accountId, family, sessionHash, signal }) {
      try {
        const { account, release, onWorkerAcquired } = await scheduler.acquireFallbackAccountLease(
          accountId,
          family,
          sessionHash,
          signal,
        );
        return { account, release, onWorkerAcquired };
      } catch (err) {
        return mapSchedulerError(err);
      }
    },
    reportSuccess(accountId, family, sessionHash, usage) {
      scheduler.recordSuccess(accountId, family, sessionHash, usage);
    },
    abandonSession(sessionHash, family) {
      scheduler.abandonSession(sessionHash, family);
    },
    reportFailure({ accountId, family, status, reasonCode, errorMessage, retryAfterMs }) {
      const retryAt = scheduler.recordFailure(accountId, family, {
        upstreamStatus: status,
        reasonCode,
        rawError: errorMessage,
        retryAfterMs,
      });
      if (retryAt !== undefined) {
        return { retryAfterSeconds: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) };
      }
    },
  };
}

export function adaptWorkerPool(
  pool: AcpWorkerPool,
  onRelease?: (accountId: string) => void,
  onAcquire?: (accountId: string) => void,
): WorkerPoolLike {
  const releaseMap = new WeakMap<WorkerHandle, () => void>();
  return {
    async acquire({ account, sessionHash, model, request }) {
      const { worker, release } = pool.acquireWorker(account, model, request, sessionHash);
      onAcquire?.(account.id);
      const handle: WorkerHandle = {
        id: `${account.id}:${sessionHash}`,
        accountId: account.id,
        async generate(params) {
          const result = await worker.executePrompt(
            params.request,
            {
              onPart: params.onChunk
                ? (part) => {
                    params.onChunk?.({
                      candidates: [{ content: { role: 'model', parts: [part] }, index: 0 }],
                    });
                  }
                : undefined,
            },
            params.signal,
          );
          return {
            candidates: [
              {
                content: { role: 'model', parts: result.parts },
                finishReason: result.finishReason,
                index: 0,
              },
            ],
            usageMetadata: result.usageMetadata,
            ...(typeof result.cacheHit === 'boolean' ? { cacheHit: result.cacheHit } : {}),
            ...(typeof result.cachedTokens === 'number' ? { cachedTokens: result.cachedTokens } : {}),
            timings: result.timings,
            modelSelection: result.modelSelection,
          };
        },
      };
      releaseMap.set(handle, release);
      return handle;
    },
    release(worker) {
      const fn = releaseMap.get(worker);
      if (fn) {
        releaseMap.delete(worker);
        fn();
        onRelease?.(worker.accountId);
      }
    },
  };
}

export interface AppOptions {
  geminiDeps?: GeminiHandlerDeps;
  accountManager?: AccountManager;
  webDistDir?: string;
  prewarm?: boolean;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function isLoopbackRequest(req: Request, url: URL): boolean {
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const urlHost = url.hostname.toLowerCase();
  if (!allowed.has(urlHost)) return false;
  const hostHeader = req.headers.get('host');
  if (hostHeader) {
    const parsedHost = hostHeader.trim().toLowerCase();
    const hostnameOnly = parsedHost.startsWith('[')
      ? parsedHost.slice(0, parsedHost.indexOf(']') + 1)
      : parsedHost.split(':')[0];
    if (!allowed.has(hostnameOnly)) return false;
  }
  return true;
}

export function createApp(options: AppOptions = {}) {
  const config = getConfig();
  const inFlightControllers = options.geminiDeps?.inFlightControllers ?? new Map<string, AbortController>();
  const accountManager = options.accountManager ?? new AccountManager();
  const mcpServer = options.geminiDeps?.workerPool ? null : new LoopbackMcpServer();
  let accountScheduler: AccountScheduler | null = null;
  const acpPool = options.geminiDeps?.workerPool
    ? null
    : new AcpWorkerPool({
        mcpServer: mcpServer!,
        agyPath: config.agyPath || undefined,
        softErrorCutoffMs: config.softErrorCutoffMs,
        tryAcquireWorkerSpawn: (accountId) =>
          (accountScheduler ?? globalAccountScheduler).tryConsumeWorkerSpawn(accountId),
      });
  accountScheduler = options.geminiDeps?.scheduler
    ? null
    : new AccountScheduler({
        getActiveCount: acpPool ? (id) => acpPool.getActiveCount(id) : undefined,
      });
  const scheduler = options.geminiDeps?.scheduler ?? adaptScheduler(accountScheduler!);
  eventBus.setActiveCountProvider(acpPool ? (id) => acpPool.getActiveCount(id) : undefined);
  const enrichAccount = (account: AccountRecord): AccountRecord =>
    acpPool ? { ...account, activeWorkers: acpPool.getActiveCount(account.id) } : account;
  const enrichAccounts = (accounts: AccountRecord[]): AccountRecord[] =>
    acpPool ? accounts.map(enrichAccount) : accounts;
  const emitAccountsIfSubscribed = () => {
    if (eventBus.subscriberCount > 0) {
      eventBus.emit('accounts', accountManager.listAccounts());
    }
  };
  const workerPool =
    options.geminiDeps?.workerPool ??
    adaptWorkerPool(
      acpPool!,
      () => emitAccountsIfSubscribed(),
      () => emitAccountsIfSubscribed(),
    );

  const prewarm = async (): Promise<void> => {
    if (!acpPool) return;
    const readyAccounts = store
      .listAccounts()
      .filter((a) => a.status === 'ready' && isFullProAccount(a));
    if (readyAccounts.length === 0) return;
    await acpPool.ensurePrewarm(readyAccounts);
  };

  if (options.prewarm) {
    void prewarm();
  }

  let drainPromise: Promise<{ drained: boolean; cancelledPending: number; abortedInFlight: number }> | null = null;
  const drain = async (
    reason = 'Gateway restarting',
  ): Promise<{ drained: boolean; cancelledPending: number; abortedInFlight: number }> => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      let abortedInFlight = 0;
      const controllers = Array.from(inFlightControllers.values());
      inFlightControllers.clear();
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          abortedInFlight += 1;
          try {
            controller.abort(new Error(reason));
          } catch {
            // ignore abort errors
          }
        }
      }
      const cancelledPending = mcpServer ? mcpServer.stop(reason) : 0;
      await acpPool?.shutdownAll();
      return { drained: true, cancelledPending, abortedInFlight };
    })();
    return drainPromise;
  };

  const handleGemini = createGeminiHandler({
    ...options.geminiDeps,
    scheduler,
    workerPool,
    inFlightControllers,
  });
  const handleAnthropic = createAnthropicHandler({
    scheduler,
    workerPool,
    inFlightControllers,
  });
  const handleOpenAi = createOpenAiHandler({
    scheduler,
    workerPool,
    inFlightControllers,
  });
  const webDistDir = resolve(options.webDistDir ?? join(process.cwd(), 'web', 'dist'));

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 1. Gemini /v1beta protocol routes
    if (url.pathname.startsWith('/v1beta')) {
      const res = await handleGemini(req, url);
      if (res) return res;
    }

    // 1b. Anthropic /v1 protocol routes
    if (
      url.pathname === '/v1/messages' ||
      url.pathname === '/v1/messages/count_tokens' ||
      url.pathname === '/v1/models'
    ) {
      const res = await handleAnthropic(req, url);
      if (res) return res;
    }

    // 1c. OpenAI /v1/chat/completions protocol route
    if (url.pathname === '/v1/chat/completions') {
      const res = await handleOpenAi(req, url);
      if (res) return res;
    }

    // 2. Management /api routes
    if (url.pathname.startsWith('/api/')) {
      // GET /api/events (SSE)
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const encoder = new TextEncoder();
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            eventBus.subscribe(controller);
            pingTimer = setInterval(() => {
              try {
                const payload = JSON.stringify({ type: 'ping', data: { ts: Date.now() }, timestamp: Date.now() });
                controller.enqueue(encoder.encode(`event: ping\ndata: ${payload}\n\n`));
              } catch {
                if (pingTimer) clearInterval(pingTimer);
                if (controllerRef) eventBus.unsubscribe(controllerRef);
              }
            }, 15000);
          },
          cancel() {
            if (pingTimer) clearInterval(pingTimer);
            if (controllerRef) eventBus.unsubscribe(controllerRef);
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        });
      }

      // GET /api/status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const now = Date.now();
        const accounts = store.listAccounts();
        const cooldowns = store.listCooldowns(now);
        return Response.json({
          ok: true,
          uptimeMs: Math.floor(process.uptime() * 1000),
          accountsTotal: accounts.length,
          accountsReady: accounts.filter((a) => a.status === 'ready').length,
          activeCooldowns: cooldowns.length,
          inFlightRequests: inFlightControllers.size,
          subscribers: eventBus.subscriberCount,
          timestamp: now,
        });
      }

      // POST /api/drain
      if (req.method === 'POST' && url.pathname === '/api/drain') {
        if (!isLoopbackRequest(req, url)) {
          return Response.json({ error: 'Forbidden: loopback host required' }, { status: 403 });
        }
        const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
        const reason =
          typeof body?.reason === 'string' && body.reason.trim()
            ? body.reason.trim()
            : 'Gateway restarting';
        const stats = await drain(reason);
        return Response.json({ ok: true, ...stats });
      }

      // GET /api/accounts
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        return Response.json(enrichAccounts(accountManager.listAccounts()));
      }

      // GET /api/accounts/exits
      if (req.method === 'GET' && url.pathname === '/api/accounts/exits') {
        const accounts = accountManager.listAccounts();
        return Response.json(aggregateExits(accounts));
      }

      // POST /api/accounts
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const body = (await req.json().catch(() => ({}))) as Partial<AccountRecord>;
        const account = accountManager.createAccount({
          id: body.id,
          label: body.label || body.email || `account-${randomUUID().slice(0, 6)}`,
          email: body.email,
          source: body.source,
          homeDir: body.homeDir,
          proxyUrl: body.proxyUrl,
          status: body.status ?? 'ready',
          tier: body.tier === 'pro' ? 'pro' : 'standard',
          concurrencyLimit: body.concurrencyLimit,
        });
        eventBus.emit('accounts', accountManager.listAccounts());
        return Response.json(enrichAccount(account), { status: 201 });
      }

      // POST /api/accounts/import-local
      if (req.method === 'POST' && url.pathname === '/api/accounts/import-local') {
        const imported = accountManager.importLocalAccounts();
        const accounts = enrichAccounts(accountManager.listAccounts());
        eventBus.emit('accounts', accounts);
        return Response.json({ imported: imported.length, accounts });
      }

      // POST /api/accounts/import-tokens
      if (req.method === 'POST' && url.pathname === '/api/accounts/import-tokens') {
        const body = (await req.json().catch(() => ({}))) as {
          tokens?: string;
          proxyUrl?: string;
        };
        if (!body.tokens || typeof body.tokens !== 'string') {
          return Response.json({ error: 'tokens string is required' }, { status: 400 });
        }
        const result = await accountManager.importRefreshTokens(body.tokens, {
          proxyUrl: body.proxyUrl,
        });
        return Response.json(result);
      }

      // POST /api/accounts/detect-tiers
      if (req.method === 'POST' && url.pathname === '/api/accounts/detect-tiers') {
        const result = await accountManager.detectAllAccountTiers();
        eventBus.emit('accounts', accountManager.listAccounts());
        return Response.json(result);
      }

      // POST /api/accounts/quota/refresh-all
      if (req.method === 'POST' && url.pathname === '/api/accounts/quota/refresh-all') {
        const result = await accountManager.refreshAllQuotas();
        return Response.json(result);
      }

      // GET /api/accounts/chrome-profiles
      if (req.method === 'GET' && url.pathname === '/api/accounts/chrome-profiles') {
        return Response.json(scanChromeProfiles());
      }

      // POST /api/accounts/chrome-oauth
      if (req.method === 'POST' && url.pathname === '/api/accounts/chrome-oauth') {
        const body = (await req.json().catch(() => ({}))) as {
          profiles?: ChromeOAuthProfileRequest[];
        };
        if (!Array.isArray(body.profiles)) {
          return Response.json({ error: 'profiles array is required' }, { status: 400 });
        }
        try {
          const result = await authorizeChromeProfiles(body.profiles, { accountManager });
          return Response.json(result);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 }
          );
        }
      }

      // Account-specific routes: /api/accounts/:id/...
      const accMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(.*))?$/);
      if (accMatch) {
        const accountId = decodeURIComponent(accMatch[1]);
        const subPath = accMatch[2] || '';

        if (req.method === 'PUT' && !subPath) {
          const existing = accountManager.getAccount(accountId);
          if (!existing) return Response.json({ error: 'Account not found' }, { status: 404 });
          const patch = (await req.json().catch(() => ({}))) as Partial<AccountRecord>;
          const nextStatusReason =
            patch.statusReason !== undefined
              ? patch.statusReason
              : patch.status === 'ready'
                ? ''
                : existing.statusReason;
          const updated: AccountRecord = {
            ...existing,
            ...patch,
            id: existing.id,
            statusReason: nextStatusReason,
            tier: patch.tier === 'pro' ? 'pro' : patch.tier === 'standard' ? 'standard' : existing.tier,
            updatedAt: Date.now(),
          };
          store.upsertAccount(updated);
          if (updated.status === 'ready') {
            if (accountScheduler) {
              accountScheduler.clearCooldown(accountId, '*', 'global');
            } else {
              const deleted = store.deleteCooldown(accountId, '*', 'global');
              if (deleted) {
                eventBus.emit('cooldowns', store.listCooldowns(Date.now()));
              }
            }
          }
          eventBus.emit('accounts', accountManager.listAccounts());
          return Response.json(enrichAccount(updated));
        }

        if (req.method === 'DELETE' && !subPath) {
          accountManager.deleteAccount(accountId);
          eventBus.emit('accounts', accountManager.listAccounts());
          return Response.json({ ok: true });
        }

        if (req.method === 'POST' && subPath === 'login') {
          const existing = accountManager.getAccount(accountId);
          if (!existing) return Response.json({ error: 'Account not found' }, { status: 404 });
          const result = await accountManager.triggerCliLogin(accountId);
          const updated = accountManager.getAccount(accountId) ?? existing;
          eventBus.emit('accounts', accountManager.listAccounts());
          return Response.json({ ok: result.ok, message: result.message, account: enrichAccount(updated) });
        }

        if (req.method === 'POST' && subPath === 'refresh') {
          const updated = await accountManager.refreshAccount(accountId);
          if (!updated) return Response.json({ error: 'Account not found' }, { status: 404 });
          eventBus.emit('accounts', accountManager.listAccounts());
          return Response.json(enrichAccount(updated));
        }

        if (req.method === 'POST' && subPath === 'quota') {
          const updated = await accountManager.refreshAccountQuota(accountId);
          if (!updated) return Response.json({ error: 'Account not found' }, { status: 404 });
          return Response.json(enrichAccount(updated));
        }

        if (req.method === 'POST' && subPath === 'open-url') {
          const body = (await req.json().catch(() => ({}))) as { url?: unknown };
          const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
          if (!rawUrl || /[\r\n\0]/.test(rawUrl) || !/^https?:\/\//i.test(rawUrl)) {
            return Response.json(
              { error: 'Valid http:// or https:// url is required' },
              { status: 400 }
            );
          }
          const existing = store.getAccount(accountId);
          if (!existing) {
            return Response.json({ error: 'Account not found' }, { status: 404 });
          }
          try {
            const result = openUrlInAccountChrome(existing.email || '', rawUrl);
            return Response.json(result);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 400 }
            );
          }
        }

        const cdMatch = subPath.match(/^cooldowns\/(.+)$/);
        if (req.method === 'DELETE' && cdMatch) {
          const scope = decodeURIComponent(cdMatch[1]);
          const colonIdx = scope.lastIndexOf(':');
          const family = colonIdx >= 0 ? scope.slice(0, colonIdx) : scope;
          const scopeType =
            colonIdx >= 0
              ? scope.slice(colonIdx + 1)
              : scope === 'global'
                ? 'global'
                : 'family';
          const normalizedScopeType = scopeType === 'global' ? 'global' : 'family';
          let deleted = false;
          if (accountScheduler) {
            deleted = accountScheduler.clearCooldown(
              accountId,
              normalizedScopeType === 'global' ? '*' : family,
              normalizedScopeType,
            );
          } else {
            deleted = store.deleteCooldown(
              accountId,
              normalizedScopeType === 'global' ? '*' : family,
              normalizedScopeType,
            );
            if (deleted) {
              eventBus.emit('cooldowns', store.listCooldowns(Date.now()));
              options.geminiDeps?.scheduler?.releaseSlot?.(accountId);
            }
          }
          return Response.json({ ok: true, deleted });
        }
      }

      // GET /api/cooldowns
      if (req.method === 'GET' && url.pathname === '/api/cooldowns') {
        return Response.json(store.listCooldowns(Date.now()));
      }

      // GET /api/requests
      if (req.method === 'GET' && url.pathname === '/api/requests') {
        const limit = Number(url.searchParams.get('limit') || 100);
        return Response.json(eventBus.getRecentRequests(limit));
      }

      // POST /api/requests/:id/cancel
      const cancelMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const requestId = decodeURIComponent(cancelMatch[1]);
        const controller = inFlightControllers.get(requestId);
        if (controller) {
          controller.abort();
          inFlightControllers.delete(requestId);
          return Response.json({ ok: true, cancelled: true });
        }
        return Response.json({ ok: false, cancelled: false }, { status: 404 });
      }

      // The 8046 console proxies this read-only catalog after console authentication.
      if (req.method === 'GET' && url.pathname === '/api/models/catalog') {
        return Response.json({ models: await discoverAgyModels(isForceRefresh(url)) });
      }

      // GET /api/models/limits
      if (req.method === 'GET' && url.pathname === '/api/models/limits') {
        const limits = store.getConfigValue<ModelLimitsMap>('model_limits') ?? {};
        return Response.json({ limits });
      }

      // PUT /api/models/:id/limits
      const modelLimitsMatch = url.pathname.match(/^\/api\/models\/([^/]+)\/limits$/);
      if (req.method === 'PUT' && modelLimitsMatch) {
        const modelId = decodeURIComponent(modelLimitsMatch[1]);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: 'Invalid JSON request body' }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
        }

        const record = body as Record<string, unknown>;
        const parseLimitField = (
          field: 'inputTokenLimit' | 'outputTokenLimit'
        ): { ok: true; value?: number } | { ok: false; error: string } => {
          const raw = record[field];
          if (raw === undefined || raw === null || raw === '') {
            return { ok: true, value: undefined };
          }
          if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
            return { ok: true, value: raw };
          }
          return {
            ok: false,
            error: `${field} must be a positive integer, null, or empty`,
          };
        };

        const inputParsed = parseLimitField('inputTokenLimit');
        if (!inputParsed.ok) {
          return Response.json({ error: inputParsed.error }, { status: 400 });
        }
        const outputParsed = parseLimitField('outputTokenLimit');
        if (!outputParsed.ok) {
          return Response.json({ error: outputParsed.error }, { status: 400 });
        }

        const allLimits: ModelLimitsMap = {
          ...(store.getConfigValue<ModelLimitsMap>('model_limits') ?? {}),
        };
        const updatedEntry: ModelLimitEntry = {};
        if (inputParsed.value !== undefined) {
          updatedEntry.inputTokenLimit = inputParsed.value;
        }
        if (outputParsed.value !== undefined) {
          updatedEntry.outputTokenLimit = outputParsed.value;
        }

        if (Object.keys(updatedEntry).length === 0) {
          delete allLimits[modelId];
          store.setConfigValue('model_limits', allLimits);
          return Response.json({ ok: true, model: modelId, limits: null });
        }

        allLimits[modelId] = updatedEntry;
        store.setConfigValue('model_limits', allLimits);
        return Response.json({ ok: true, model: modelId, limits: updatedEntry });
      }

      // GET /api/config
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return Response.json(getPublicConfig());
      }

      // PUT /api/config
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const body: unknown = await req.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json({ error: 'Expected a JSON object' }, { status: 400 });
        }
        for (const field of ['apiKey', 'defaultProxy'] as const) {
          if (field in body && typeof (body as Record<string, unknown>)[field] !== 'string') {
            return Response.json({ error: `${field} must be a string` }, { status: 400 });
          }
        }
        try {
          validateSensitiveFilterPatch(body as Record<string, unknown>);
          validateRiskControlPatch(body as Record<string, unknown>);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
        updateConfig(body as Partial<GatewayConfig>);
        const pub = getPublicConfig();
        eventBus.emit('config', pub);
        return Response.json(pub);
      }

      // GET /api/metrics
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        const now = Date.now();
        const requests = eventBus.getRecentRequests(500);
        const total = requests.length;
        const completed = requests.filter((r) => r.state === 'completed').length;
        const failed = requests.filter((r) => r.state === 'failed').length;
        const successRate = total > 0 ? completed / total : 1;

        const firstEventLatencies = requests
          .flatMap((r) => r.attempts.map((a) => a.phaseTimingsMs.firstEvent))
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
          .sort((a, b) => a - b);

        const cooldowns = store.listCooldowns(now);
        const cooledAccounts = new Set(cooldowns.map((c) => c.accountId)).size;

        // 1-minute buckets for last 15 minutes
        const bucketMs = 60_000;
        const bucketCount = 15;
        const startBucket = Math.floor(now / bucketMs) * bucketMs - (bucketCount - 1) * bucketMs;
        const buckets = Array.from({ length: bucketCount }, (_, i) => ({
          ts: startBucket + i * bucketMs,
          total: 0,
          success: 0,
          failed: 0,
        }));

        for (const r of requests) {
          const idx = Math.floor((r.startedAt - startBucket) / bucketMs);
          if (idx >= 0 && idx < bucketCount) {
            buckets[idx].total += 1;
            if (r.state === 'completed') buckets[idx].success += 1;
            else if (r.state === 'failed') buckets[idx].failed += 1;
          }
        }

        return Response.json({
          totalRequests: total,
          completedRequests: completed,
          failedRequests: failed,
          successRate,
          firstEventP50Ms: percentile(firstEventLatencies, 50),
          firstEventP95Ms: percentile(firstEventLatencies, 95),
          cooledAccounts,
          buckets,
        });
      }

      return Response.json({ error: 'API endpoint not found' }, { status: 404 });
    }

    // 3. Static hosting for web/dist
    if (existsSync(webDistDir)) {
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const candidate = resolve(webDistDir, `.${safePath}`);
      if (candidate.startsWith(webDistDir) && existsSync(candidate) && statSync(candidate).isFile()) {
        const ext = extname(candidate).toLowerCase();
        return new Response(Bun.file(candidate), {
          headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
        });
      }
      const indexHtml = join(webDistDir, 'index.html');
      if (existsSync(indexHtml)) {
        return new Response(Bun.file(indexHtml), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  return { fetch, prewarm, drain };
}

let processErrorGuardsInstalled = false;

export function isBenignPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /epipe|broken pipe/i.test(err);
  }
  const record = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (record.code === 'EPIPE' || record.errno === -32) {
    return true;
  }
  if (typeof record.message === 'string' && /epipe|broken pipe/i.test(record.message)) {
    return true;
  }
  return false;
}

export function installProcessErrorGuards(): void {
  if (processErrorGuardsInstalled) return;
  processErrorGuardsInstalled = true;

  process.on('uncaughtException', (err: Error) => {
    if (isBenignPipeError(err)) {
      console.warn(
        `[agy-gemini-8048] ignored benign EPIPE uncaughtException ts=${new Date().toISOString()} message=${err.message}`,
      );
      return;
    }
    console.error(
      `[agy-gemini-8048] fatal uncaughtException ts=${new Date().toISOString()}`,
      err,
    );
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    if (isBenignPipeError(reason)) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.warn(
        `[agy-gemini-8048] ignored benign EPIPE unhandledRejection ts=${new Date().toISOString()} message=${message}`,
      );
      return;
    }
    console.error(
      `[agy-gemini-8048] fatal unhandledRejection ts=${new Date().toISOString()}`,
      reason,
    );
  });
}

if (import.meta.main) {
  installProcessErrorGuards();
  void new AccountManager().syncMissingAccountEmails().then((n: number) => {
    if (n > 0) console.log(`[agy-gemini-8048] synced missing emails for ${n} account(s)`);
  });
  const config = getConfig();
  const app = createApp();
  const server = Bun.serve({
    hostname: config.host || '127.0.0.1',
    port: config.port,
    idleTimeout: 255,
    fetch: app.fetch,
  });
  console.log(`[agy-gemini-8048] listening on http://${server.hostname}:${server.port}`);
  void app.prewarm();

  // 认证自愈：出口网络恢复后，把因认证失败被下线的账号重新拉回可用池，
  // 避免网络抖动一次就把整池账号留在 auth_required。
  const authRecoveryManager = new AccountManager();
  const authRecoveryTimer = setInterval(() => {
    void (async () => {
      const pending = store.listAccounts().filter((account) => account.status === 'auth_required');
      if (pending.length === 0) return;
      for (const account of pending) {
        try {
          await authRecoveryManager.refreshAccount(account.id);
        } catch {
          // 刷新失败就等下一轮，不影响主服务
        }
      }
    })();
  }, 10 * 60_000);
  if (typeof authRecoveryTimer.unref === 'function') authRecoveryTimer.unref();

  let shuttingDown = false;
  const handleShutdown = (signalName: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agy-gemini-8048] received ${signalName}, draining...`);
    clearInterval(authRecoveryTimer);
    const forceExitTimer = setTimeout(() => {
      console.error('[agy-gemini-8048] graceful shutdown timed out after 5000ms, forcing exit');
      process.exit(1);
    }, 5000);
    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }
    void app
      .drain('Gateway shutting down')
      .catch((err) => {
        console.error('[agy-gemini-8048] error during drain:', err);
      })
      .finally(() => {
        server.stop(true);
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}
