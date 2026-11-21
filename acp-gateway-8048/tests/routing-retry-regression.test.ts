import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { AccountScheduler } from '../src/accounts/scheduler';
import { WorkerError } from '../src/acp/worker';
import { createAnthropicHandler } from '../src/anthropic/handler';
import * as settings from '../src/config/settings';
import { GatewayStore } from '../src/db/store';
import {
  createGeminiHandler,
  type SchedulerLike,
  type WorkerHandle,
  type WorkerPoolLike,
} from '../src/gemini/handler';
import { createOpenAiHandler } from '../src/openai/handler';
import type { AccountRecord, GatewayConfig } from '../src/types';

function makeAccount(id: string, overrides: Partial<AccountRecord> = {}): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Acc-${id}`,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: '',
    proxyUrl: '',
    status: 'ready',
    tier: 'standard',
    statusReason: '',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...settings.DEFAULT_CONFIG,
    apiKey: '',
    queueWaitTimeoutMs: 500,
    maxAccountSwitches: 3,
    cacheSettlingDelayMs: 0,
    ...overrides,
  };
}

function createLeaseSchedulerAdapter(scheduler: AccountScheduler): SchedulerLike {
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
        if (err instanceof Error && err.name === 'AccountQueueTimeoutError') {
          return { account: null, queueTimedOut: true };
        }
        if (err instanceof Error && err.name === 'AllAccountsCooldownError') {
          return {
            account: null,
            retryAfterSeconds: (err as { retryAfterSeconds?: number }).retryAfterSeconds,
          };
        }
        if (err instanceof Error && err.name === 'NoReadyAccountsError') {
          return { account: null };
        }
        throw err;
      }
    },
    async selectFallbackAccount({ accountId, family, sessionHash, signal }) {
      try {
        const { account, release, onWorkerAcquired } =
          await scheduler.acquireFallbackAccountLease(accountId, family, sessionHash, signal);
        return { account, release, onWorkerAcquired };
      } catch (err) {
        if (err instanceof Error && err.name === 'AccountQueueTimeoutError') {
          return { account: null, queueTimedOut: true };
        }
        if (err instanceof Error && err.name === 'AllAccountsCooldownError') {
          return {
            account: null,
            retryAfterSeconds: (err as { retryAfterSeconds?: number }).retryAfterSeconds,
          };
        }
        if (err instanceof Error && err.name === 'NoReadyAccountsError') {
          return { account: null };
        }
        throw err;
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

describe('Routing lease ownership, mixed concurrency & three-protocol retry regression', () => {
  let db: GatewayStore;
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    db = new GatewayStore(':memory:');
    spies.push(spyOn(settings, 'getConfig').mockImplementation(() => makeConfig()));
  });

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
    settings.invalidateConfigCache();
    db.db.close();
  });

  it('issues idempotent request-exclusive leases and ignores coarse releaseSlot(accountId) on other requests', async () => {
    const acc = makeAccount('acc-1', { concurrencyLimit: 2 });
    db.upsertAccount(acc);
    const activeMap = new Map<string, number>();

    const scheduler = new AccountScheduler({
      dbStore: db,
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });

    const l1 = await scheduler.acquireAccountLease('gemini-4-hydrogen', 's1');
    const l2 = await scheduler.acquireAccountLease('gemini-4-hydrogen', 's2');
    expect(scheduler.getReservedCount('acc-1')).toBe(2);

    // Coarse releaseSlot(accountId) must NOT decrement l1 or l2's leases
    scheduler.releaseSlot('acc-1');
    expect(scheduler.getReservedCount('acc-1')).toBe(2);

    // Releasing l1 twice is idempotent and never affects l2
    l1.release();
    l1.release();
    expect(scheduler.getReservedCount('acc-1')).toBe(1);

    // A 3rd request can now enter, while l2 is still held
    const l3 = await scheduler.acquireAccountLease('gemini-4-hydrogen', 's3');
    expect(scheduler.getReservedCount('acc-1')).toBe(2);

    l2.release();
    l3.release();
    expect(scheduler.getReservedCount('acc-1')).toBe(0);
  });

  it('enforces capacity under mixed unleased external workers and leased requests without double counting', async () => {
    const acc = makeAccount('acc-mix', { concurrencyLimit: 2 });
    db.upsertAccount(acc);
    const activeMap = new Map<string, number>();

    const scheduler = new AccountScheduler({
      dbStore: db,
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });

    // External unleased worker occupies 1 of 2 slots
    activeMap.set('acc-mix', 1);

    // Leased request 1 takes the 2nd slot (pending -> not yet in activeMap)
    const l1 = await scheduler.acquireAccountLease('gemini-4-hydrogen', 's-mix-1');
    expect(scheduler.getReservedCount('acc-mix')).toBe(1);

    // Leased request 2 MUST block because external(1) + pending(1) == 2 == concurrencyLimit
    let l2Resolved = false;
    const l2Promise = scheduler.acquireAccountLease('gemini-4-hydrogen', 's-mix-2').then((res) => {
      l2Resolved = true;
      return res;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(l2Resolved).toBe(false);

    // Request 1 acquires its worker: activeMap becomes 2 and onWorkerAcquired transitions lease to 'acquired'
    activeMap.set('acc-mix', 2);
    l1.onWorkerAcquired();

    // Even if unleased external worker finishes and calls coarse releaseSlot('acc-mix'),
    // l1's lease is untouched, and activeMap becomes 1 -> l2 wakes up!
    activeMap.set('acc-mix', 1);
    scheduler.releaseSlot('acc-mix');

    const l2 = await l2Promise;
    expect(l2Resolved).toBe(true);
    expect(scheduler.getReservedCount('acc-mix')).toBe(2);

    l1.release();
    l2.release();
    activeMap.set('acc-mix', 0);
    expect(scheduler.getReservedCount('acc-mix')).toBe(0);
  });

  it('releases worker before lease in finally across Gemini, Anthropic, and OpenAI', async () => {
    const acc = makeAccount('acc-order', { concurrencyLimit: 1 });
    db.upsertAccount(acc);
    const activeMap = new Map<string, number>();
    const scheduler = new AccountScheduler({
      dbStore: db,
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });
    const adaptedScheduler = createLeaseSchedulerAdapter(scheduler);

    const events: string[] = [];
    const wrappedScheduler: SchedulerLike = {
      ...adaptedScheduler,
      async selectAccount(params) {
        const res = await adaptedScheduler.selectAccount(params);
        if (!res.release) return res;
        const innerRelease = res.release;
        return {
          ...res,
          release: () => {
            events.push(`lease.release:active=${activeMap.get('acc-order') ?? 0}`);
            innerRelease();
          },
        };
      },
    };

    const workerPool: WorkerPoolLike = {
      async acquire({ account, sessionHash }) {
        activeMap.set(account.id, (activeMap.get(account.id) ?? 0) + 1);
        events.push(`worker.acquire:active=${activeMap.get(account.id)}`);
        return {
          id: `${account.id}:${sessionHash}`,
          accountId: account.id,
          async generate() {
            return {
              candidates: [
                { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 },
              ],
            };
          },
        };
      },
      release(worker: WorkerHandle) {
        activeMap.set(worker.accountId, Math.max(0, (activeMap.get(worker.accountId) ?? 0) - 1));
        events.push(`worker.release:active=${activeMap.get(worker.accountId)}`);
      },
    };

    const gemini = createGeminiHandler({ scheduler: wrappedScheduler, workerPool });
    const gRes = await gemini(
      new Request('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent', {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      }),
      new URL('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent'),
    );
    expect(gRes?.status).toBe(200);
    expect(events).toEqual([
      'worker.acquire:active=1',
      'worker.release:active=0',
      'lease.release:active=0',
    ]);
    expect(scheduler.getReservedCount('acc-order')).toBe(0);
  });

  it('releases lease on workerPool.acquire failure and cache-settling cancellation across all three protocols', async () => {
    const acc = makeAccount('acc-fail', { concurrencyLimit: 1 });
    db.upsertAccount(acc);
    const activeMap = new Map<string, number>();
    const scheduler = new AccountScheduler({
      dbStore: db,
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });
    const adaptedScheduler = createLeaseSchedulerAdapter(scheduler);

    const workerPool: WorkerPoolLike = {
      async acquire() {
        throw new WorkerError('spawn failed', { code: 'TRANSPORT_ERROR', upstreamStatus: 502 });
      },
      release() {},
    };

    const gemini = createGeminiHandler({ scheduler: adaptedScheduler, workerPool });
    const anthropic = createAnthropicHandler({ scheduler: adaptedScheduler, workerPool });
    const openai = createOpenAiHandler({ scheduler: adaptedScheduler, workerPool });

    const gRes = await gemini(
      new Request('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent', {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      }),
      new URL('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent'),
    );
    expect(gRes?.status).toBe(429);
    expect(scheduler.getReservedCount('acc-fail')).toBe(0);

    scheduler.clearCooldown('acc-fail', 'gemini-4-hydrogen');
    const aRes = await anthropic(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-4-hydrogen',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      new URL('http://localhost/v1/messages'),
    );
    expect(aRes?.status).toBe(429);
    expect(scheduler.getReservedCount('acc-fail')).toBe(0);

    scheduler.clearCooldown('acc-fail', 'gemini-4-hydrogen');
    const oRes = await openai(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-4-hydrogen',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      new URL('http://localhost/v1/chat/completions'),
    );
    expect(oRes?.status).toBe(429);
    expect(scheduler.getReservedCount('acc-fail')).toBe(0);

    // Cancellation during cache settling also releases the lease
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() => makeConfig({ cacheSettlingDelayMs: 500 })),
    );
    scheduler.clearCooldown('acc-fail', 'gemini-4-hydrogen');
    scheduler.recordSuccess('acc-fail', 'gemini-4-hydrogen', 'sess-cancel', {
      inputTokens: 18000,
      cachedTokens: 0,
    });
    const controller = new AbortController();
    const pending = scheduler.acquireAccountLease(
      'gemini-4-hydrogen',
      'sess-cancel',
      new Set(),
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('Client cancelled')), 25);
    await expect(pending).rejects.toThrow('Client cancelled');
    expect(scheduler.getReservedCount('acc-fail')).toBe(0);
  });

  it('same-account thought-only fallback enforces capacity, never clears/bypasses other cooldowns, and supports cancel release', async () => {
    const acc = makeAccount('acc-solo', { concurrencyLimit: 1 });
    db.upsertAccount(acc);
    const activeMap = new Map<string, number>();
    const scheduler = new AccountScheduler({
      dbStore: db,
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });
    const adaptedScheduler = createLeaseSchedulerAdapter(scheduler);

    // 1. Direct unit check: fallback must NOT bypass 429 QUOTA_EXHAUSTED or clear SOFT_ERROR
    scheduler.recordFailure('acc-solo', 'gemini-4-hydrogen', {
      upstreamStatus: 502,
      reasonCode: 'SOFT_ERROR',
      rawError: 'EMPTY_OR_THOUGHT_ONLY_RESPONSE',
    });
    const softLease = await scheduler.acquireFallbackAccountLease('acc-solo', 'gemini-4-hydrogen', 's-fb');
    // SOFT_ERROR cooldown must still exist in DB (never cleared)
    expect(db.listCooldowns(Date.now()).some((c) => c.accountId === 'acc-solo' && c.reason === 'SOFT_ERROR')).toBe(true);
    softLease.release();

    // If a 429 QUOTA_EXHAUSTED cooldown is recorded, fallback MUST NOT bypass it
    scheduler.recordFailure('acc-solo', 'gemini-4-hydrogen', {
      upstreamStatus: 429,
      reasonCode: 'QUOTA_EXHAUSTED',
      rawError: 'quota',
    });
    await expect(
      scheduler.acquireFallbackAccountLease('acc-solo', 'gemini-4-hydrogen', 's-fb'),
    ).rejects.toThrow(/cooldown/i);

    scheduler.clearCooldown('acc-solo', 'gemini-4-hydrogen');

    // 2. Concurrency & cancellation on fallback: when slot is occupied, fallback waits and aborts cleanly
    activeMap.set('acc-solo', 1);
    const fbAbort = new AbortController();
    const fbPending = scheduler.acquireFallbackAccountLease(
      'acc-solo',
      'gemini-4-hydrogen',
      's-fb-wait',
      fbAbort.signal,
    );
    setTimeout(() => fbAbort.abort(new Error('Fallback cancelled')), 25);
    await expect(fbPending).rejects.toThrow('Fallback cancelled');
    expect(scheduler.getReservedCount('acc-solo')).toBe(0);
    activeMap.set('acc-solo', 0);

    // 3. End-to-end OpenAI single-account thought-only rebuilds at most once and releases lease
    let attempts = 0;
    let shouldSucceedOnSecond = true;
    const workerPool: WorkerPoolLike = {
      async acquire({ account, sessionHash }) {
        activeMap.set(account.id, (activeMap.get(account.id) ?? 0) + 1);
        return {
          id: `${account.id}:${sessionHash}`,
          accountId: account.id,
          async generate() {
            attempts += 1;
            if (attempts === 1 || !shouldSucceedOnSecond) {
              throw new WorkerError('Model returned thought-only or empty response', {
                code: 'SOFT_ERROR',
                upstreamStatus: 502,
                rawError: 'EMPTY_OR_THOUGHT_ONLY_RESPONSE',
              });
            }
            return {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'recovered' }] },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
            };
          },
        };
      },
      release(worker: WorkerHandle) {
        activeMap.set(worker.accountId, Math.max(0, (activeMap.get(worker.accountId) ?? 0) - 1));
      },
    };

    const openai = createOpenAiHandler({ scheduler: adaptedScheduler, workerPool });

    const res1 = await openai(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-4-hydrogen',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
      new URL('http://localhost/v1/chat/completions'),
    );
    expect(res1?.status).toBe(200);
    expect(attempts).toBe(2);
    expect(scheduler.getReservedCount('acc-solo')).toBe(0);
    expect(activeMap.get('acc-solo') ?? 0).toBe(0);

    attempts = 0;
    shouldSucceedOnSecond = false;
    const res2 = await openai(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-4-hydrogen',
          messages: [{ role: 'user', content: 'hello again' }],
        }),
      }),
      new URL('http://localhost/v1/chat/completions'),
    );
    expect(res2?.status).toBe(502);
    expect(attempts).toBe(2);
    expect(scheduler.getReservedCount('acc-solo')).toBe(0);
    expect(activeMap.get('acc-solo') ?? 0).toBe(0);
  });

  it('prevents cascading pool exhaustion when accountFailover is false across Gemini, OpenAI, and Anthropic', async () => {
    const accounts = [
      makeAccount('acc-1', { concurrencyLimit: 2 }),
      makeAccount('acc-2', { concurrencyLimit: 2 }),
      makeAccount('acc-3', { concurrencyLimit: 2 }),
    ];
    const errorCases = [
      { code: 'QUOTA_EXHAUSTED' as const, upstreamStatus: 429, label: '429' },
      { code: 'AUTH_REQUIRED' as const, upstreamStatus: 401, label: '401' },
      { code: 'RESTRICTED' as const, upstreamStatus: 403, label: '403' },
      { code: 'SOFT_ERROR' as const, upstreamStatus: 402, label: '402' },
    ];

    for (const errCase of errorCases) {
      // Reset accounts & cooldowns per scenario
      for (const acc of accounts) {
        db.upsertAccount({ ...acc, status: 'ready' });
        db.deleteCooldown(acc.id, 'gemini-4-hydrogen', 'family');
        db.deleteCooldown(acc.id, '*', 'global');
      }

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            accountFailover: false,
            routingStrategy: 'performance-first',
          }),
        ),
      );

      const scheduler = new AccountScheduler({ dbStore: db });
      const adaptedScheduler = createLeaseSchedulerAdapter(scheduler);

      const protocolCalls: Array<{
        name: string;
        invoke: () => Promise<Response | null>;
      }> = [
        {
          name: 'gemini',
          invoke: () =>
            createGeminiHandler({
              scheduler: adaptedScheduler,
              workerPool: makeFailingPool(),
            })(
              new Request('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent', {
                method: 'POST',
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                }),
              }),
              new URL('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent'),
            ),
        },
        {
          name: 'openai',
          invoke: () =>
            createOpenAiHandler({
              scheduler: adaptedScheduler,
              workerPool: makeFailingPool(),
            })(
              new Request('http://localhost/v1/chat/completions', {
                method: 'POST',
                body: JSON.stringify({
                  model: 'gemini-4-hydrogen',
                  messages: [{ role: 'user', content: 'hi' }],
                }),
              }),
              new URL('http://localhost/v1/chat/completions'),
            ),
        },
        {
          name: 'anthropic',
          invoke: () =>
            createAnthropicHandler({
              scheduler: adaptedScheduler,
              workerPool: makeFailingPool(),
            })(
              new Request('http://localhost/v1/messages', {
                method: 'POST',
                body: JSON.stringify({
                  model: 'gemini-4-hydrogen',
                  max_tokens: 64,
                  messages: [{ role: 'user', content: 'hi' }],
                }),
              }),
              new URL('http://localhost/v1/messages'),
            ),
        },
      ];

      let touchedAccounts: string[] = [];
      function makeFailingPool(): WorkerPoolLike {
        return {
          async acquire({ account, sessionHash }) {
            touchedAccounts.push(account.id);
            return {
              id: `${account.id}:${sessionHash}`,
              accountId: account.id,
              async generate() {
                throw new WorkerError(`Simulated ${errCase.label}`, {
                  code: errCase.code,
                  upstreamStatus: errCase.upstreamStatus,
                });
              },
            };
          },
          release() {},
        };
      }

      for (const proto of protocolCalls) {
        for (const acc of accounts) {
          db.upsertAccount({ ...acc, status: 'ready' });
          db.deleteCooldown(acc.id, 'gemini-4-hydrogen', 'family');
          db.deleteCooldown(acc.id, '*', 'global');
        }
        touchedAccounts = [];
        const res = await proto.invoke();
        expect(res?.status).toBe(errCase.upstreamStatus);
        expect(touchedAccounts.length).toBe(1);
        const touchedId = touchedAccounts[0]!;
        const untouchedCooldowns = db
          .listCooldowns(Date.now())
          .filter((c) => c.accountId !== touchedId);
        expect(untouchedCooldowns.length).toBe(0);
      }

      spies.pop()?.mockRestore();
    }
  });

  it('caps 429/quota switches at maxQuotaAccountSwitches when accountFailover is true across all three protocols', async () => {
    const accounts = [
      makeAccount('acc-q1', { concurrencyLimit: 2 }),
      makeAccount('acc-q2', { concurrencyLimit: 2 }),
      makeAccount('acc-q3', { concurrencyLimit: 2 }),
    ];

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({
          accountFailover: true,
          maxQuotaAccountSwitches: 1,
          routingStrategy: 'performance-first',
        }),
      ),
    );

    const runProtocol = async (
      buildHandler: (scheduler: SchedulerLike, workerPool: WorkerPoolLike) => Promise<Response | null>,
    ) => {
      for (const acc of accounts) {
        db.upsertAccount({ ...acc, status: 'ready' });
        db.deleteCooldown(acc.id, 'gemini-4-hydrogen', 'family');
        db.deleteCooldown(acc.id, '*', 'global');
      }
      const scheduler = new AccountScheduler({ dbStore: db });
      const adaptedScheduler = createLeaseSchedulerAdapter(scheduler);
      const touched: string[] = [];
      const workerPool: WorkerPoolLike = {
        async acquire({ account, sessionHash }) {
          touched.push(account.id);
          return {
            id: `${account.id}:${sessionHash}`,
            accountId: account.id,
            async generate() {
              throw new WorkerError('Rate limit exceeded', {
                code: 'QUOTA_EXHAUSTED',
                upstreamStatus: 429,
              });
            },
          };
        },
        release() {},
      };

      const res = await buildHandler(adaptedScheduler, workerPool);
      expect(res?.status).toBe(429);
      // maxQuotaAccountSwitches = 1 -> 1 initial attempt + 1 switch = 2 attempts; 3rd account untouched
      expect(touched.length).toBe(2);
      const untouched = accounts.find((a) => !touched.includes(a.id));
      expect(untouched).toBeDefined();
      const untouchedCooldowns = db
        .listCooldowns(Date.now())
        .filter((c) => c.accountId === untouched!.id);
      expect(untouchedCooldowns.length).toBe(0);
    };

    await runProtocol((scheduler, workerPool) =>
      createGeminiHandler({ scheduler, workerPool })(
        new Request('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent', {
          method: 'POST',
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
        }),
        new URL('http://localhost/v1beta/models/gemini-4-hydrogen:generateContent'),
      ),
    );

    await runProtocol((scheduler, workerPool) =>
      createOpenAiHandler({ scheduler, workerPool })(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gemini-4-hydrogen',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        }),
        new URL('http://localhost/v1/chat/completions'),
      ),
    );

    await runProtocol((scheduler, workerPool) =>
      createAnthropicHandler({ scheduler, workerPool })(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gemini-4-hydrogen',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        }),
        new URL('http://localhost/v1/messages'),
      ),
    );
  });
});
