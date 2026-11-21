import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as settings from '../src/config/settings';
import { store } from '../src/db/store';
import {
  AccountQueueTimeoutError,
  AccountScheduler,
  AllAccountsCooldownError,
} from '../src/accounts/scheduler';
import type { AccountRecord, CooldownRecord, GatewayConfig } from '../src/types';

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
    exitIp: '10.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
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
    minAccountRequestIntervalMs: 0,
    minExitIpRequestIntervalMs: 0,
    requestJitterMs: 0,
    ...overrides,
  };
}

describe('wp3_scheduler_risk_control', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
    settings.invalidateConfigCache();
  });

  describe('Guardrail 1: maxConcurrencyPerExitIp', () => {
    it('prefers accounts on other exitIps once an exitIp reaches maxConcurrencyPerExitIp', async () => {
      const accA1 = makeAccount('acc-a1', { exitIp: '10.0.0.1', concurrencyLimit: 4 });
      const accA2 = makeAccount('acc-a2', { exitIp: '10.0.0.1', concurrencyLimit: 4 });
      const accB1 = makeAccount('acc-b1', { exitIp: '10.0.0.2', concurrencyLimit: 4 });

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            routingStrategy: 'performance-first',
            maxConcurrencyPerExitIp: 2,
          }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [accA1, accA2, accB1]),
        spyOn(store, 'listCooldowns').mockImplementation(() => []),
      );

      const scheduler = new AccountScheduler();
      const l1 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      const l2 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      // First two round-robin picks land on acc-a1 and acc-a2, filling 10.0.0.1 (2/2)
      expect([l1.account.id, l2.account.id]).toEqual(['acc-a1', 'acc-a2']);

      // 3rd lease must still skip 10.0.0.1 even if acc-a1/acc-a2 have per-account slots left
      const l3 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      expect(l3.account.id).toBe('acc-b1');

      // 4th lease when 10.0.0.2 also has 1/2 -> goes to acc-b1
      const l4 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      expect(l4.account.id).toBe('acc-b1');

      l1.release();
      l2.release();
      l3.release();
      l4.release();
    });

    it('queues and wakes on release (or times out) when all accounts share a full exitIp', async () => {
      const accA1 = makeAccount('acc-a1', { exitIp: '10.0.0.1', concurrencyLimit: 4 });
      const accA2 = makeAccount('acc-a2', { exitIp: '10.0.0.1', concurrencyLimit: 4 });

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            routingStrategy: 'performance-first',
            maxConcurrencyPerExitIp: 2,
            queueWaitTimeoutMs: 500,
          }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [accA1, accA2]),
        spyOn(store, 'listCooldowns').mockImplementation(() => []),
      );

      const scheduler = new AccountScheduler();
      const l1 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      const l2 = await scheduler.acquireAccountLease('gemini-4-hydrogen');

      let resolved3 = false;
      const p3 = scheduler.acquireAccountLease('gemini-4-hydrogen').then((res) => {
        resolved3 = true;
        return res;
      });

      await new Promise((r) => setTimeout(r, 25));
      expect(resolved3).toBe(false);

      // Releasing l1 frees 10.0.0.1 capacity and wakes p3
      l1.release();
      const l3 = await p3;
      expect(resolved3).toBe(true);

      // Now 10.0.0.1 is 2/2 again (l2 + l3); a 4th request must time out instead of over-dispatching
      await expect(scheduler.acquireAccountLease('gemini-4-hydrogen')).rejects.toThrow(
        AccountQueueTimeoutError,
      );

      l2.release();
      l3.release();
    });

    it('disables exitIp cap when maxConcurrencyPerExitIp is 0 and ignores empty exitIp', async () => {
      const accEmpty1 = makeAccount('acc-e1', { exitIp: '', concurrencyLimit: 2 });
      const accEmpty2 = makeAccount('acc-e2', { exitIp: '', concurrencyLimit: 2 });

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            routingStrategy: 'performance-first',
            maxConcurrencyPerExitIp: 1,
          }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [accEmpty1, accEmpty2]),
        spyOn(store, 'listCooldowns').mockImplementation(() => []),
      );

      const scheduler = new AccountScheduler();
      const l1 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      const l2 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      const l3 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      expect([l1.account.id, l2.account.id, l3.account.id]).toEqual([
        'acc-e1',
        'acc-e2',
        'acc-e1',
      ]);
      l1.release();
      l2.release();
      l3.release();
    });
  });

  describe('Guardrail 2: dispatch pacing (account interval + exitIp interval + jitter)', () => {
    it('gives 0 delay on cold requests and paces hot same-account & same-exitIp requests with jitter', async () => {
      let fakeNow = 10_000;
      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            minAccountRequestIntervalMs: 120,
            minExitIpRequestIntervalMs: 50,
            requestJitterMs: 40,
          }),
        ),
      );

      const scheduler = new AccountScheduler({
        now: () => fakeNow,
        random: () => 0.5, // floor(0.5 * 41) = 20ms jitter
      });

      // Cold request on acc-1 / 1.1.1.1 -> 0ms
      const w1 = await scheduler.awaitDispatchPacing('acc-1', '1.1.1.1');
      expect(w1).toBe(0);

      // Hot request on same acc-1 at +20ms -> accWait = 100, ipWait = 30 -> max=100 + 20 jitter = 120ms
      fakeNow += 20;
      const startSameAcc = performance.now();
      const w2 = await scheduler.awaitDispatchPacing('acc-1', '1.1.1.1');
      const elapsedSameAcc = performance.now() - startSameAcc;
      expect(w2).toBe(120);
      expect(elapsedSameAcc).toBeGreaterThanOrEqual(95);
      fakeNow += w2;

      // Hot request on DIFFERENT account acc-2 sharing SAME exitIp 1.1.1.1 immediately after
      const w3 = await scheduler.awaitDispatchPacing('acc-2', '1.1.1.1');
      // accWait = 0 (acc-2 is cold), ipWait = 50 -> 50 + 20 jitter = 70ms
      expect(w3).toBe(70);
      fakeNow += w3;

      // Different account on DIFFERENT exitIp -> 0ms
      const w4 = await scheduler.awaitDispatchPacing('acc-3', '2.2.2.2');
      expect(w4).toBe(0);
    });

    it('applies dispatch pacing during acquireAccountLease and rolls back on abort', async () => {
      const acc = makeAccount('acc-pace', { exitIp: '9.9.9.9', concurrencyLimit: 4 });
      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            minAccountRequestIntervalMs: 80,
            minExitIpRequestIntervalMs: 40,
            requestJitterMs: 0,
          }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [acc]),
        spyOn(store, 'listCooldowns').mockImplementation(() => []),
      );

      const scheduler = new AccountScheduler();
      const l1 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      l1.release();

      // Aborting second lease during pacing sleep should reject with AbortError and release lease
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15);
      await expect(
        scheduler.acquireAccountLease('gemini-4-hydrogen', undefined, new Set(), controller.signal),
      ).rejects.toThrow();
      expect(scheduler.getReservedCount('acc-pace')).toBe(0);

      // Subsequent lease still respects pacing cleanly
      const start = performance.now();
      const l2 = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45);
      l2.release();
    });
  });

  describe('Guardrail 3: maxWorkerSpawnsPerMinute', () => {
    it('tracks 60s sliding window spawns and excludes rate-limited accounts from selection', async () => {
      let fakeNow = 100_000;
      const acc1 = makeAccount('acc-storm', { exitIp: '10.0.0.1' });
      const acc2 = makeAccount('acc-calm', { exitIp: '10.0.0.2' });

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({
            routingStrategy: 'cache-first',
            maxWorkerSpawnsPerMinute: 3,
            queueWaitTimeoutMs: 120,
          }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [acc1, acc2]),
        spyOn(store, 'listCooldowns').mockImplementation(() => []),
      );

      const scheduler = new AccountScheduler({ now: () => fakeNow });

      // Bind sticky session to acc-storm
      const first = await scheduler.acquireAccountLease('gemini-4-hydrogen', 'sess-storm', new Set(['acc-calm']));
      expect(first.account.id).toBe('acc-storm');
      first.release();

      // Record 3 worker spawns within 60s on acc-storm
      scheduler.recordWorkerSpawn('acc-storm', fakeNow);
      expect(scheduler.isWorkerSpawnRateLimited('acc-storm', fakeNow)).toBe(false);
      scheduler.recordWorkerSpawn('acc-storm', fakeNow + 1_000);
      expect(scheduler.isWorkerSpawnRateLimited('acc-storm', fakeNow + 1_000)).toBe(false);
      scheduler.recordWorkerSpawn('acc-storm', fakeNow + 2_000);
      expect(scheduler.isWorkerSpawnRateLimited('acc-storm', fakeNow + 2_000)).toBe(true);

      // Sticky session must bypass rate-limited acc-storm and route to acc-calm
      const second = await scheduler.acquireAccountLease('gemini-4-hydrogen', 'sess-storm');
      expect(second.account.id).toBe('acc-calm');
      second.release();

      // If acc-calm is also rate-limited, acquireAccountLease times out instead of spawning
      scheduler.recordWorkerSpawn('acc-calm', fakeNow);
      scheduler.recordWorkerSpawn('acc-calm', fakeNow + 500);
      scheduler.recordWorkerSpawn('acc-calm', fakeNow + 1_000);
      await expect(scheduler.acquireAccountLease('gemini-4-hydrogen')).rejects.toThrow(
        AccountQueueTimeoutError,
      );

      // Advance clock past 60s window from first spawn -> acc-storm recovers
      fakeNow += 60_000;
      expect(scheduler.isWorkerSpawnRateLimited('acc-storm', fakeNow)).toBe(false);
      const recovered = await scheduler.acquireAccountLease('gemini-4-hydrogen');
      expect(recovered.account.id).toBe('acc-storm');
      recovered.release();
    });

    it('disables spawn rate limit when maxWorkerSpawnsPerMinute is 0', () => {
      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({ maxWorkerSpawnsPerMinute: 0 }),
        ),
      );
      const scheduler = new AccountScheduler();
      for (let i = 0; i < 50; i++) {
        scheduler.recordWorkerSpawn('acc-unlimited', 1000 + i);
      }
      expect(scheduler.isWorkerSpawnRateLimited('acc-unlimited', 1100)).toBe(false);
    });
  });

  describe('Guardrail 4: quotaCooldownScope (family vs account)', () => {
    it('keeps cross-family models available when quotaCooldownScope is family', async () => {
      const acc1 = makeAccount('acc-q1');
      const cooldowns: CooldownRecord[] = [];

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({ quotaCooldownScope: 'family' }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [acc1]),
        spyOn(store, 'getAccount').mockImplementation((id) => (id === 'acc-q1' ? acc1 : null)),
        spyOn(store, 'listCooldowns').mockImplementation((now = Date.now()) =>
          cooldowns.filter((c) => c.untilMs > now),
        ),
        spyOn(store, 'upsertCooldown').mockImplementation((cd) => {
          const idx = cooldowns.findIndex(
            (c) =>
              c.accountId === cd.accountId &&
              c.family === cd.family &&
              c.scopeType === cd.scopeType,
          );
          if (idx >= 0) cooldowns[idx] = cd;
          else cooldowns.push(cd);
        }),
      );

      const scheduler = new AccountScheduler();
      scheduler.recordFailure('acc-q1', 'gemini-4-hydrogen', {
        upstreamStatus: 429,
        reasonCode: 'RESOURCE_EXHAUSTED',
      });

      // Same family is cooled down
      await expect(scheduler.acquireAccountLease('gemini-4-hydrogen')).rejects.toThrow(
        AllAccountsCooldownError,
      );

      // Different family (claude) is NOT cooled down
      const claudeLease = await scheduler.acquireAccountLease('claude-sonnet-4-5');
      expect(claudeLease.account.id).toBe('acc-q1');
      claudeLease.release();
    });

    it('applies account-level short backoff on 429 when quotaCooldownScope is account', async () => {
      const acc1 = makeAccount('acc-q2');
      const cooldowns: CooldownRecord[] = [];

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({ quotaCooldownScope: 'account' }),
        ),
        spyOn(store, 'listAccounts').mockImplementation(() => [acc1]),
        spyOn(store, 'getAccount').mockImplementation((id) => (id === 'acc-q2' ? acc1 : null)),
        spyOn(store, 'listCooldowns').mockImplementation((now = Date.now()) =>
          cooldowns.filter((c) => c.untilMs > now),
        ),
        spyOn(store, 'upsertCooldown').mockImplementation((cd) => {
          const idx = cooldowns.findIndex(
            (c) =>
              c.accountId === cd.accountId &&
              c.family === cd.family &&
              c.scopeType === cd.scopeType,
          );
          if (idx >= 0) cooldowns[idx] = cd;
          else cooldowns.push(cd);
        }),
      );

      const scheduler = new AccountScheduler();
      const before = Date.now();
      scheduler.recordFailure('acc-q2', 'gemini-4-hydrogen', {
        upstreamStatus: 429,
        reasonCode: 'RESOURCE_EXHAUSTED',
        retryAfterMs: 20_000,
      });

      // Both family cooldown and global short backoff must exist
      const familyCd = cooldowns.find(
        (c) => c.family === 'gemini-4-hydrogen' && c.scopeType === 'family',
      );
      const globalCd = cooldowns.find((c) => c.family === '*' && c.scopeType === 'global');
      expect(familyCd).toBeDefined();
      expect(globalCd).toBeDefined();
      expect(globalCd!.untilMs - before).toBeGreaterThanOrEqual(19_000);
      expect(globalCd!.untilMs - before).toBeLessThanOrEqual(60_500);

      // Cross-family request on claude is also blocked by the account-level short backoff
      await expect(scheduler.acquireAccountLease('claude-sonnet-4-5')).rejects.toThrow(
        AllAccountsCooldownError,
      );
    });
  });

  describe('Guardrail 5: 403/RESTRICTED 6-hour policy block hard lock', () => {
    it('writes a 6h global cooldown on 403/RESTRICTED and blocks acquireAccountLease within TTL', async () => {
      const acc1 = makeAccount('acc-403');
      const cooldowns: CooldownRecord[] = [];
      let storedAccount = { ...acc1 };

      spies.push(
        spyOn(settings, 'getConfig').mockImplementation(() =>
          makeConfig({ policyBlockCooldownMs: 21_600_000 }),
        ),
        // Keep returning status: 'ready' from listAccounts to prove the cooldown hard lock itself blocks selection
        spyOn(store, 'listAccounts').mockImplementation(() => [acc1]),
        spyOn(store, 'getAccount').mockImplementation((id) =>
          id === 'acc-403' ? storedAccount : null,
        ),
        spyOn(store, 'upsertAccount').mockImplementation((acc) => {
          if (acc.id === 'acc-403') storedAccount = acc;
        }),
        spyOn(store, 'listCooldowns').mockImplementation((now = Date.now()) =>
          cooldowns.filter((c) => c.untilMs > now),
        ),
        spyOn(store, 'upsertCooldown').mockImplementation((cd) => {
          const idx = cooldowns.findIndex(
            (c) =>
              c.accountId === cd.accountId &&
              c.family === cd.family &&
              c.scopeType === cd.scopeType,
          );
          if (idx >= 0) cooldowns[idx] = cd;
          else cooldowns.push(cd);
        }),
      );

      const scheduler = new AccountScheduler();
      const before = Date.now();
      const untilMs = scheduler.recordFailure('acc-403', 'gemini-4-hydrogen', {
        upstreamStatus: 403,
        reasonCode: 'RESTRICTED',
        rawError: 'Policy restricted',
      });

      expect(storedAccount.status).toBe('restricted');
      expect(untilMs).toBeDefined();

      const globalCd = cooldowns.find(
        (c) => c.accountId === 'acc-403' && c.family === '*' && c.scopeType === 'global',
      );
      expect(globalCd).toBeDefined();
      expect(globalCd!.untilMs - before).toBeGreaterThanOrEqual(21_600_000 - 1000);
      expect(globalCd!.untilMs - before).toBeLessThanOrEqual(21_600_000 + 1000);

      await expect(scheduler.acquireAccountLease('gemini-4-hydrogen')).rejects.toThrow(
        AllAccountsCooldownError,
      );
      await expect(scheduler.acquireAccountLease('claude-sonnet-4-5')).rejects.toThrow(
        AllAccountsCooldownError,
      );
    });
  });
});
