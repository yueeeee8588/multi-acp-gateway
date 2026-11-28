import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AccountManager } from '../src/accounts/manager';
import {
  createUsageReader,
  DEFAULT_USAGE_LATE_TTL_MS,
  hasFlagshipModelAccess,
  mergeUsageSnapshotWithPreviousModels,
  parseUsageOutput,
  resolveUsageBackgroundTimeoutMs,
  USAGE_TOKEN_EXPIRY_WINDOW_MS,
  type UsageExecOptions,
  type UsageExecOutput,
} from '../src/accounts/quota';
import { store } from '../src/db/store';
import type { AccountRecord } from '../src/types';

const createdHomes: string[] = [];
const createdAccountIds: string[] = [];
const originalFetch = globalThis.fetch;
const originalUsageTimeoutEnv = process.env.AGY_USAGE_TIMEOUT_MS;
const originalLegacyEnv = process.env.AGY_LEGACY_DIRECT_QUOTA;

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-usage-test-'));
  createdHomes.push(dir);
  mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true });
  return dir;
}

function createAccountFixture(token: Record<string, unknown>, proxyUrl = ''): AccountRecord {
  const homeDir = createTempHome();
  const id = basename(homeDir);
  const now = Date.now();
  const account: AccountRecord = {
    id,
    homeDir,
    label: id,
    email: `${id}@example.com`,
    source: 'test',
    proxyUrl,
    status: 'ready',
    statusReason: '',
    tier: 'pro',
    exitIp: '',
    exitCountry: '',
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(
    join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    JSON.stringify({ token })
  );
  store.upsertAccount(account);
  createdAccountIds.push(id);
  return account;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUsageTimeoutEnv === undefined) delete process.env.AGY_USAGE_TIMEOUT_MS;
  else process.env.AGY_USAGE_TIMEOUT_MS = originalUsageTimeoutEnv;
  if (originalLegacyEnv === undefined) delete process.env.AGY_LEGACY_DIRECT_QUOTA;
  else process.env.AGY_LEGACY_DIRECT_QUOTA = originalLegacyEnv;

  for (const id of createdAccountIds.splice(0)) {
    store.deleteAccount(id);
  }
  for (const home of createdHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('parseUsageOutput', () => {
  it('parses multi-pool ANSI text output with windows, models, and reset times', () => {
    const fetchedAt = Date.parse('2026-11-26T10:00:00.000Z');
    const raw = [
      '\u001b[1mModel Usage Summary\u001b[0m',
      'G4 Argon',
      '  5h window:      90% remaining (resets in 3h 30m)',
      '  Weekly:         75% remaining (resets 2026-12-01T00:00:00Z)',
      'Gemini',
      '  gemini-4-hydrogen   80% remaining   resets in 4h',
      '  gemini-3.8-flash    20% used        resets in 2h',
      '3rd Party Models',
      '  claude-sonnet-4-6   60% remaining   2026-11-26T15:00:00Z',
      '  gpt-oss-120b        45% remaining   2026-11-26T14:00:00Z',
    ].join('\n');

    const snapshot = parseUsageOutput(raw, { fetchedAt, projectId: 'proj-usage-1' });
    expect(snapshot.fetchedAt).toBe(fetchedAt);
    expect(snapshot.projectId).toBe('proj-usage-1');

    expect(snapshot.pools.gemini_flagship).toMatchObject({
      pool: 'gemini_flagship',
      percentage: 75,
      window5h: 90,
      windowWeekly: 75,
      resetTime: '2026-12-01T00:00:00.000Z',
    });

    expect(snapshot.pools.gemini_flash).toMatchObject({
      pool: 'gemini_flash',
      percentage: 80,
      modelCount: 2,
      bottleneckModel: 'gemini-4-hydrogen',
    });

    expect(snapshot.pools.third_party).toMatchObject({
      pool: 'third_party',
      percentage: 45,
      modelCount: 2,
      bottleneckModel: 'gpt-oss-120b',
      resetTime: '2026-11-26T14:00:00.000Z',
    });
  });

  it('fails fast on empty or unparseable output without fabricating quotas', () => {
    expect(() => parseUsageOutput('')).toThrow(/empty output/i);
    expect(() => parseUsageOutput('   \u001b[31mError: not logged in\u001b[0m  ')).toThrow(
      /no quota entries found/i
    );
  });
});

describe('resolveUsageBackgroundTimeoutMs', () => {
  it('defaults to 45s and caps env override at 120s', () => {
    delete process.env.AGY_USAGE_TIMEOUT_MS;
    expect(resolveUsageBackgroundTimeoutMs()).toBe(45_000);

    process.env.AGY_USAGE_TIMEOUT_MS = '60000';
    expect(resolveUsageBackgroundTimeoutMs()).toBe(60_000);

    process.env.AGY_USAGE_TIMEOUT_MS = '300000';
    expect(resolveUsageBackgroundTimeoutMs()).toBe(120_000);
  });
});

describe('createUsageReader', () => {
  const sampleUsageStdout = [
    'G4 Argon: 95% remaining (resets in 6d)',
    'Gemini: 80% remaining (resets in 4h)',
    '3rd Party Models: 50% remaining (resets in 2h)',
  ].join('\n');

  it('skips spawning agy and returns DUE_FOR_RENEWAL when token expires within 2 minutes', async () => {
    let spawnCount = 0;
    const nowMs = 1_700_000_000_000;
    const homeDir = createTempHome();
    const reader = createUsageReader({
      now: () => nowMs,
      resolveBinary: () => 'agy.exe',
      executor: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: sampleUsageStdout, stderr: '' };
      },
    });

    const expiringResult = await reader.readUsage({
      accountId: 'acc-expiring',
      homeDir,
      credentials: {
        accessToken: 'soon-expired-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + USAGE_TOKEN_EXPIRY_WINDOW_MS - 1_000,
      },
    });
    expect(expiringResult.status).toBe('DUE_FOR_RENEWAL');
    expect(spawnCount).toBe(0);

    const expiredResult = await reader.readUsage({
      accountId: 'acc-expired',
      homeDir,
      credentials: {
        accessToken: 'expired-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs - 10_000,
      },
    });
    expect(expiredResult.status).toBe('DUE_FOR_RENEWAL');
    expect(spawnCount).toBe(0);
  });

  it('deduplicates concurrent requests for the same account into one pending spawn', async () => {
    let spawnCount = 0;
    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> = {};
    const homeDir = createTempHome();
    const nowMs = 1_700_000_000_000;

    const reader = createUsageReader({
      now: () => nowMs,
      resolveBinary: () => 'agy.exe',
      executor: async (opts: UsageExecOptions): Promise<UsageExecOutput> => {
        spawnCount++;
        capturedArgs = opts.args;
        capturedEnv = opts.env;
        await Bun.sleep(30);
        return { exitCode: 0, stdout: sampleUsageStdout, stderr: '' };
      },
    });

    const req = {
      accountId: 'acc-dedup',
      homeDir,
      proxyUrl: 'http://127.0.0.1:7890',
      strictProxyBinding: false,
      credentials: {
        accessToken: 'valid-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + 600_000,
      },
    };

    const [r1, r2, r3] = await Promise.all([
      reader.readUsage(req),
      reader.readUsage(req),
      reader.readUsage(req),
    ]);

    expect(spawnCount).toBe(1);
    expect(capturedArgs).toEqual(['-p', '/usage']);
    expect(capturedEnv.HOME).toBe(homeDir);
    expect(capturedEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
    expect(r3.status).toBe('ok');
    expect(r1.snapshot?.pools.gemini_flagship?.percentage).toBe(95);
    expect(r1.snapshot?.pools.gemini_flash?.percentage).toBe(80);
    expect(r1.snapshot?.pools.third_party?.percentage).toBe(50);
  });

  it('shares one strict proxy check and /usage spawn across concurrent reads', async () => {
    const probe = Promise.withResolvers<{ ok: boolean; error?: string }>();
    const checkedProxies: string[] = [];
    let spawnCount = 0;
    const reader = createUsageReader({
      resolveBinary: () => 'agy.exe',
      checkProxy: (proxyUrl) => {
        checkedProxies.push(proxyUrl);
        return probe.promise;
      },
      executor: async ({ args }) => {
        expect(args).toEqual(['-p', '/usage']);
        spawnCount++;
        return { exitCode: 0, stdout: sampleUsageStdout, stderr: '' };
      },
    });
    const req = {
      accountId: 'acc-strict-dedup',
      homeDir: createTempHome(),
      proxyUrl: 'http://127.0.0.1:7890',
      strictProxyBinding: true,
      credentials: { accessToken: 'valid-token', refreshToken: '', expiresAt: null },
    };

    const results = Promise.all([reader.readUsage(req), reader.readUsage(req), reader.readUsage(req)]);
    await Promise.resolve();
    expect(checkedProxies).toEqual([req.proxyUrl]);
    expect(spawnCount).toBe(0);
    probe.resolve({ ok: true });
    expect((await results).map(({ status }) => status)).toEqual(['ok', 'ok', 'ok']);
    expect(checkedProxies).toEqual([req.proxyUrl]);
    expect(spawnCount).toBe(1);
  });

  it('returns STILL_READING on foreground timeout, populates late cache once, and expires after 3m TTL', async () => {
    let spawnCount = 0;
    let nowMs = 1_700_000_000_000;
    let resolveSpawn!: (out: UsageExecOutput) => void;
    const homeDir = createTempHome();

    const reader = createUsageReader({
      now: () => nowMs,
      foregroundWaitMs: 25,
      backgroundTimeoutMs: 500,
      lateCacheTtlMs: DEFAULT_USAGE_LATE_TTL_MS,
      resolveBinary: () => 'agy.exe',
      executor: () => {
        spawnCount++;
        return new Promise<UsageExecOutput>((resolve) => {
          resolveSpawn = resolve;
        });
      },
    });

    const req = {
      accountId: 'acc-late',
      homeDir,
      credentials: {
        accessToken: 'valid-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + 3_600_000,
      },
    };

    const fgResult = await reader.readUsage(req);
    expect(fgResult.status).toBe('STILL_READING');
    expect(spawnCount).toBe(1);

    // 后台任务在所有前台等待者超时后完成 -> 写入 late 缓存
    resolveSpawn({ exitCode: 0, stdout: sampleUsageStdout, stderr: '' });
    await Bun.sleep(15);

    // 下次请求直接消费 late 缓存，不再次 spawn
    const lateHit = await reader.readUsage(req);
    expect(lateHit.status).toBe('ok');
    expect(lateHit.fromLateCache).toBe(true);
    expect(lateHit.snapshot?.pools.gemini_flash?.percentage).toBe(80);
    expect(spawnCount).toBe(1);

    // late 缓存仅单次消费，再次请求若立即触发且阻塞会重新 spawn
    const secondCallPromise = reader.readUsage(req);
    await Bun.sleep(5);
    expect(spawnCount).toBe(2);
    resolveSpawn({ exitCode: 0, stdout: sampleUsageStdout, stderr: '' });
    const secondCall = await secondCallPromise;
    expect(secondCall.status).toBe('ok');
    expect(secondCall.fromLateCache).toBeUndefined();

    // 验证 3 分钟 TTL 过期失效
    const thirdCallPromise = reader.readUsage(req);
    const thirdFg = await thirdCallPromise;
    expect(thirdFg.status).toBe('STILL_READING');
    expect(spawnCount).toBe(3);
    resolveSpawn({ exitCode: 0, stdout: sampleUsageStdout, stderr: '' });
    await Bun.sleep(15);

    nowMs += DEFAULT_USAGE_LATE_TTL_MS + 1;
    const afterTtlPromise = reader.readUsage(req);
    await Bun.sleep(5);
    expect(spawnCount).toBe(4);
    resolveSpawn({ exitCode: 0, stdout: sampleUsageStdout, stderr: '' });
    const afterTtl = await afterTtlPromise;
    expect(afterTtl.status).toBe('ok');
  });

  it('applies 1-minute cooldown after background timeout and fails closed on unreachable proxy', async () => {
    let spawnCount = 0;
    let nowMs = 1_700_000_000_000;
    const homeDir = createTempHome();

    const reader = createUsageReader({
      now: () => nowMs,
      foregroundWaitMs: 200,
      backgroundTimeoutMs: 50,
      timeoutCooldownMs: 60_000,
      resolveBinary: () => 'agy.exe',
      checkProxy: async (proxy) =>
        proxy.includes('bad-proxy')
          ? { ok: false, error: 'connection refused' }
          : { ok: true },
      executor: async () => {
        spawnCount++;
        return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      },
    });

    // 1. 代理不可达 -> Fail-Closed，不 spawn
    const proxyBlocked = await reader.readUsage({
      accountId: 'acc-proxy-fail',
      homeDir,
      proxyUrl: 'http://bad-proxy:8080',
      strictProxyBinding: true,
      credentials: {
        accessToken: 'valid-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + 600_000,
      },
    });
    expect(proxyBlocked.status).toBe('ERROR');
    expect(proxyBlocked.error).toContain('Proxy unreachable');
    expect(spawnCount).toBe(0);

    // 2. 后台超时 -> 返回 ERROR 并进入 1 分钟冷却
    const timedOutRes = await reader.readUsage({
      accountId: 'acc-timeout',
      homeDir,
      credentials: {
        accessToken: 'valid-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + 600_000,
      },
    });
    expect(timedOutRes.status).toBe('ERROR');
    expect(timedOutRes.error).toContain('timed out');
    expect(spawnCount).toBe(1);

    const duringCooldown = await reader.readUsage({
      accountId: 'acc-timeout',
      homeDir,
      credentials: {
        accessToken: 'valid-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + 600_000,
      },
    });
    expect(duringCooldown.status).toBe('COOLDOWN');
    expect(spawnCount).toBe(1);

    nowMs += 60_001;
    const afterCooldown = await reader.readUsage({
      accountId: 'acc-timeout',
      homeDir,
      credentials: {
        accessToken: 'valid-token',
        refreshToken: 'refresh-tok',
        expiresAt: nowMs + 600_000,
      },
    });
    expect(afterCooldown.status).toBe('ERROR');
    expect(spawnCount).toBe(2);
  });

  it('never falls back to direct cloudcode-pa API when agy exits non-zero', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return Response.json({});
    }) as typeof fetch;

    const account = createAccountFixture({
      access_token: 'valid-token',
      refresh_token: 'refresh-tok',
      expiry: new Date(Date.now() + 600_000).toISOString(),
    });

    const manager = new AccountManager();
    manager.setUsageReaderForTest(
      createUsageReader({
        resolveBinary: () => 'agy.exe',
        executor: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'authentication required',
        }),
      })
    );

    const updated = await manager.refreshAccountQuota(account.id);
    expect(fetchCalls).toBe(0);
    expect(updated?.quota?.error).toContain('exited with code 1');
    expect(updated?.quota?.pools.gemini_flash).toBeNull();
  });

  it('recognizes Opus 5.5 in third_party as full Pro and preserves detailed models across /usage refreshes', () => {
    const previous = {
      fetchedAt: 1000,
      pools: {
        gemini_flagship: null,
        gemini_flash: {
          pool: 'gemini_flash' as const,
          label: 'Gemini',
          percentage: 90,
          remainingFraction: 0.9,
          resetTime: null,
          modelCount: 1,
          bottleneckModel: 'gemini-4-neon',
          window5h: 90,
          windowWeekly: 90,
          models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', percentage: 90, remainingFraction: 0.9, resetTime: null }],
        },
        third_party: {
          pool: 'third_party' as const,
          label: '第三方',
          percentage: 100,
          remainingFraction: 1,
          resetTime: null,
          modelCount: 2,
          bottleneckModel: 'claude-opus-5-5',
          window5h: 100,
          windowWeekly: 100,
          models: [
            { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', percentage: 100, remainingFraction: 1, resetTime: null },
            { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', percentage: 100, remainingFraction: 1, resetTime: null },
          ],
        },
      },
    };
    const specialPro = {
      fetchedAt: 1000,
      pools: {
        gemini_flagship: null,
        gemini_flash: previous.pools.gemini_flash,
        third_party: {
          ...previous.pools.third_party,
          models: [
            { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', percentage: 100, remainingFraction: 1, resetTime: null },
          ],
        },
      },
    };
    expect(hasFlagshipModelAccess(previous)).toBe(true);
    expect(hasFlagshipModelAccess(specialPro)).toBe(false);

    const usageAggregate = {
      fetchedAt: 2000,
      pools: {
        gemini_flagship: null,
        gemini_flash: {
          pool: 'gemini_flash' as const,
          label: 'Gemini',
          percentage: 66,
          remainingFraction: 0.66,
          resetTime: '2026-12-03T10:19:31Z',
          modelCount: 0,
          bottleneckModel: null,
          window5h: null,
          windowWeekly: 66,
          models: [],
        },
        third_party: {
          pool: 'third_party' as const,
          label: '第三方',
          percentage: 88,
          remainingFraction: 0.88,
          resetTime: null,
          modelCount: 1,
          bottleneckModel: 'Claude',
          window5h: null,
          windowWeekly: 88,
          models: [
            { id: 'Claude', displayName: 'Claude and GPT models\t  Limit', percentage: 88, remainingFraction: 0.88, resetTime: null },
          ],
        },
      },
    };

    const merged = mergeUsageSnapshotWithPreviousModels(previous, usageAggregate);
    expect(merged.pools.gemini_flash?.percentage).toBe(66);
    expect(merged.pools.third_party?.percentage).toBe(88);
    expect(merged.pools.third_party?.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(hasFlagshipModelAccess(merged)).toBe(true);
  });

  it('parses real agy /usage TSV output with Five Hour + Weekly limits and filters Unix epoch resetTime', () => {
    const fetchedAt = Date.parse('2026-11-28T07:39:50.000Z');
    const raw = [
      'Gemini Models\tWeekly Limit Remaining\t64%\t2026-12-03T10:19:31Z',
      'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-28T12:39:50Z',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z',
    ].join('\n');

    const snapshot = parseUsageOutput(raw, { fetchedAt });
    expect(snapshot.pools.gemini_flash?.window5h).toBe(100);
    expect(snapshot.pools.gemini_flash?.window5hResetTime).toBe('2026-11-28T12:39:50.000Z');
    expect(snapshot.pools.gemini_flash?.windowWeekly).toBe(64);
    expect(snapshot.pools.gemini_flash?.windowWeeklyResetTime).toBe('2026-12-03T10:19:31.000Z');
    expect(snapshot.pools.gemini_flash?.percentage).toBe(64);

    expect(snapshot.pools.third_party?.window5h).toBe(100);
    expect(snapshot.pools.third_party?.windowWeekly).toBe(100);
    expect(snapshot.pools.third_party?.window5hResetTime).toBeUndefined();
    expect(snapshot.pools.third_party?.windowWeeklyResetTime).toBeUndefined();
    expect(snapshot.pools.third_party?.resetTime).toBeNull();
    expect(snapshot.pools.third_party?.models).toEqual([]);
  });
});
