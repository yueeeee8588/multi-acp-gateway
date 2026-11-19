import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { AcpWorkerPool } from './acp/pool';
import { WorkerError } from './acp/worker';
import { invalidateConfigCache, updateConfig } from './config/settings';
import { store } from './db/store';
import { adaptWorkerPool, createApp } from './server';
import type { AccountQuotaSnapshot, AccountRecord, GatewayConfig, GeminiGenerateRequest, PoolQuotaSummary } from './types';

function makeFlagshipQuota(): AccountQuotaSnapshot {
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
  return {
    fetchedAt: Date.now(),
    pools: {
      gemini_flagship: flagshipPool,
      gemini_flash: null,
      third_party: null,
    },
  };
}

function makeAccount(
  id: string,
  status: AccountRecord['status'] = 'ready',
  overrides: Partial<AccountRecord> = {},
): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Account-${id}`,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: '',
    proxyUrl: '',
    status,
    tier: 'standard',
    statusReason: '',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 1,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('gateway config credential updates', () => {
  it('preserves credentials on ordinary saves and serves the console catalog across key changes', async () => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const listAccounts = spyOn(store, 'listAccounts').mockReturnValue([]);
    const app = createApp();
    const configUrl = 'http://localhost:8048/api/config';
    const save = (patch: object) => app.fetch(new Request(configUrl, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }));
    const countTokens = (key?: string) => app.fetch(new Request(
      'http://localhost:8048/v1beta/models/gemini-3.8-flash-medium:countTokens',
      {
        method: 'POST',
        headers: key ? { 'x-goog-api-key': key } : undefined,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      },
    ));
    const original = {
      apiKey: 'original-test-key',
      defaultProxy: 'http://original:secret@127.0.0.1:7890',
    };
    const replacement = {
      apiKey: 'replacement-test-key',
      defaultProxy: 'http://replacement:secret@127.0.0.1:7891',
    };

    try {
      expect((await save(original)).status).toBe(200);
      const masked = await (await app.fetch(new Request(configUrl))).json() as GatewayConfig;
      expect(masked.apiKey).not.toBe(original.apiKey);
      expect(masked.defaultProxy).not.toBe(original.defaultProxy);

      const saved = await save({ queueWaitTimeoutMs: 15000 });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ queueWaitTimeoutMs: 15000 });
      invalidateConfigCache();
      expect((await countTokens(original.apiKey)).status).toBe(200);
      expect(store.getConfigValue('gateway_config')).toMatchObject(original);

      const catalogUrl = 'http://localhost:8048/api/models/catalog';
      const publicModelsUrl = 'http://localhost:8048/v1beta/models';
      const consoleCatalog = await app.fetch(new Request(catalogUrl));
      expect(consoleCatalog.status).toBe(200);
      const catalog = await consoleCatalog.json() as { models: Array<{ name: string }> };
      expect(catalog.models.map((model) => model.name)).toContain('models/gemini-3.8-flash-medium');
      expect((await app.fetch(new Request(publicModelsUrl))).status).toBe(401);
      expect((await app.fetch(new Request(publicModelsUrl, {
        headers: { 'x-goog-api-key': masked.apiKey },
      }))).status).toBe(401);
      const publicModels = await app.fetch(new Request(publicModelsUrl, {
        headers: { 'x-goog-api-key': original.apiKey },
      }));
      expect(publicModels.status).toBe(200);
      expect(await publicModels.json()).toEqual(catalog);

      expect((await save(replacement)).status).toBe(200);
      expect((await save({ ...masked, queueWaitTimeoutMs: 16000 })).status).toBe(200);
      expect((await save({ apiKey: null })).status).toBe(400);
      expect((await save({ defaultProxy: false })).status).toBe(400);
      expect(store.getConfigValue('gateway_config')).toMatchObject(replacement);
      expect((await countTokens(original.apiKey)).status).toBe(401);
      expect((await countTokens(replacement.apiKey)).status).toBe(200);
      expect((await app.fetch(new Request(catalogUrl))).status).toBe(200);

      expect((await save({ apiKey: '', defaultProxy: '' })).status).toBe(200);
      expect(store.getConfigValue('gateway_config')).toMatchObject({ apiKey: '', defaultProxy: '' });
      expect((await countTokens()).status).toBe(200);
    } finally {
      listAccounts.mockRestore();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });
});

describe('account queue and upstream cooldown', () => {
  function generateRequest(stream: boolean, signal?: AbortSignal): Request {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return new Request(`http://localhost:8048/v1beta/models/gemini-3.8-flash-medium:${action}`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
  }

  it.each([false, true])('returns retryable 503 when the account queue times out (stream=%s)', async (stream) => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const accounts = spyOn(store, 'listAccounts').mockReturnValue([
      makeAccount('queue-timeout', 'ready', { activeWorkers: 1 }),
    ]);
    const acquire = () => { throw new Error('A full account must not acquire a worker'); };
    try {
      updateConfig({ queueWaitTimeoutMs: 20, apiKey: '' });
      const app = createApp({ geminiDeps: { workerPool: { acquire, release() {} } } });
      const response = await app.fetch(generateRequest(stream));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { status: 'UNAVAILABLE' } });
    } finally {
      accounts.mockRestore();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });

  it.each([false, true])('cancels an enqueued request before a worker can be acquired (stream=%s)', async (stream) => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const account = makeAccount('queue-cancel', 'ready', { activeWorkers: 1 });
    const accounts = spyOn(store, 'listAccounts').mockReturnValue([account]);
    const workerPool = {
      async acquire() { throw new Error('A cancelled request must not acquire a worker'); },
      release() {},
    };
    const acquire = spyOn(workerPool, 'acquire');
    const controller = new AbortController();
    try {
      updateConfig({ queueWaitTimeoutMs: 2000, apiKey: '' });
      const app = createApp({ geminiDeps: { workerPool } });
      const pending = app.fetch(generateRequest(stream, controller.signal));
      await Bun.sleep(20);
      expect(accounts).toHaveBeenCalled();
      controller.abort();
      account.activeWorkers = 0;
      const response = await Promise.race([pending, Bun.sleep(500)]);
      expect(response?.status).toBe(499);
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      acquire.mockRestore();
      accounts.mockRestore();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });

  it.each([[2500, 3], [undefined, 120]])('uses the upstream hint or configured cooldown (hint=%s)', async (hintMs, expectedSeconds) => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const account = makeAccount('upstream-cooldown');
    const accounts = spyOn(store, 'listAccounts').mockReturnValue([account]);
    const family = 'gemini-3.8-flash';
    try {
      updateConfig({ cooldownStepsMinutes: [2], apiKey: '' });
      const workerError = new WorkerError('Upstream rate limited', {
        code: 'QUOTA_EXHAUSTED', upstreamStatus: 429, retryAfterMs: hintMs,
      });
      const app = createApp({ geminiDeps: { workerPool: {
        async acquire() {
          return { id: 'test-worker', accountId: account.id, async generate() { throw workerError; } };
        },
        release() {},
      } } });
      const startedAt = Date.now();
      const response = await app.fetch(generateRequest(false));
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe(String(expectedSeconds));
      const cooldown = store.listCooldowns(0).find((record) => record.accountId === account.id);
      const expectedMs = hintMs ?? expectedSeconds * 1000;
      expect(cooldown?.untilMs).toBeGreaterThanOrEqual(startedAt + expectedMs);
      expect(cooldown?.untilMs).toBeLessThanOrEqual(Date.now() + expectedMs);
    } finally {
      store.deleteCooldown(account.id, family, 'family');
      accounts.mockRestore();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });
});

describe('server cross-module wiring', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('adaptWorkerPool releases pool slot before invoking onRelease callback', async () => {
    let activeCountAtCallback = -1;
    let releasedAccountId = '';
    let innerReleaseCalled = false;

    const fakePool = {
      getActiveCount: () => (innerReleaseCalled ? 0 : 1),
      acquireWorker: () => ({
        worker: {
          executePrompt: async () => ({
            parts: [{ text: 'ok' }],
            finishReason: 'STOP',
          }),
        },
        release: () => {
          innerReleaseCalled = true;
        },
      }),
    } as unknown as AcpWorkerPool;

    const adapted = adaptWorkerPool(fakePool, (accountId) => {
      releasedAccountId = accountId;
      activeCountAtCallback = fakePool.getActiveCount(accountId);
    });

    const handle = await adapted.acquire({
      account: makeAccount('acc-wire-1'),
      sessionHash: 'sess-1',
      model: 'gemini-4-hydrogen',
      request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as GeminiGenerateRequest,
    });

    await adapted.release(handle);

    expect(innerReleaseCalled).toBe(true);
    expect(releasedAccountId).toBe('acc-wire-1');
    expect(activeCountAtCallback).toBe(0);
  });

  it('createApp skips prewarm by default and prewarms only ready full Pro accounts when enabled', async () => {
    const accounts = [
      makeAccount('acc-full-pro', 'ready', { tier: 'pro', quota: makeFlagshipQuota() }),
      makeAccount('acc-pro-no-flagship', 'ready', {
        tier: 'pro',
        quota: {
          fetchedAt: Date.now(),
          pools: { gemini_flagship: null, gemini_flash: null, third_party: null },
        },
      }),
      makeAccount('acc-std', 'ready', { tier: 'standard', quota: makeFlagshipQuota() }),
      makeAccount('acc-disabled-pro', 'disabled', { tier: 'pro', quota: makeFlagshipQuota() }),
    ];
    spies.push(spyOn(store, 'listAccounts').mockImplementation(() => accounts));

    const ensurePrewarmSpy = spyOn(AcpWorkerPool.prototype, 'ensurePrewarm').mockImplementation(
      async () => {},
    );
    spies.push(ensurePrewarmSpy);

    createApp();
    await new Promise((r) => setTimeout(r, 10));
    expect(ensurePrewarmSpy.mock.calls.length).toBe(0);

    createApp({ prewarm: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(ensurePrewarmSpy.mock.calls.length).toBe(1);
    const passedAccounts = ensurePrewarmSpy.mock.calls[0]?.[0] as AccountRecord[];
    expect(passedAccounts.map((a) => a.id)).toEqual(['acc-full-pro']);
  });
});
