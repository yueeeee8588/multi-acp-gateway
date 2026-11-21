import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  DEFAULT_CONFIG,
  getConfig,
  invalidateConfigCache,
  resolveEffectiveProxy,
  updateConfig,
  validateRiskControlPatch,
} from '../src/config/settings';
import { store } from '../src/db/store';
import { createApp } from '../src/server';
import type { GatewayConfig } from '../src/types';

describe('wp1_config_contract: risk-control schema, validation & resolveEffectiveProxy', () => {
  const originalSaved = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');

  afterEach(() => {
    if (originalSaved === undefined || originalSaved === null) {
      store.setConfigValue('gateway_config', { ...DEFAULT_CONFIG });
    } else {
      store.setConfigValue('gateway_config', originalSaved);
    }
    invalidateConfigCache();
  });

  it('exposes exact default values for all 8 risk-control fields', () => {
    expect(DEFAULT_CONFIG.strictProxyBinding).toBe(true);
    expect(DEFAULT_CONFIG.blockOnExitIpDrift).toBe(false);
    expect(DEFAULT_CONFIG.maxConcurrencyPerExitIp).toBe(4);
    expect(DEFAULT_CONFIG.minExitIpRequestIntervalMs).toBe(250);
    expect(DEFAULT_CONFIG.minAccountRequestIntervalMs).toBe(500);
    expect(DEFAULT_CONFIG.requestJitterMs).toBe(300);
    expect(DEFAULT_CONFIG.maxWorkerSpawnsPerMinute).toBe(12);
    expect(DEFAULT_CONFIG.quotaCooldownScope).toBe('family');
  });

  it('backfills missing risk-control fields from DEFAULT_CONFIG for legacy SQLite config', () => {
    const legacySaved: Partial<GatewayConfig> = {
      port: 8048,
      host: '127.0.0.1',
      defaultProxy: 'http://127.0.0.1:7890',
      routingStrategy: 'sticky-round-robin',
    };
    const spy = spyOn(store, 'getConfigValue').mockReturnValue(legacySaved);
    try {
      invalidateConfigCache();
      const cfg = getConfig();
      expect(cfg.defaultProxy).toBe('http://127.0.0.1:7890');
      expect(cfg.strictProxyBinding).toBe(true);
      expect(cfg.blockOnExitIpDrift).toBe(false);
      expect(cfg.maxConcurrencyPerExitIp).toBe(4);
      expect(cfg.minExitIpRequestIntervalMs).toBe(250);
      expect(cfg.minAccountRequestIntervalMs).toBe(500);
      expect(cfg.requestJitterMs).toBe(300);
      expect(cfg.maxWorkerSpawnsPerMinute).toBe(12);
      expect(cfg.quotaCooldownScope).toBe('family');
    } finally {
      spy.mockRestore();
      invalidateConfigCache();
    }
  });

  it('normalizes corrupted legacy values in SQLite config', () => {
    const corrupted = {
      strictProxyBinding: 'yes',
      blockOnExitIpDrift: 1,
      maxConcurrencyPerExitIp: 999,
      minExitIpRequestIntervalMs: -50,
      minAccountRequestIntervalMs: 'bad',
      requestJitterMs: 12.6,
      maxWorkerSpawnsPerMinute: 500,
      quotaCooldownScope: 'invalid',
    } as unknown as Partial<GatewayConfig>;
    const spy = spyOn(store, 'getConfigValue').mockReturnValue(corrupted);
    try {
      invalidateConfigCache();
      const cfg = getConfig();
      expect(cfg.strictProxyBinding).toBe(true);
      expect(cfg.blockOnExitIpDrift).toBe(false);
      expect(cfg.maxConcurrencyPerExitIp).toBe(64);
      expect(cfg.minExitIpRequestIntervalMs).toBe(0);
      expect(cfg.minAccountRequestIntervalMs).toBe(500);
      expect(cfg.requestJitterMs).toBe(13);
      expect(cfg.maxWorkerSpawnsPerMinute).toBe(120);
      expect(cfg.quotaCooldownScope).toBe('family');
    } finally {
      spy.mockRestore();
      invalidateConfigCache();
    }
  });

  describe('resolveEffectiveProxy', () => {
    it('prefers trimmed accountProxyUrl over defaultProxy', () => {
      expect(
        resolveEffectiveProxy('  http://user:pass@127.0.0.1:7891  ', {
          defaultProxy: 'http://127.0.0.1:7890',
        }),
      ).toBe('http://user:pass@127.0.0.1:7891');
    });

    it('falls back to defaultProxy when accountProxyUrl is empty, whitespace, null, or undefined', () => {
      const cfg = { defaultProxy: '  socks5://127.0.0.1:1080  ' };
      expect(resolveEffectiveProxy('', cfg)).toBe('socks5://127.0.0.1:1080');
      expect(resolveEffectiveProxy('   \t ', cfg)).toBe('socks5://127.0.0.1:1080');
      expect(resolveEffectiveProxy(null, cfg)).toBe('socks5://127.0.0.1:1080');
      expect(resolveEffectiveProxy(undefined, cfg)).toBe('socks5://127.0.0.1:1080');
    });

    it('returns undefined when both accountProxyUrl and defaultProxy are empty or whitespace', () => {
      expect(resolveEffectiveProxy('', { defaultProxy: '' })).toBeUndefined();
      expect(resolveEffectiveProxy('   ', { defaultProxy: '   ' })).toBeUndefined();
      expect(resolveEffectiveProxy(null, { defaultProxy: '' })).toBeUndefined();
    });

    it('reads defaultProxy from getConfig() when config argument is omitted', () => {
      updateConfig({ defaultProxy: 'http://127.0.0.1:8888' });
      expect(resolveEffectiveProxy('')).toBe('http://127.0.0.1:8888');
      expect(resolveEffectiveProxy('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');

      updateConfig({ defaultProxy: '' });
      expect(resolveEffectiveProxy('')).toBeUndefined();
    });
  });

  describe('validateRiskControlPatch & /api/config GET/PUT', () => {
    it('accepts valid boundary values via PUT /api/config and exposes them in GET /api/config', async () => {
      const listAccounts = spyOn(store, 'listAccounts').mockReturnValue([]);
      const app = createApp();
      const url = 'http://localhost:8048/api/config';

      try {
        const minRes = await app.fetch(
          new Request(url, {
            method: 'PUT',
            body: JSON.stringify({
              strictProxyBinding: false,
              blockOnExitIpDrift: true,
              maxConcurrencyPerExitIp: 0,
              minExitIpRequestIntervalMs: 0,
              minAccountRequestIntervalMs: 0,
              requestJitterMs: 0,
              maxWorkerSpawnsPerMinute: 0,
              quotaCooldownScope: 'account',
            }),
          }),
        );
        expect(minRes.status).toBe(200);
        const minBody = (await minRes.json()) as GatewayConfig;
        expect(minBody.strictProxyBinding).toBe(false);
        expect(minBody.blockOnExitIpDrift).toBe(true);
        expect(minBody.maxConcurrencyPerExitIp).toBe(0);
        expect(minBody.minExitIpRequestIntervalMs).toBe(0);
        expect(minBody.minAccountRequestIntervalMs).toBe(0);
        expect(minBody.requestJitterMs).toBe(0);
        expect(minBody.maxWorkerSpawnsPerMinute).toBe(0);
        expect(minBody.quotaCooldownScope).toBe('account');

        const maxRes = await app.fetch(
          new Request(url, {
            method: 'PUT',
            body: JSON.stringify({
              strictProxyBinding: true,
              blockOnExitIpDrift: false,
              maxConcurrencyPerExitIp: 64,
              minExitIpRequestIntervalMs: 10000,
              minAccountRequestIntervalMs: 30000,
              requestJitterMs: 10000,
              maxWorkerSpawnsPerMinute: 120,
              quotaCooldownScope: 'family',
            }),
          }),
        );
        expect(maxRes.status).toBe(200);

        const getRes = await app.fetch(new Request(url));
        expect(getRes.status).toBe(200);
        const getBody = (await getRes.json()) as GatewayConfig;
        expect(getBody).toMatchObject({
          strictProxyBinding: true,
          blockOnExitIpDrift: false,
          maxConcurrencyPerExitIp: 64,
          minExitIpRequestIntervalMs: 10000,
          minAccountRequestIntervalMs: 30000,
          requestJitterMs: 10000,
          maxWorkerSpawnsPerMinute: 120,
          quotaCooldownScope: 'family',
        });
      } finally {
        listAccounts.mockRestore();
      }
    });

    it('rejects out-of-range and wrong-type risk-control fields with 400', async () => {
      const listAccounts = spyOn(store, 'listAccounts').mockReturnValue([]);
      const app = createApp();
      const url = 'http://localhost:8048/api/config';

      const invalidPayloads: Record<string, unknown>[] = [
        { strictProxyBinding: 'true' },
        { strictProxyBinding: null },
        { blockOnExitIpDrift: 0 },
        { maxConcurrencyPerExitIp: -1 },
        { maxConcurrencyPerExitIp: 65 },
        { maxConcurrencyPerExitIp: 2.5 },
        { maxConcurrencyPerExitIp: '4' },
        { minExitIpRequestIntervalMs: -1 },
        { minExitIpRequestIntervalMs: 10001 },
        { minExitIpRequestIntervalMs: 10.5 },
        { minAccountRequestIntervalMs: -1 },
        { minAccountRequestIntervalMs: 30001 },
        { minAccountRequestIntervalMs: 1.2 },
        { requestJitterMs: -1 },
        { requestJitterMs: 10001 },
        { requestJitterMs: 0.5 },
        { maxWorkerSpawnsPerMinute: -1 },
        { maxWorkerSpawnsPerMinute: 121 },
        { maxWorkerSpawnsPerMinute: 3.14 },
        { quotaCooldownScope: 'global' },
        { quotaCooldownScope: 123 },
      ];

      try {
        for (const payload of invalidPayloads) {
          expect(() => validateRiskControlPatch(payload)).toThrow();
          const res = await app.fetch(
            new Request(url, {
              method: 'PUT',
              body: JSON.stringify(payload),
            }),
          );
          expect(res.status).toBe(400);
        }
      } finally {
        listAccounts.mockRestore();
      }
    });
  });
});

describe('wp0_config_contract: failover, policy cooldown, 429 cancel & component exclusion', () => {
  const originalSaved = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');

  afterEach(() => {
    if (originalSaved === undefined || originalSaved === null) {
      store.setConfigValue('gateway_config', { ...DEFAULT_CONFIG });
    } else {
      store.setConfigValue('gateway_config', originalSaved);
    }
    invalidateConfigCache();
  });

  it('exposes exact default values for all 5 WP0 fields', () => {
    expect(DEFAULT_CONFIG.excludeDefaultComponents).toBe(false);
    expect(DEFAULT_CONFIG.accountFailover).toBe(false);
    expect(DEFAULT_CONFIG.maxQuotaAccountSwitches).toBe(1);
    expect(DEFAULT_CONFIG.policyBlockCooldownMs).toBe(21_600_000);
    expect(DEFAULT_CONFIG.maxInternal429RetriesBeforeCancel).toBe(2);
  });

  it('backfills missing WP0 fields from DEFAULT_CONFIG for legacy SQLite config', () => {
    const legacySaved: Partial<GatewayConfig> = {
      port: 8048,
      host: '127.0.0.1',
      routingStrategy: 'sticky-round-robin',
    };
    const spy = spyOn(store, 'getConfigValue').mockReturnValue(legacySaved);
    try {
      invalidateConfigCache();
      const cfg = getConfig();
      expect(cfg.excludeDefaultComponents).toBe(false);
      expect(cfg.accountFailover).toBe(false);
      expect(cfg.maxQuotaAccountSwitches).toBe(1);
      expect(cfg.policyBlockCooldownMs).toBe(21_600_000);
      expect(cfg.maxInternal429RetriesBeforeCancel).toBe(2);
    } finally {
      spy.mockRestore();
      invalidateConfigCache();
    }
  });

  it('normalizes corrupted and out-of-range WP0 values in SQLite config', () => {
    const corrupted = {
      excludeDefaultComponents: 'yes',
      accountFailover: 1,
      maxQuotaAccountSwitches: 99,
      policyBlockCooldownMs: 1000,
      maxInternal429RetriesBeforeCancel: 0,
    } as unknown as Partial<GatewayConfig>;
    const spy = spyOn(store, 'getConfigValue').mockReturnValue(corrupted);
    try {
      invalidateConfigCache();
      const cfg = getConfig();
      expect(cfg.excludeDefaultComponents).toBe(false);
      expect(cfg.accountFailover).toBe(false);
      expect(cfg.maxQuotaAccountSwitches).toBe(10);
      expect(cfg.policyBlockCooldownMs).toBe(60_000);
      expect(cfg.maxInternal429RetriesBeforeCancel).toBe(1);
    } finally {
      spy.mockRestore();
      invalidateConfigCache();
    }
  });

  it('persists and reloads WP0 fields across updateConfig and invalidateConfigCache', () => {
    updateConfig({
      excludeDefaultComponents: true,
      accountFailover: true,
      maxQuotaAccountSwitches: 4,
      policyBlockCooldownMs: 3_600_000,
      maxInternal429RetriesBeforeCancel: 5,
    });
    invalidateConfigCache();
    const reloaded = getConfig();
    expect(reloaded.excludeDefaultComponents).toBe(true);
    expect(reloaded.accountFailover).toBe(true);
    expect(reloaded.maxQuotaAccountSwitches).toBe(4);
    expect(reloaded.policyBlockCooldownMs).toBe(3_600_000);
    expect(reloaded.maxInternal429RetriesBeforeCancel).toBe(5);
  });

  it('accepts valid WP0 boundary values via PUT /api/config and exposes them in GET /api/config', async () => {
    const listAccounts = spyOn(store, 'listAccounts').mockReturnValue([]);
    const app = createApp();
    const url = 'http://localhost:8048/api/config';

    try {
      const minRes = await app.fetch(
        new Request(url, {
          method: 'PUT',
          body: JSON.stringify({
            excludeDefaultComponents: true,
            accountFailover: true,
            maxQuotaAccountSwitches: 0,
            policyBlockCooldownMs: 60_000,
            maxInternal429RetriesBeforeCancel: 1,
          }),
        }),
      );
      expect(minRes.status).toBe(200);
      const minBody = (await minRes.json()) as GatewayConfig;
      expect(minBody).toMatchObject({
        excludeDefaultComponents: true,
        accountFailover: true,
        maxQuotaAccountSwitches: 0,
        policyBlockCooldownMs: 60_000,
        maxInternal429RetriesBeforeCancel: 1,
      });

      const maxRes = await app.fetch(
        new Request(url, {
          method: 'PUT',
          body: JSON.stringify({
            excludeDefaultComponents: false,
            accountFailover: false,
            maxQuotaAccountSwitches: 10,
            policyBlockCooldownMs: 604_800_000,
            maxInternal429RetriesBeforeCancel: 8,
          }),
        }),
      );
      expect(maxRes.status).toBe(200);

      const getRes = await app.fetch(new Request(url));
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as GatewayConfig;
      expect(getBody).toMatchObject({
        excludeDefaultComponents: false,
        accountFailover: false,
        maxQuotaAccountSwitches: 10,
        policyBlockCooldownMs: 604_800_000,
        maxInternal429RetriesBeforeCancel: 8,
      });
    } finally {
      listAccounts.mockRestore();
    }
  });

  it('rejects invalid WP0 types, non-integers, and out-of-range values with 400', async () => {
    const listAccounts = spyOn(store, 'listAccounts').mockReturnValue([]);
    const app = createApp();
    const url = 'http://localhost:8048/api/config';

    const invalidPayloads: Record<string, unknown>[] = [
      { excludeDefaultComponents: 'true' },
      { excludeDefaultComponents: null },
      { excludeDefaultComponents: 1 },
      { accountFailover: 'false' },
      { accountFailover: null },
      { accountFailover: 0 },
      { maxQuotaAccountSwitches: -1 },
      { maxQuotaAccountSwitches: 11 },
      { maxQuotaAccountSwitches: 1.5 },
      { maxQuotaAccountSwitches: '1' },
      { policyBlockCooldownMs: 59_999 },
      { policyBlockCooldownMs: 604_800_001 },
      { policyBlockCooldownMs: 60_000.5 },
      { policyBlockCooldownMs: '60000' },
      { maxInternal429RetriesBeforeCancel: 0 },
      { maxInternal429RetriesBeforeCancel: 9 },
      { maxInternal429RetriesBeforeCancel: 2.5 },
      { maxInternal429RetriesBeforeCancel: '2' },
    ];

    try {
      for (const payload of invalidPayloads) {
        expect(() => validateRiskControlPatch(payload)).toThrow();
        const res = await app.fetch(
          new Request(url, {
            method: 'PUT',
            body: JSON.stringify(payload),
          }),
        );
        expect(res.status).toBe(400);
      }
    } finally {
      listAccounts.mockRestore();
    }
  });
});
