import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AccountManager, GOOGLE_TOKEN_URL } from '../src/accounts/manager';
import {
  __setQuotaFetcherForTest,
  classifyModelPool,
  computeAccountQuotaSnapshot,
  fetchAccountQuota,
} from '../src/accounts/quota';
import { store } from '../src/db/store';
import { createApp } from '../src/server';
import type { AccountRecord } from '../src/types';

function modelQuota(remainingFraction: number, resetTime?: string) {
  return { quotaInfo: { remainingFraction, ...(resetTime === undefined ? {} : { resetTime }) } };
}

function flagshipSummary(fiveHour: number, weekly: number) {
  return {
    groups: [
      {
        groupName: 'gemini_flagship',
        buckets: [
          { window: '5h', remainingFraction: fiveHour },
          { window: 'weekly', remainingFraction: weekly },
        ],
      },
    ],
  };
}

describe('classifyModelPool', () => {
  const cases = [
    ['gemini-4-argon-high', 'gemini_flagship'],
    ['gemini-4-hydrogen-xhigh', 'gemini_flash'],
    ['gemini-2.5-pro', 'gemini_flash'],
    ['gemini-3.8-flash-high', 'gemini_flash'],
    ['gemini-3-flash', 'gemini_flash'],
    ['gemini-2.5-flash', 'gemini_flash'],
    ['gemini-2.5-flash-lite', 'gemini_flash'],
    ['gemini-3.1-flash-image', 'gemini_flash'],
    ['claude-sonnet-4-6', 'third_party'],
    ['claude-opus-5-5-high', 'third_party'],
    ['gpt-oss-120b-medium', 'third_party'],
    ['text-embedding-004', null],
  ] as const;

  for (const [modelId, expectedPool] of cases) {
    it(`classifies ${modelId} as ${expectedPool}`, () => {
      expect(classifyModelPool(modelId)).toBe(expectedPool);
    });
  }
});

describe('computeAccountQuotaSnapshot', () => {
  it('uses the lowest model quota in a pool and identifies the bottleneck', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: {
        models: {
          'gemini-4-argon-high': modelQuota(0.8),
          'gemini-pro-orchestrator-g1-pro': modelQuota(0.6),
          'gemini-4-hydrogen-high': modelQuota(0.25),
          'gemini-3.8-flash-high': modelQuota(0.7),
        },
      },
    });

    expect(pools.gemini_flagship?.percentage).toBe(80);
    expect(pools.gemini_flagship?.bottleneckModel).toBe('gemini-4-argon');
    expect(pools.gemini_flash?.modelCount).toBe(3);
    expect(pools.gemini_flash?.percentage).toBe(25);
    expect(pools.gemini_flash?.bottleneckModel).toBe('gemini-4-hydrogen');
  });

  describe('model list cleanup', () => {
    it('filters upstream deprecated IDs and legacy aliases while retaining current and future models', () => {
      const { pools } = computeAccountQuotaSnapshot({
        modelsResponse: {
          deprecatedModelIds: ['models/gemini-5-retired-preview', 'MODEL_PLACEHOLDER_RETIRED'],
          models: {
            'gemini-2.5-pro': modelQuota(0.01),
            'gemini-2.5-flash-lite': modelQuota(0.02),
            'gemini-3.5-pro': modelQuota(0.03),
            'gemini-3-flash': modelQuota(0.04),
            'gemini-3.1-flash-lite': modelQuota(0.05),
            'gemini-5-retired-preview': modelQuota(0.06),
            MODEL_PLACEHOLDER_RETIRED: { displayName: 'Gemini Retired Preview', ...modelQuota(0.07) },
            'gemini-3.8-flash-low': modelQuota(0.8),
            'gemini-3.1-flash-image': modelQuota(0.6),
            'gemini-pro-orchestrator-g1-pro': modelQuota(0.75),
            'gemini-5-daily-test': modelQuota(0.72),
          },
        },
      });

      expect(pools.gemini_flash).toMatchObject({
        percentage: 60,
        bottleneckModel: 'gemini-3.1-flash-image',
        modelCount: 4,
      });
      expect(pools.gemini_flash?.models.map((model) => model.id).sort()).toEqual([
        'gemini-3.1-flash-image', 'gemini-3.8-flash', 'gemini-5-daily-test', 'gemini-pro-orchestrator-g1-pro',
      ]);
    });

    it('keeps and deduplicates legacy entries when their pool has no current models', () => {
      const { pools } = computeAccountQuotaSnapshot({
        modelsResponse: {
          deprecatedModelIds: { 'models/gemini-5-retired-preview': 'gemini-4-argon-high' },
          models: {
            'gemini-2.5-flash-lite-low': modelQuota(0.4),
            'gemini-2.5-flash-lite-high': modelQuota(0.2),
            'gemini-5-retired-preview': modelQuota(0.7),
            'gemini-4-argon-high': modelQuota(0.9),
          },
        },
      });

      expect(pools.gemini_flash).toMatchObject({
        percentage: 20,
        bottleneckModel: 'gemini-2.5-flash-lite',
        modelCount: 2,
        models: [{ id: 'gemini-2.5-flash-lite' }, { id: 'gemini-5-retired-preview' }],
      });
      expect(pools.gemini_flagship?.models).toMatchObject([{ id: 'gemini-4-argon' }]);
    });

    const variants = [
      ['gemini_flagship', 'gemini-4-argon', 'high', 'Gemini 4 Argon', '(High)'],
      ['gemini_flash', 'gemini-4-hydrogen', 'tiered-xhigh', 'Gemini 4 Hydrogen', '(Tiered) （XHigh）'],
      ['third_party', 'claude-opus-5-5', 'medium', 'Claude Opus 5.5', '(Medium)'],
      ['third_party', 'gpt-oss-120b', 'minimal-thinking-sonar-medium', 'GPT OSS 120B', '（Medium）'],
    ] as const;

    for (const [pool, baseId, tieredSuffix, displayName, tierLabel] of variants) {
      it(`shows a single ${baseId} with the quota and reset of its tightest tier`, () => {
        const limitingReset = '2026-11-18T03:00:00Z';
        const { pools } = computeAccountQuotaSnapshot({
          modelsResponse: { models: {
            [`models/${baseId}-low`]: {
              displayName: `${displayName} (Low)`,
              ...modelQuota(0.8, '2026-11-18T04:00:00Z'),
            },
            [`${baseId}-${tieredSuffix}`]: {
              displayName: ` ${displayName} ${tierLabel} `,
              ...modelQuota(0.25, limitingReset),
            },
          } },
        });

        expect(pools[pool]).toMatchObject({
          bottleneckModel: baseId,
          modelCount: 1,
          percentage: 25,
          resetTime: limitingReset,
        });
        expect(pools[pool]?.models).toEqual([{
          id: baseId, displayName, percentage: 25, remainingFraction: 0.25, resetTime: limitingReset,
        }]);
      });
    }
  });

  for (const weekly of [0, 0.0005, 0.001]) {
    it(`sets only the matching pool to 0% at weekly remainingFraction ${weekly}`, () => {
      const { pools } = computeAccountQuotaSnapshot({
        modelsResponse: {
          models: {
            'gemini-4-argon-high': modelQuota(0.8),
            'gemini-3.8-flash-low': modelQuota(0.7),
            'claude-sonnet-4-6': modelQuota(0.6),
          },
        },
        summaryResponse: flagshipSummary(0.9, weekly),
      });

      expect(pools.gemini_flagship?.percentage).toBe(0);
      expect(pools.gemini_flash?.percentage).toBe(70);
      expect(pools.third_party?.percentage).toBe(60);
    });
  }

  const bottleneckCases = [
    { source: '5h window', model: 0.8, fiveHour: 0.4, weekly: 0.9, expected: 40 },
    { source: 'weekly window', model: 0.8, fiveHour: 0.9, weekly: 0.3, expected: 30 },
    { source: 'model', model: 0.4, fiveHour: 0.9, weekly: 0.8, expected: 40 },
  ];

  for (const { source, model, fiveHour, weekly, expected } of bottleneckCases) {
    it(`uses the ${source} quota when it has the lowest remainder`, () => {
      const { pools } = computeAccountQuotaSnapshot({
        modelsResponse: { models: { 'gemini-4-argon-high': modelQuota(model) } },
        summaryResponse: flagshipSummary(fiveHour, weekly),
      });

      expect(pools.gemini_flagship?.percentage).toBe(expected);
    });
  }

  it('uses model quota when the summary response is null', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: { 'gemini-3.8-flash-low': modelQuota(0.75) } },
      summaryResponse: null,
    });

    expect(pools.gemini_flash?.percentage).toBe(75);
  });

  it('skips missing quotaInfo and returns null for a pool without quota data', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: {
        models: {
          'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)' },
          'gemini-4-argon-high': modelQuota(0.8),
          'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)' },
        },
      },
    });

    expect(pools.gemini_flagship?.percentage).toBe(80);
    expect(pools.gemini_flagship?.bottleneckModel).toBe('gemini-4-argon');
    expect(pools.gemini_flash).toBeNull();
  });

  it('resolves opaque keys by model ID or displayName and ignores unsupported embedding models', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: {
        slotA: { model: 'models/gemini-4-argon-high', ...modelQuota(0.65) },
        slotB: { model: 'MODEL_PLACEHOLDER_M318', displayName: 'Gemini 3.8 Flash (High)', ...modelQuota(0.4) },
        slotC: { displayName: 'GPT OSS 120B', ...modelQuota(0.9) },
        'text-embedding-004': { displayName: 'Gemini Embedding', ...modelQuota(0) },
      } },
    });
    expect(pools.gemini_flagship?.percentage).toBe(65);
    expect(pools.gemini_flash?.percentage).toBe(40);
    expect(pools.third_party?.percentage).toBe(90);
  });

  it('handles displayName-only array records and counts an explicit zero', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: [
        { displayName: 'Gemini 3.8 Flash (High)', ...modelQuota(0.7) },
        { id: 'placeholder', model: 'gemini-3.1-flash-image', ...modelQuota(0) },
      ] },
    });
    expect(pools.gemini_flash?.modelCount).toBe(2);
    expect(pools.gemini_flash?.percentage).toBe(0);
    expect(pools.gemini_flash?.bottleneckModel).toBe('gemini-3.1-flash-image');
  });

  it('keeps missing, null, and nonfinite fractions unknown even with a reset time', () => {
    const resetTime = '2026-11-20T15:00:00Z';
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: {
        'gemini-4-argon-high': { quotaInfo: { resetTime } },
        'gemini-4-hydrogen-high': { quotaInfo: { remainingFraction: null, resetTime } },
        'gemini-pro-orchestrator-g1-pro': { quotaInfo: { remainingFraction: NaN, resetTime } },
        'gemini-3.8-flash-low': modelQuota(0.33),
      } },
    });
    expect(pools.gemini_flagship).toBeNull();
    expect(pools.gemini_flash?.percentage).toBe(33);
  });

  it('keeps the upstream Argon, Gemini, and 3P groups separate and uses the limiting reset', () => {
    const argonReset = '2026-11-24T15:00:00Z';
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: {
        'gemini-4-argon-high': modelQuota(0.9),
        'gemini-3.8-flash-low': modelQuota(0.9),
        'claude-sonnet-4-6': { quotaInfo: { remainingFraction: null } },
      } },
      summaryResponse: { groups: [
        { displayName: 'Gemini Argon', buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.8 },
          { bucketId: 'argon-weekly', remainingFraction: 0.6, resetTime: argonReset },
        ] },
        { displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.07 }] },
        { displayName: '3rd Party Models', buckets: [{ bucketId: '3p-5h', remainingFraction: 0.5 }] },
        { displayName: 'Other models', buckets: [{ window: 'weekly', remainingFraction: 0 }] },
      ] },
    });
    expect(pools.gemini_flagship).toMatchObject({ percentage: 60, resetTime: argonReset, window5h: 80 });
    expect(pools.gemini_flash).toMatchObject({ percentage: 7, windowWeekly: null });
    expect(pools.third_party).toMatchObject({ percentage: 50, bottleneckModel: null, models: [] });
  });

  it('applies a regular Gemini bucket to Hydrogen, and reads a 3P weekly bucket by ID', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: {
        'gemini-4-argon-high': modelQuota(0.9),
        'gemini-4-hydrogen-high': modelQuota(0.9),
        'gpt-oss-120b-medium': modelQuota(0.9),
      } },
      summaryResponse: { groups: [
        { buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.4 },
          { bucketId: 'gemini-15h', remainingFraction: 0 },
          { bucketId: '3p-weekly', remainingFraction: 0.001 },
        ] },
      ] },
    });
    expect(pools.gemini_flagship?.percentage).toBe(90);
    expect(pools.gemini_flash?.percentage).toBe(40);
    expect(pools.third_party?.percentage).toBe(0);
  });

  describe('upstream bucket fingerprints', () => {
    const fetchedAt = Date.parse('2026-11-18T00:00:00.000Z');
    const regularResetTime = '2026-11-18T03:00:00.000Z';

    it('matches an unknown Gemini model to the regular gemini-5h bucket', () => {
      const { pools } = computeAccountQuotaSnapshot({
        fetchedAt,
        modelsResponse: { models: {
          'gemini-5-daily-test': modelQuota(0.72, regularResetTime),
        } },
        summaryResponse: { groups: [{ buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.72, resetTime: regularResetTime },
        ] }] },
      });

      expect(pools.gemini_flash).toMatchObject({
        percentage: 72,
        window5h: 72,
        resetTime: regularResetTime,
        modelCount: 1,
        models: [{ id: 'gemini-5-daily-test' }],
      });
      expect(pools.gemini_flagship).toBeNull();
    });

    it('discovers an independent weekly bucket for an unknown Gemini model', () => {
      const weeklyResetTime = '2026-11-25T00:00:00.000Z';
      const { pools } = computeAccountQuotaSnapshot({
        fetchedAt,
        modelsResponse: { models: {
          'gemini-3.8-flash': modelQuota(0.60, regularResetTime),
          'gemini-5-neon': modelQuota(0.95, weeklyResetTime),
        } },
        summaryResponse: { groups: [{ buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.60, resetTime: regularResetTime },
        ] }] },
      });

      expect(pools.gemini_flagship).toMatchObject({
        percentage: 95,
        resetTime: weeklyResetTime,
        modelCount: 1,
        models: [{ id: 'gemini-5-neon' }],
      });
      expect(pools.gemini_flash).toMatchObject({
        percentage: 60,
        resetTime: regularResetTime,
        modelCount: 1,
        models: [{ id: 'gemini-3.8-flash' }],
      });
    });

    it('matches an unknown GPT model to the 3p bucket when remaining fractions tie', () => {
      const thirdPartyResetTime = '2026-11-18T04:00:00.000Z';
      const { pools } = computeAccountQuotaSnapshot({
        fetchedAt,
        modelsResponse: { models: {
          'gemini-3.8-flash': modelQuota(0.64, regularResetTime),
          'partner-x-gpt-coder': modelQuota(0.64, thirdPartyResetTime),
        } },
        summaryResponse: { groups: [{ buckets: [
          { bucketId: 'gemini-5h', remainingFraction: 0.64, resetTime: regularResetTime },
          { bucketId: '3p-5h', remainingFraction: 0.64, resetTime: thirdPartyResetTime },
        ] }] },
      });

      expect(pools.third_party).toMatchObject({
        percentage: 64,
        window5h: 64,
        resetTime: thirdPartyResetTime,
        modelCount: 1,
        models: [{ id: 'partner-x-gpt-coder' }],
      });
      expect(pools.gemini_flash).toMatchObject({
        percentage: 64,
        resetTime: regularResetTime,
        modelCount: 1,
        models: [{ id: 'gemini-3.8-flash' }],
      });
    });
  });

  it('preserves positive weekly remainder immediately above the depletion threshold', () => {
    const { pools } = computeAccountQuotaSnapshot({
      modelsResponse: { models: { 'gemini-4-argon-high': modelQuota(0.85) } },
      summaryResponse: flagshipSummary(0.75, 0.0011),
    });
    expect(pools.gemini_flagship?.remainingFraction).toBe(0.0011);
    expect(pools.gemini_flagship?.percentage).toBe(0.11);
  });
});

const originalFetch = globalThis.fetch;
const testAccounts: AccountRecord[] = [];

function tokenFile(account: AccountRecord): string {
  return join(account.homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

function accountFixture(token: Record<string, unknown>, status: AccountRecord['status'] = 'ready') {
  const homeDir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'));
  const id = basename(homeDir);
  const now = Date.now();
  const account: AccountRecord = {
    id, homeDir, label: id, email: '', source: 'test', proxyUrl: '', status,
    statusReason: '', tier: 'standard', exitIp: '', exitCountry: '',
    concurrencyLimit: 2, activeWorkers: 0, lastVerifiedAt: null, createdAt: now, updatedAt: now,
  };
  testAccounts.push(account);
  mkdirSync(join(homeDir, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(tokenFile(account), JSON.stringify(token));
  store.upsertAccount(account);
  return account;
}

function mockQuotaResponse(url: string) {
  if (url.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'fixture-project' });
  if (url.endsWith(':fetchAvailableModels')) {
    return Response.json({ models: { 'gemini-3.8-flash-low': modelQuota(0.8) } });
  }
  if (url.endsWith(':retrieveUserQuotaSummary')) return Response.json({ groups: [] });
  throw new Error(`Unexpected test request: ${url}`);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const account of testAccounts.splice(0)) {
    store.deleteAccount(account.id);
    rmSync(account.homeDir, { recursive: true, force: true });
  }
});

describe('account quota refresh', () => {
  for (const scenario of ['valid', 'expired', 'missing', 'rejected'] as const) {
    it(`handles a ${scenario} access token via the single-account API`, async () => {
      const expiry = new Date(Date.now() + (scenario === 'expired' ? -60_000 : 600_000)).toISOString();
      const token = { refresh_token: 'fixture-refresh', expiry, ...(scenario === 'missing' ? {} : { access_token: 'cached' }) };
      const account = accountFixture(scenario === 'missing' ? token : { token });
      let oauthCalls = 0;
      const modelsAuth: Array<string | null> = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_URL) {
          oauthCalls++;
          const body = new URLSearchParams(String(init?.body));
          expect(body.get('grant_type')).toBe('refresh_token');
          expect(body.get('refresh_token')).toBe('fixture-refresh');
          return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
        }
        if (url.endsWith(':fetchAvailableModels')) {
          const auth = new Headers(init?.headers).get('Authorization');
          modelsAuth.push(auth);
          if (scenario === 'rejected' && auth === 'Bearer cached') return Response.json({}, { status: 401 });
        }
        return mockQuotaResponse(url);
      }) as typeof fetch;

      const res = await createApp().fetch(new Request(`http://localhost/api/accounts/${account.id}/quota`, { method: 'POST' }));
      expect(res.status).toBe(200);
      const updated = (await res.json()) as AccountRecord;
      const renews = scenario !== 'valid';
      expect(oauthCalls).toBe(renews ? 1 : 0);
      expect(modelsAuth.at(-1)).toBe(renews ? 'Bearer renewed' : 'Bearer cached');
      if (scenario === 'rejected') expect(modelsAuth[0]).toBe('Bearer cached');
      expect(updated.quota?.pools.gemini_flash).toMatchObject({
        percentage: 80, modelCount: 1, bottleneckModel: 'gemini-3.8-flash',
      });
      expect(store.getAccount(account.id)?.quota?.projectId).toBe('fixture-project');
      expect(JSON.parse(readFileSync(tokenFile(account), 'utf8')).token.refresh_token)
        .toBe(renews ? 'rotated' : 'fixture-refresh');
    });
  }

  it('keeps the last observed quota and reports failure when upstream omits all quotas', async () => {
    const account = accountFixture({ access_token: 'cached' });
    const quota = computeAccountQuotaSnapshot({
      fetchedAt: 1234,
      modelsResponse: { models: { 'gemini-3.8-flash-low': modelQuota(0.23) } },
    });
    store.upsertAccount({ ...account, quota });
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;

    const result = await new AccountManager().refreshAccountQuota(account.id);
    expect(result?.quota?.fetchedAt).toBe(1234);
    expect(result?.quota?.pools.gemini_flash?.percentage).toBe(23);
    expect(result?.quota?.error).toContain('did not report quota');
  });

  it('caps concurrent requests, deduplicates overlapping refreshes, and isolates account errors', async () => {
    const targets = Array.from({ length: 7 }, () => accountFixture({ access_token: 'cached' }));
    accountFixture({ access_token: 'unused' }, 'disabled');
    let active = 0;
    let peak = 0;
    let calls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith(':loadCodeAssist')) {
        calls++;
        peak = Math.max(peak, ++active);
        await Bun.sleep(15);
        active--;
      }
      return mockQuotaResponse(url);
    }) as typeof fetch;

    const manager = new AccountManager();
    const refresh = manager.refreshAccountQuota.bind(manager);
    manager.refreshAccountQuota = (id) => id === targets[1].id
      ? Promise.reject(new Error('fixture account storage failure'))
      : refresh(id);
    const single = manager.refreshAccountQuota(targets[0].id);
    expect(manager.refreshAccountQuota(targets[0].id)).toBe(single);
    const all = manager.refreshAllQuotas({ concurrency: 999 });
    expect(manager.refreshAllQuotas()).toBe(all);
    const result = await all;
    await single;
    expect(result).toMatchObject({ refreshed: 6, failed: 1 });
    expect(peak).toBe(4);
    expect(calls).toBe(6);
  });

  it('returns the whole account list even with malformed or invalid quota JSON', () => {
    const broken = accountFixture({});
    const wrongShape = accountFixture({});
    const good = accountFixture({});
    const update = store.db.query('UPDATE accounts SET quota_json = ? WHERE id = ?');
    update.run('{broken', broken.id);
    update.run('{"fetchedAt":123,"pools":{"gemini_flagship":{"percentage":1}}}', wrongShape.id);

    const accounts = store.listAccounts();
    expect(accounts.find((account) => account.id === broken.id)?.quota).toBeNull();
    expect(accounts.find((account) => account.id === wrongShape.id)?.quota).toBeNull();
    expect(accounts.some((account) => account.id === good.id)).toBe(true);
  });

  it('sends official antigravity/cli User-Agent on loadCodeAssist and retrieveUserQuotaSummary', async () => {
    const capturedUserAgents: Array<{ url: string; userAgent: string | null }> = [];
    const uaRegex =
      /^antigravity\/cli\/\S+ \(aidev_client; os_type=(windows|darwin|linux); arch=(amd64|arm64); cl=\d+; auth_method=\S+\)$/;

    __setQuotaFetcherForTest((async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      capturedUserAgents.push({ url, userAgent: headers.get('User-Agent') });

      if (url.endsWith(':loadCodeAssist')) {
        return Response.json({
          cloudaicompanionProject: 'ua-test-project',
          paidTier: { id: 'g1-pro-tier' },
        });
      }
      if (url.endsWith(':fetchAvailableModels')) {
        return Response.json({
          models: {
            'gemini-4-argon-high': modelQuota(0.9),
          },
        });
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return Response.json(flagshipSummary(0.9, 0.8));
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);

    try {
      const result = await fetchAccountQuota({ accessToken: 'test-access-token' });
      expect(result.snapshot.pools.gemini_flagship?.percentage).toBe(80);
    } finally {
      __setQuotaFetcherForTest(undefined);
    }

    const loadCall = capturedUserAgents.find((c) => c.url.endsWith(':loadCodeAssist'));
    const summaryCall = capturedUserAgents.find((c) => c.url.endsWith(':retrieveUserQuotaSummary'));
    expect(loadCall).toBeDefined();
    expect(summaryCall).toBeDefined();
    expect(loadCall!.userAgent).toMatch(uaRegex);
    expect(summaryCall!.userAgent).toMatch(uaRegex);
  });
});
