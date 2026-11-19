import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as settings from '../config/settings';
import { GatewayStore, store } from '../db/store';
import type { AccountQuotaSnapshot, AccountRecord, CooldownRecord, GatewayConfig, PoolQuotaSummary } from '../types';
import {
  AccountScheduler,
  CACHE_COLD_MS,
  CACHE_WORTH_TOKENS,
  HEAVY_COLD_PROMPT_TOKENS,
  isFullProAccount,
} from './scheduler';

function makeAccount(id: string, overrides: Partial<AccountRecord> = {}): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Account-${id}`,
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
    ...overrides,
  };
}

describe('AccountScheduler routing strategies', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
    settings.invalidateConfigCache();
  });

  it('performance-first ignores sessionKey sticky affinity and distributes across ready accounts', async () => {
    const accounts = [makeAccount('acc-1'), makeAccount('acc-2'), makeAccount('acc-3')];
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'performance-first' }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => accounts),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const acc = await scheduler.acquireAccount('gemini-2.5-flash', 'same-session-key');
      picked.push(acc.id);
    }

    expect(picked).toEqual(['acc-1', 'acc-2', 'acc-3', 'acc-1']);
  });

  it('cache-first waits briefly for a short-cooldown bound account and reuses it', async () => {
    const accounts = [makeAccount('acc-1'), makeAccount('acc-2')];
    let cooldownUntilMs = 0;

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'cache-first', queueWaitTimeoutMs: 5000 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => accounts),
      spyOn(store, 'listCooldowns').mockImplementation((now = Date.now()): CooldownRecord[] => {
        if (cooldownUntilMs > now) {
          return [
            {
              accountId: 'acc-1',
              family: 'gemini-2.5-flash',
              scopeType: 'family',
              reason: 'SOFT_ERROR',
              untilMs: cooldownUntilMs,
              consecutiveFailures: 1,
              lastError: 'transient',
            },
          ];
        }
        return [];
      }),
    );

    const scheduler = new AccountScheduler();
    // 首次绑定到特定账号（用 excludeAccountIds 固定首绑为 acc-1）
    const first = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-cache-1', new Set(['acc-2']));
    expect(first.id).toBe('acc-1');

    // acc-1 进入 60ms 短期冷却，acc-2 完全空闲，cache-first 应短暂等待并继续复用 acc-1
    cooldownUntilMs = Date.now() + 60;
    const second = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-cache-1');
    expect(second.id).toBe('acc-1');
  });

  it('cache-first waits briefly when bound account concurrency is full and reuses it once freed', async () => {
    const acc1 = makeAccount('acc-1', { concurrencyLimit: 1, activeWorkers: 0 });
    const acc2 = makeAccount('acc-2', { concurrencyLimit: 2, activeWorkers: 0 });
    const accounts = [acc1, acc2];

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'cache-first', queueWaitTimeoutMs: 5000 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => accounts),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    const first = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-queue-1', new Set(['acc-2']));
    expect(first.id).toBe('acc-1');

    acc1.activeWorkers = 1;
    setTimeout(() => {
      acc1.activeWorkers = 0;
    }, 45);

    const second = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-queue-1');
    expect(second.id).toBe('acc-1');
  });

  it('cache-first falls back to another account and updates binding when cooldown exceeds wait cap', async () => {
    const accounts = [makeAccount('acc-1'), makeAccount('acc-2')];
    let cooldownUntilMs = 0;

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'cache-first', queueWaitTimeoutMs: 80 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => accounts),
      spyOn(store, 'listCooldowns').mockImplementation((now = Date.now()): CooldownRecord[] => {
        if (cooldownUntilMs > now) {
          return [
            {
              accountId: 'acc-1',
              family: 'gemini-2.5-flash',
              scopeType: 'family',
              reason: 'QUOTA_EXHAUSTED',
              untilMs: cooldownUntilMs,
              consecutiveFailures: 1,
              lastError: '429',
            },
          ];
        }
        return [];
      }),
    );

    const scheduler = new AccountScheduler();
    const first = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-fallback-1', new Set(['acc-2']));
    expect(first.id).toBe('acc-1');

    // 冷却剩余时间 (500ms) > Math.min(queueWaitTimeoutMs=80, 15000)，应立即降级到 acc-2 并更新绑定
    cooldownUntilMs = Date.now() + 500;
    const fallback = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-fallback-1');
    expect(fallback.id).toBe('acc-2');

    // 冷却恢复后，因为绑定已更新为 acc-2，后续仍命中 acc-2
    cooldownUntilMs = 0;
    const afterRecovery = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-fallback-1');
    expect(afterRecovery.id).toBe('acc-2');
  });

  it('cache-first immediately switches when bound account is excluded or disabled', async () => {
    const acc1 = makeAccount('acc-1');
    const acc2 = makeAccount('acc-2');
    const accounts = [acc1, acc2];

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'cache-first', queueWaitTimeoutMs: 5000 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => accounts),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    const first = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-excl-1', new Set(['acc-2']));
    expect(first.id).toBe('acc-1');

    // 在 excludeAccountIds 中失败过 -> 立刻切换并更新绑定
    const excludedPick = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-excl-1', new Set(['acc-1']));
    expect(excludedPick.id).toBe('acc-2');

    // 再次绑定回 acc-1 后把它置为 auth_required -> 立刻切换
    const rebind = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-excl-1', new Set(['acc-2']));
    expect(rebind.id).toBe('acc-1');

    acc1.status = 'auth_required';
    const disabledPick = await scheduler.acquireAccount('gemini-2.5-flash', 'sess-excl-1');
    expect(disabledPick.id).toBe('acc-2');
  });

  it('settings validates routingStrategy enum and rejects unknown values', () => {
    let stored: Record<string, unknown> | undefined;
    spies.push(
      spyOn(store, 'getConfigValue').mockImplementation(() => stored as never),
      spyOn(store, 'setConfigValue').mockImplementation((_k, val) => {
        stored = val as Record<string, unknown>;
      }),
    );

    const updated1 = settings.updateConfig({ routingStrategy: 'cache-first' });
    expect(updated1.routingStrategy).toBe('cache-first');

    const updated2 = settings.updateConfig({ routingStrategy: 'performance-first' });
    expect(updated2.routingStrategy).toBe('performance-first');

    const invalid = settings.updateConfig({ routingStrategy: 'invalid-mode' as never });
    expect(invalid.routingStrategy).toBe('performance-first');
  });

  it('persists sticky affinity to SQLite and restores it across scheduler restarts; abandonSession deletes it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agy-sticky-test-'));
    const dbPath = join(tempDir, 'gateway.db');
    let db1: GatewayStore | null = null;
    let db2: GatewayStore | null = null;

    try {
      db1 = new GatewayStore(dbPath);
      const acc1 = makeAccount('acc-1');
      const acc2 = makeAccount('acc-2');
      db1.upsertAccount(acc1);
      db1.upsertAccount(acc2);

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({ routingStrategy: 'cache-first', queueWaitTimeoutMs: 5000 }),
        ),
      );

      const sched1 = new AccountScheduler(db1);
      const picked1 = await sched1.acquireAccount('gemini-4-hydrogen', 'sess-persist-1', new Set(['acc-2']));
      expect(picked1.id).toBe('acc-1');

      sched1.recordSuccess('acc-1', 'gemini-4-hydrogen', 'sess-persist-1', {
        inputTokens: 2048,
        cachedTokens: 512,
      });

      const persistedRows = db1.loadStickyAffinities();
      expect(persistedRows.length).toBe(1);
      expect(persistedRows[0]!.stickyKey).toBe('sess-persist-1');
      expect(persistedRows[0]!.accountId).toBe('acc-1');
      expect(persistedRows[0]!.cachedTokens).toBe(512);
      expect(persistedRows[0]!.cacheWrittenAt).toBeGreaterThan(0);

      db1.close();
      db1 = null;

      // Simulate process restart with a fresh GatewayStore + AccountScheduler
      db2 = new GatewayStore(dbPath);
      const sched2 = new AccountScheduler(db2);
      const restored = sched2.getStickyEntry('sess-persist-1');
      expect(restored?.accountId).toBe('acc-1');
      expect(restored?.cachedTokens).toBe(512);

      const picked2 = await sched2.acquireAccount('gemini-4-hydrogen', 'sess-persist-1');
      expect(picked2.id).toBe('acc-1');

      // abandonSession removes from both memory and SQLite
      sched2.abandonSession('sess-persist-1', 'gemini-4-hydrogen');
      expect(sched2.getStickyEntry('sess-persist-1')).toBeUndefined();
      expect(db2.loadStickyAffinities().length).toBe(0);

      db2.close();
      db2 = null;
    } finally {
      db1?.close();
      db2?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('protects first-turn cacheWorth (inputTokens >= 1024, cachedTokens === 0) within cold window even under performance-first', async () => {
    const accounts = [makeAccount('acc-1'), makeAccount('acc-2'), makeAccount('acc-3')];
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'performance-first', queueWaitTimeoutMs: 5000 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => accounts),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    const sessKey = `sess-cacheworth-${Date.now()}`;

    // Turn 1 completes on acc-2 with cachedTokens === 0 but inputTokens >= CACHE_WORTH_TOKENS (1024)
    scheduler.recordSuccess('acc-2', 'gemini-4-hydrogen', sessKey, {
      inputTokens: CACHE_WORTH_TOKENS,
      cachedTokens: 0,
    });

    const entry = scheduler.getStickyEntry(sessKey);
    expect(entry?.accountId).toBe('acc-2');
    expect(entry?.cachedTokens).toBe(0);
    expect(entry?.cacheWrittenAt).toBeGreaterThan(0);

    // Within CACHE_COLD_MS (5 min), subsequent acquires force sticky affinity to acc-2
    for (let i = 0; i < 4; i++) {
      const picked = await scheduler.acquireAccount('gemini-4-hydrogen', sessKey);
      expect(picked.id).toBe('acc-2');
    }

    // Once cold window has expired and cachedTokens === 0, performance-first resumes round-robin
    const liveEntry = scheduler.getStickyEntry(sessKey);
    expect(liveEntry).toBeDefined();
    if (liveEntry) {
      liveEntry.cacheWrittenAt = Date.now() - CACHE_COLD_MS - 1000;
    }
    const afterCold1 = await scheduler.acquireAccount('gemini-4-hydrogen', sessKey);
    const afterCold2 = await scheduler.acquireAccount('gemini-4-hydrogen', sessKey);
    expect(afterCold1.id).not.toBe(afterCold2.id);

    scheduler.abandonSession(sessKey);
  });

  it('releaseSlot immediately wakes waiting acquireAccount well under 100ms polling interval', async () => {
    const acc1 = makeAccount('acc-1', { concurrencyLimit: 1, activeWorkers: 1 });
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'sticky-round-robin', queueWaitTimeoutMs: 5000 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc1]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    const startMs = performance.now();
    const pending = scheduler.acquireAccount('gemini-4-hydrogen');

    setTimeout(() => {
      acc1.activeWorkers = 0;
      scheduler.releaseSlot('acc-1');
    }, 5);

    const picked = await pending;
    const elapsedMs = performance.now() - startMs;

    expect(picked.id).toBe('acc-1');
    expect(elapsedMs).toBeLessThan(60);
  });

  it('recordSuccess wakes waiting cache-first acquireAccount when cooldown is cleared', async () => {
    const acc1 = makeAccount('acc-1', { concurrencyLimit: 1, activeWorkers: 0 });
    const acc2 = makeAccount('acc-2', { concurrencyLimit: 1, activeWorkers: 0 });
    let cooling = false;

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'cache-first', queueWaitTimeoutMs: 5000 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc1, acc2]),
      spyOn(store, 'listCooldowns').mockImplementation((now = Date.now()): CooldownRecord[] =>
        cooling
          ? [
              {
                accountId: 'acc-1',
                family: 'gemini-4-hydrogen',
                scopeType: 'family',
                reason: 'SOFT_ERROR',
                untilMs: now + 5000,
                consecutiveFailures: 1,
                lastError: 'transient',
              },
            ]
          : [],
      ),
      spyOn(store, 'deleteCooldown').mockImplementation(() => {
        const wasCooling = cooling;
        cooling = false;
        return wasCooling;
      }),
    );

    const scheduler = new AccountScheduler();
    const first = await scheduler.acquireAccount('gemini-4-hydrogen', 'sess-wake-cd', new Set(['acc-2']));
    expect(first.id).toBe('acc-1');

    cooling = true;
    const startMs = performance.now();
    const pending = scheduler.acquireAccount('gemini-4-hydrogen', 'sess-wake-cd');

    setTimeout(() => {
      scheduler.recordSuccess('acc-1', 'gemini-4-hydrogen', 'sess-wake-cd');
    }, 5);

    const second = await pending;
    const elapsedMs = performance.now() - startMs;

    expect(second.id).toBe('acc-1');
    expect(elapsedMs).toBeLessThan(60);
  });

  it('removes a queued waiter synchronously when its request is cancelled', async () => {
    const account = makeAccount('cancel-waiter', { concurrencyLimit: 1, activeWorkers: 1 });
    spies.push(
      spyOn(settings, 'getConfig').mockReturnValue(makeConfig()),
      spyOn(store, 'listAccounts').mockReturnValue([account]),
      spyOn(store, 'listCooldowns').mockReturnValue([]),
    );
    const scheduler = new AccountScheduler();
    const { waiters } = scheduler as unknown as { waiters: Set<() => void> };
    const controller = new AbortController();
    const pending = scheduler.acquireAccount('gemini-3.8-flash-medium', undefined, new Set(), controller.signal);
    expect(waiters.size).toBe(1);
    controller.abort();
    expect(waiters.size).toBe(0);
    await expect(pending).rejects.toBe(controller.signal.reason);
  });

  it('defaults streamThoughtImmediately to false, caches getConfig in memory, and syncs on updateConfig', () => {
    settings.invalidateConfigCache();
    let stored: Record<string, unknown> | undefined;
    const getSpy = spyOn(store, 'getConfigValue').mockImplementation(() => stored as never);
    const setSpy = spyOn(store, 'setConfigValue').mockImplementation((_k, val) => {
      stored = val as Record<string, unknown>;
    });
    spies.push(getSpy, setSpy);

    // 思考块默认不再即时透传：先缓冲，等真正出现正文再统一下发（handler 侧配合 alt=sse 提前放行 200 + keepalive）。
    expect(settings.DEFAULT_CONFIG.streamThoughtImmediately).toBe(false);

    const cfg1 = settings.getConfig();
    const cfg2 = settings.getConfig();
    const cfg3 = settings.getConfig();

    expect(cfg1.streamThoughtImmediately).toBe(false);
    expect(cfg2.streamThoughtImmediately).toBe(false);
    expect(cfg3.port).toBe(settings.DEFAULT_CONFIG.port);
    expect(getSpy.mock.calls.length).toBe(1);

    const updated = settings.updateConfig({ streamThoughtImmediately: true, port: 9048 });
    expect(updated.streamThoughtImmediately).toBe(true);
    expect(updated.port).toBe(8048);
    expect(setSpy.mock.calls.length).toBe(1);

    // updateConfig updates cache synchronously without re-reading SQLite
    const afterUpdate = settings.getConfig();
    expect(afterUpdate.streamThoughtImmediately).toBe(true);
    expect(afterUpdate.port).toBe(8048);
    expect(getSpy.mock.calls.length).toBe(1);

    // Older persisted port values cannot change the effective listening port.
    stored = { ...stored, port: 9048 };
    settings.invalidateConfigCache();
    const afterInvalidate = settings.getConfig();
    expect(afterInvalidate.streamThoughtImmediately).toBe(true);
    expect(afterInvalidate.port).toBe(8048);
    expect(getSpy.mock.calls.length).toBe(2);
  });

  it('uses injected getActiveCount for concurrency limit, fill-first ordering, and releaseSlot wakeup', async () => {
    // DB activeWorkers stays 0 (simulating in-memory pool tracking)
    const acc1 = makeAccount('acc-mem-1', { concurrencyLimit: 1, activeWorkers: 0 });
    const acc2 = makeAccount('acc-mem-2', { concurrencyLimit: 2, activeWorkers: 0 });
    const activeMap = new Map<string, number>([
      ['acc-mem-1', 1],
      ['acc-mem-2', 1],
    ]);

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'fill-first', queueWaitTimeoutMs: 500 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc1, acc2]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler({
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });

    // acc-mem-1 is at 1/1 (full), acc-mem-2 is at 1/2 (has slot)
    const picked1 = await scheduler.acquireAccount('gemini-4-hydrogen');
    expect(picked1.id).toBe('acc-mem-2');

    // Now fill acc-mem-2 to 2/2 -> both full -> acquireAccount waits until releaseSlot
    activeMap.set('acc-mem-2', 2);
    const startMs = performance.now();
    const pending = scheduler.acquireAccount('gemini-4-hydrogen');

    setTimeout(() => {
      activeMap.set('acc-mem-1', 0);
      scheduler.releaseSlot('acc-mem-1');
    }, 10);

    const picked2 = await pending;
    expect(picked2.id).toBe('acc-mem-1');
    expect(performance.now() - startMs).toBeLessThan(80);
  });

  it('prioritizes full Pro (with gemini_flagship) over other Pro and standard accounts', async () => {
    const flagshipPool: PoolQuotaSummary = {
      pool: 'gemini_flagship',
      label: 'G4 Argon',
      percentage: 100,
      remainingFraction: 1,
      resetTime: null,
      modelCount: 1,
      bottleneckModel: null,
      window5h: 100,
      windowWeekly: 100,
      models: [],
    };
    const fullProQuota: AccountQuotaSnapshot = {
      fetchedAt: Date.now(),
      pools: {
        gemini_flagship: flagshipPool,
        gemini_flash: null,
        third_party: null,
      },
    };
    const noFlagshipQuota: AccountQuotaSnapshot = {
      fetchedAt: Date.now(),
      pools: {
        gemini_flagship: null,
        gemini_flash: null,
        third_party: null,
      },
    };

    const fullPro = makeAccount('acc-full-pro', { tier: 'pro', quota: fullProQuota });
    const otherPro = makeAccount('acc-other-pro', { tier: 'pro', quota: noFlagshipQuota });
    const noQuotaPro = makeAccount('acc-no-quota-pro', { tier: 'pro', quota: null });
    const standardAcc = makeAccount('acc-std', { tier: 'standard', quota: fullProQuota });

    expect(isFullProAccount(fullPro)).toBe(true);
    expect(isFullProAccount(otherPro)).toBe(false);
    expect(isFullProAccount(noQuotaPro)).toBe(false);
    expect(isFullProAccount(standardAcc)).toBe(false);

    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ routingStrategy: 'performance-first', queueWaitTimeoutMs: 500 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [standardAcc, otherPro, noQuotaPro, fullPro]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();

    // 1. All available -> only fullPro is selected
    for (let i = 0; i < 4; i++) {
      const picked = await scheduler.acquireAccount('gemini-4-hydrogen');
      expect(picked.id).toBe('acc-full-pro');
    }

    // 2. fullPro excluded -> falls back to other pro accounts (never standard)
    const excludedFull = new Set(['acc-full-pro']);
    for (let i = 0; i < 4; i++) {
      const picked = await scheduler.acquireAccount('gemini-4-hydrogen', undefined, excludedFull);
      expect(['acc-other-pro', 'acc-no-quota-pro']).toContain(picked.id);
    }

    // 3. All pro excluded -> falls back to standard
    const excludedAllPro = new Set(['acc-full-pro', 'acc-other-pro', 'acc-no-quota-pro']);
    const fallbackStd = await scheduler.acquireAccount('gemini-4-hydrogen', undefined, excludedAllPro);
    expect(fallbackStd.id).toBe('acc-std');
  });
});

describe('AUTH_REQUIRED failure handling distinguishes expired tokens from transport jitter', () => {
  const dirs: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function accountWithToken(id: string, expiry: Date): AccountRecord {
    const homeDir = mkdtempSync(join(tmpdir(), 'agy-auth-'));
    dirs.push(homeDir);
    mkdirSync(join(homeDir, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(
      join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { expiry: expiry.toISOString() } }),
    );
    return makeAccount(id, { homeDir });
  }

  it('keeps the account ready and only cools it down when the access token is still valid', () => {
    const account = accountWithToken('acc-valid-token', new Date(Date.now() + 30 * 60_000));
    const upsertAccount = spyOn(store, 'upsertAccount');
    const upsertCooldown = spyOn(store, 'upsertCooldown').mockImplementation(() => {});
    spies.push(upsertAccount, upsertCooldown, spyOn(store, 'getAccount').mockImplementation(() => account));

    new AccountScheduler().recordFailure(account.id, 'gemini-4-hydrogen', {
      reasonCode: 'AUTH_REQUIRED',
      upstreamStatus: 401,
      rawError: 'Authentication required',
    });

    expect(upsertAccount).not.toHaveBeenCalled();
    expect(upsertCooldown).toHaveBeenCalledTimes(1);
  });

  it('marks the account auth_required when the access token really expired', () => {
    const account = accountWithToken('acc-expired-token', new Date(Date.now() - 60_000));
    const upsertAccount = spyOn(store, 'upsertAccount').mockImplementation(() => {});
    const upsertCooldown = spyOn(store, 'upsertCooldown').mockImplementation(() => {});
    spies.push(upsertAccount, upsertCooldown, spyOn(store, 'getAccount').mockImplementation(() => account));

    new AccountScheduler().recordFailure(account.id, 'gemini-4-hydrogen', {
      reasonCode: 'AUTH_REQUIRED',
      upstreamStatus: 401,
      rawError: 'Authentication required',
    });

    expect(upsertAccount).toHaveBeenCalledTimes(1);
    expect(upsertCooldown).not.toHaveBeenCalled();
  });
});

describe('Cache Settling Grace Window', () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  const origAgyEnv = process.env.AGY_CACHE_SETTLING_DELAY_MS;
  const origAntigravityEnv = process.env.ANTIGRAVITY_CACHE_SETTLING_DELAY_MS;

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
    if (origAgyEnv === undefined) {
      delete process.env.AGY_CACHE_SETTLING_DELAY_MS;
    } else {
      process.env.AGY_CACHE_SETTLING_DELAY_MS = origAgyEnv;
    }
    if (origAntigravityEnv === undefined) {
      delete process.env.ANTIGRAVITY_CACHE_SETTLING_DELAY_MS;
    } else {
      process.env.ANTIGRAVITY_CACHE_SETTLING_DELAY_MS = origAntigravityEnv;
    }
    settings.invalidateConfigCache();
  });

  it('validates cacheSettlingDelayMs defaults, bounds clamping, fallback, public config, and env overrides', () => {
    delete process.env.AGY_CACHE_SETTLING_DELAY_MS;
    delete process.env.ANTIGRAVITY_CACHE_SETTLING_DELAY_MS;
    settings.invalidateConfigCache();

    let stored: Record<string, unknown> | undefined;
    spies.push(
      spyOn(store, 'getConfigValue').mockImplementation(() => stored as never),
      spyOn(store, 'setConfigValue').mockImplementation((_k, val) => {
        stored = val as Record<string, unknown>;
      }),
    );

    expect(settings.DEFAULT_CONFIG.cacheSettlingDelayMs).toBe(1000);
    expect(settings.getConfig().cacheSettlingDelayMs).toBe(1000);
    expect(settings.getPublicConfig().cacheSettlingDelayMs).toBe(1000);

    // 0 disables, 5000 upper bound, out-of-range clamps, non-integer rounds
    expect(settings.updateConfig({ cacheSettlingDelayMs: 0 }).cacheSettlingDelayMs).toBe(0);
    expect(settings.updateConfig({ cacheSettlingDelayMs: 5000 }).cacheSettlingDelayMs).toBe(5000);
    expect(settings.updateConfig({ cacheSettlingDelayMs: -50 }).cacheSettlingDelayMs).toBe(0);
    expect(settings.updateConfig({ cacheSettlingDelayMs: 9999 }).cacheSettlingDelayMs).toBe(5000);
    expect(settings.updateConfig({ cacheSettlingDelayMs: 1234.6 }).cacheSettlingDelayMs).toBe(1235);
    expect(settings.getPublicConfig().cacheSettlingDelayMs).toBe(1235);

    // Invalid value falls back to default (1000)
    expect(
      settings.updateConfig({ cacheSettlingDelayMs: Number.NaN }).cacheSettlingDelayMs,
    ).toBe(1000);
    expect(
      settings.updateConfig({ cacheSettlingDelayMs: 'bad' as unknown as number }).cacheSettlingDelayMs,
    ).toBe(1000);

    // Env overrides take effect after invalidateConfigCache()
    process.env.ANTIGRAVITY_CACHE_SETTLING_DELAY_MS = '350';
    settings.invalidateConfigCache();
    expect(settings.getConfig().cacheSettlingDelayMs).toBe(350);

    process.env.AGY_CACHE_SETTLING_DELAY_MS = '250';
    settings.invalidateConfigCache();
    expect(settings.getConfig().cacheSettlingDelayMs).toBe(250);

    // Out-of-range env value is ignored
    process.env.AGY_CACHE_SETTLING_DELAY_MS = '6000';
    settings.invalidateConfigCache();
    expect(settings.getConfig().cacheSettlingDelayMs).toBe(1000);
  });

  it('waits approximately remainingMs for same (accountId, sessionHash) after heavy cold prompt', async () => {
    expect(HEAVY_COLD_PROMPT_TOKENS).toBe(16000);
    const acc = makeAccount('acc-cold-wait');
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ cacheSettlingDelayMs: 140 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    const first = await scheduler.acquireAccount('gemini-4-hydrogen', 'sess-heavy-cold');
    expect(first.id).toBe('acc-cold-wait');

    scheduler.recordSuccess('acc-cold-wait', 'gemini-4-hydrogen', 'sess-heavy-cold', {
      inputTokens: 16500,
      cachedTokens: 0,
    });

    const startMs = performance.now();
    const second = await scheduler.acquireAccount('gemini-4-hydrogen', 'sess-heavy-cold');
    const elapsedMs = performance.now() - startMs;

    expect(second.id).toBe('acc-cold-wait');
    expect(elapsedMs).toBeGreaterThanOrEqual(105);
    expect(elapsedMs).toBeLessThan(350);
  });

  it('passes through with 0 delay for warm cache-hit requests and does not refresh cold timestamp', async () => {
    const acc = makeAccount('acc-warm-fast');
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ cacheSettlingDelayMs: 200 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    await scheduler.acquireAccount('gemini-4-hydrogen', 'sess-warm-1');

    // input=20000, cached=18000 => uncached=2000 < 16000
    scheduler.recordSuccess('acc-warm-fast', 'gemini-4-hydrogen', 'sess-warm-1', {
      inputTokens: 20000,
      cachedTokens: 18000,
    });

    const startMs = performance.now();
    await scheduler.acquireAccount('gemini-4-hydrogen', 'sess-warm-1');
    const elapsedMs = performance.now() - startMs;

    expect(elapsedMs).toBeLessThan(50);
  });

  it('does not block concurrent requests with different sessionHash values', async () => {
    const acc = makeAccount('acc-concurrent', { concurrencyLimit: 4 });
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ cacheSettlingDelayMs: 250 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler();
    scheduler.recordSuccess('acc-concurrent', 'gemini-4-hydrogen', 'sess-A', {
      inputTokens: 18000,
      cachedTokens: 0,
    });

    const startB = performance.now();
    const pickedB = await scheduler.acquireAccount('gemini-4-hydrogen', 'sess-B');
    const elapsedB = performance.now() - startB;

    expect(pickedB.id).toBe('acc-concurrent');
    expect(elapsedB).toBeLessThan(50);
  });

  it('aborts immediately during settling wait without leaking activeCount slots', async () => {
    const acc = makeAccount('acc-abort-clean', { concurrencyLimit: 2 });
    const activeMap = new Map<string, number>();
    spies.push(
      spyOn(settings, 'getConfig').mockImplementation(() =>
        makeConfig({ cacheSettlingDelayMs: 500 }),
      ),
      spyOn(store, 'listAccounts').mockImplementation(() => [acc]),
      spyOn(store, 'listCooldowns').mockImplementation(() => []),
    );

    const scheduler = new AccountScheduler({
      getActiveCount: (id) => activeMap.get(id) ?? 0,
    });
    scheduler.recordSuccess('acc-abort-clean', 'gemini-4-hydrogen', 'sess-abort-1', {
      inputTokens: 17000,
      cachedTokens: 0,
    });

    const controller = new AbortController();
    const startMs = performance.now();
    const acquireAndOccupy = async () => {
      const picked = await scheduler.acquireAccount(
        'gemini-4-hydrogen',
        'sess-abort-1',
        new Set(),
        controller.signal,
      );
      activeMap.set(picked.id, (activeMap.get(picked.id) ?? 0) + 1);
      return picked;
    };

    const pending = acquireAndOccupy();
    setTimeout(() => controller.abort(new Error('Client aborted during settling')), 40);

    await expect(pending).rejects.toThrow('Client aborted during settling');
    const elapsedMs = performance.now() - startMs;
    expect(elapsedMs).toBeLessThan(200);
    expect(activeMap.get('acc-abort-clean') ?? 0).toBe(0);
  });
});
