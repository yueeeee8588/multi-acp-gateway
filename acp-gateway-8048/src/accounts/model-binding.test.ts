import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpWorkerPool } from '../acp/pool';
import { WorkerError } from '../acp/worker';
import * as settings from '../config/settings';
import { GatewayStore, store } from '../db/store';
import { createApp } from '../server';
import type { AccountRecord, GatewayConfig, ModelAccountBinding } from '../types';
import { AccountManager } from './manager';
import {
  matchesModelAccessRule,
  normalizeModelAccessRule,
  normalizeModelAccountBindings,
  resolveModelAccountBinding,
  wildcardMatch,
} from './model-binding';
import { AccountScheduler } from './scheduler';

const MODEL = 'gemini-4-neon';

function makeBinding(id: string, modelPattern: string, options: Partial<ModelAccountBinding> = {}): ModelAccountBinding {
  return { id, modelPattern, mode: 'priority', accountIds: ['bound'], enabled: true, ...options };
}

function makeAccount(id: string, options: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id, label: id, email: '', source: 'test', homeDir: '', proxyUrl: '', status: 'ready',
    tier: 'standard', statusReason: '', exitIp: '', exitCountry: '', concurrencyLimit: 1,
    activeWorkers: 0, lastVerifiedAt: null, createdAt: Date.now(), updatedAt: Date.now(), ...options,
  };
}

describe('model access and binding engine', () => {
  it('matches case-insensitive globs with full-string anchoring', () => {
    expect(wildcardMatch('GEMINI-*-neo?', MODEL)).toBe(true);
    expect(wildcardMatch('GEMINI-*', 'gemini-')).toBe(true);
    expect(wildcardMatch('gemini-?-neon', 'gemini-44-neon')).toBe(false);
    expect(wildcardMatch('*a**ab*?', 'aaaaabc')).toBe(true);
    expect(wildcardMatch('*a?b*c', 'aaabZc')).toBe(true);
    expect(wildcardMatch('neon', MODEL)).toBe(false);
    expect(wildcardMatch('gemini.4', 'gemini-4')).toBe(false);
    expect(wildcardMatch('**', '')).toBe(true);
    expect(wildcardMatch('?', '')).toBe(false);
    expect(wildcardMatch('', '')).toBe(true);
  });

  it('implements default, allow and deny rules including empty lists', () => {
    expect(matchesModelAccessRule(undefined, MODEL)).toBe(true);
    expect(matchesModelAccessRule({ mode: 'all', patterns: ['other-*'] }, MODEL)).toBe(true);
    expect(matchesModelAccessRule({ mode: 'allow', patterns: ['gemini-*'] }, MODEL)).toBe(true);
    expect(matchesModelAccessRule({ mode: 'allow', patterns: [] }, MODEL)).toBe(false);
    expect(matchesModelAccessRule({ mode: 'deny', patterns: ['gemini-*'] }, MODEL)).toBe(false);
    expect(matchesModelAccessRule({ mode: 'deny', patterns: [] }, MODEL)).toBe(true);
  });

  it('resolves conflicting rules by exact match, literals, prefix, star count and list order', () => {
    const pick = (...patterns: string[]) => resolveModelAccountBinding(
      patterns.map((pattern, index) => makeBinding(String(index), pattern)), MODEL,
    )?.id;
    expect(pick('gemini-4-neo?', 'GEMINI-4-NEON')).toBe('1');
    expect(pick('gemini-4*', 'gemini-*-neon')).toBe('1');
    expect(pick('gemini-*-neon', 'gemini-4-*eon')).toBe('1');
    expect(pick('gemini-**neon', 'gemini-*neon')).toBe('1');
    expect(pick('gemini-*-neo?', 'gemini-*-ne?n')).toBe('0');
    expect(resolveModelAccountBinding([
      makeBinding('disabled', MODEL, { enabled: false }),
      makeBinding('empty', MODEL, { accountIds: [] }),
    ], MODEL)).toBeNull();
  });

  it('normalizes valid payloads and rejects invalid modes and blank patterns', () => {
    expect(normalizeModelAccessRule(undefined)).toEqual({ mode: 'all', patterns: [] });
    expect(normalizeModelAccountBindings(undefined)).toEqual([]);
    expect(normalizeModelAccessRule({ mode: 'deny', patterns: [' gemini-* '] })).toEqual({
      mode: 'deny', patterns: ['gemini-*'],
    });
    expect(normalizeModelAccountBindings([
      makeBinding(' binding ', ' gemini-* ', { accountIds: ['bound', ' bound '], note: ' memo ' }),
    ])).toEqual([makeBinding('binding', 'gemini-*', { note: 'memo' })]);
    expect(() => normalizeModelAccessRule({ mode: 'unknown', patterns: [] })).toThrow('mode');
    expect(() => normalizeModelAccessRule({ mode: 'all', patterns: [' '] })).toThrow('patterns');
    expect(() => normalizeModelAccountBindings([{ ...makeBinding('id', MODEL), mode: 'all' }])).toThrow('mode');
    expect(() => normalizeModelAccountBindings([makeBinding('id', ' ')])).toThrow('modelPattern');
  });
});

describe('model binding scheduler', () => {
  async function withScheduler(run: (db: GatewayStore, scheduler: AccountScheduler, config: GatewayConfig) => Promise<void>) {
    const db = new GatewayStore(':memory:');
    const config: GatewayConfig = {
      ...settings.DEFAULT_CONFIG,
      routingStrategy: 'cache-first', queueWaitTimeoutMs: 100,
      minAccountRequestIntervalMs: 0, minExitIpRequestIntervalMs: 0, requestJitterMs: 0,
    };
    const configSpy = spyOn(settings, 'getConfig').mockReturnValue(config);
    try {
      db.upsertAccount(makeAccount('outside', { tier: 'pro', createdAt: 1 }));
      db.upsertAccount(makeAccount('bound', { createdAt: 2 }));
      await run(db, new AccountScheduler(db), config);
    } finally {
      configSpy.mockRestore();
      db.db.close();
    }
  }

  function cooldown(db: GatewayStore, reason: string, scopeType = 'family') {
    db.upsertCooldown({
      accountId: 'bound', family: scopeType === 'global' ? '*' : 'gemini-3-pro',
      scopeType, reason, untilMs: Date.now() + 10_000, consecutiveFailures: 1, lastError: reason,
    });
  }

  it('switches account and removes a now-ineligible sticky affinity', () => withScheduler(async (db, scheduler) => {
    const session = 'denied-sticky';
    scheduler.recordSuccess('outside', MODEL, session, { cachedTokens: 1024 });
    db.upsertAccount(makeAccount('outside', { modelAccessRule: { mode: 'deny', patterns: ['gemini-*'] } }));
    expect((await scheduler.acquireAccount(MODEL, session)).id).toBe('bound');
    expect(scheduler.getStickyEntry(session)?.accountId).toBe('bound');
    await expect(scheduler.acquireFallbackAccountLease('outside', MODEL)).rejects.toThrow('denied access');
  }));

  it('keeps exclusive requests in the binding when bound accounts are excluded, cooled, denied, or busy', () =>
    withScheduler(async (db, scheduler, config) => {
      config.modelAccountBindings = [makeBinding('only-bound', 'gemini-*', { mode: 'exclusive' })];
      const exclusiveError = /exclusive binding 'only-bound'/;
      expect((await scheduler.acquireAccount(MODEL)).id).toBe('bound');
      await expect(scheduler.acquireAccount(MODEL, undefined, new Set(['bound']))).rejects.toThrow(exclusiveError);
      await expect(scheduler.acquireFallbackAccountLease('outside', MODEL)).rejects.toThrow(exclusiveError);
      const lease = await scheduler.acquireAccountLease(MODEL);
      try {
        await expect(scheduler.acquireAccount(MODEL)).rejects.toThrow(exclusiveError);
      } finally {
        lease.release();
      }
      cooldown(db, 'POLICY_BLOCK', 'global');
      await expect(scheduler.acquireAccount(MODEL)).rejects.toThrow(exclusiveError);
      await expect(scheduler.acquireFallbackAccountLease('bound', MODEL)).rejects.toThrow(exclusiveError);
      db.deleteCooldown('bound', '*', 'global');
      db.upsertAccount(makeAccount('bound', { modelAccessRule: { mode: 'allow', patterns: ['claude-*'] } }));
      await expect(scheduler.acquireAccount(MODEL)).rejects.toThrow(exclusiveError);
      await expect(scheduler.acquireFallbackAccountLease('bound', MODEL)).rejects.toThrow(exclusiveError);
    }));

  it('uses available priority accounts ahead of pool-outside stickiness and immediately uses the remainder when busy', () =>
    withScheduler(async (_db, scheduler, config) => {
      config.modelAccountBindings = [makeBinding('priority', MODEL)];
      scheduler.recordSuccess('outside', MODEL, 'outside-session', { cachedTokens: 1024 });
      const fallback = await scheduler.acquireFallbackAccountLease('outside', MODEL);
      expect(fallback.account.id).toBe('bound');
      fallback.release();
      const preferred = await scheduler.acquireAccountLease(MODEL, 'outside-session');
      try {
        expect(preferred.account.id).toBe('bound');
        scheduler.recordSuccess('bound', MODEL, 'inside-session', { cachedTokens: 1024 });
        expect((await scheduler.acquireAccount(MODEL, 'inside-session')).id).toBe('outside');
        const remaining = await scheduler.acquireFallbackAccountLease('bound', MODEL);
        expect(remaining.account.id).toBe('outside');
        remaining.release();
      } finally {
        preferred.release();
      }
    }));

  it('permits same-account soft-cooldown bypass only inside the effective model policy', () =>
    withScheduler(async (db, scheduler, config) => {
      config.modelAccountBindings = [makeBinding('only-bound', 'gemini-3-*', { mode: 'exclusive' })];
      cooldown(db, 'SOFT_ERROR');
      const model = 'gemini-3-pro';
      await expect(scheduler.acquireAccount(model)).rejects.toThrow('exclusive binding');
      const fallback = await scheduler.acquireFallbackAccountLease('bound', model);
      expect(fallback.account.id).toBe('bound');
      fallback.release();
      expect(db.listCooldowns()).toHaveLength(1);
    }));
});

describe('model policy persistence and HTTP management', () => {
  it('adds the rule column to an existing database and preserves rules on old-style upserts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-binding-'));
    const filename = join(dir, 'gateway.db');
    let db = new GatewayStore(filename);
    try {
      const account = makeAccount('old-account');
      db.upsertAccount(account);
      db.db.exec('ALTER TABLE accounts DROP COLUMN model_access_json');
      db.db.close();
      db = new GatewayStore(filename);
      expect(db.getAccount(account.id)?.modelAccessRule).toEqual({ mode: 'all', patterns: [] });
      const rule = { mode: 'allow' as const, patterns: ['gemini-*'] };
      db.upsertAccount({ ...account, modelAccessRule: rule });
      db.upsertAccount({ ...account, label: 'new label' });
      db.db.close();
      db = new GatewayStore(filename);
      expect(db.getAccount(account.id)).toMatchObject({ label: 'new label', modelAccessRule: rule });
    } finally {
      db.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('performs one same-account retry on exclusive binding after a thought-only turn', async () => {
    const previous = store.getConfigValue<GatewayConfig>('gateway_config');
    const bound = makeAccount('exclusive-api-bound');
    const outside = makeAccount('exclusive-api-outside');
    const picked: string[] = [];
    const pool = spyOn(AcpWorkerPool.prototype, 'acquireWorker').mockImplementation((account) => {
      picked.push(account.id);
      return {
        worker: {
          executePrompt: async () => {
            if (picked.length === 1) {
              throw new WorkerError('Empty turn', {
                code: 'SOFT_ERROR', upstreamStatus: 502, rawError: 'EMPTY_OR_THOUGHT_ONLY_RESPONSE',
              });
            }
            return { parts: [{ text: 'ok' }], finishReason: 'STOP' };
          },
        },
        release: () => {},
      } as unknown as ReturnType<AcpWorkerPool['acquireWorker']>;
    });
    try {
      store.upsertAccount(bound);
      store.upsertAccount(outside);
      settings.updateConfig({
        apiKey: '', minAccountRequestIntervalMs: 0, minExitIpRequestIntervalMs: 0, requestJitterMs: 0,
        modelAccountBindings: [makeBinding('exclusive-api', 'gemini-*', { mode: 'exclusive', accountIds: [bound.id] })],
      });
      const response = await createApp().fetch(new Request(
        'http://localhost:8048/v1beta/models/gemini-3.8-flash-medium:generateContent',
        { method: 'POST', body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) },
      ));
      expect(response.status).toBe(200);
      expect((await response.json()).candidates[0].content.parts).toEqual([{ text: 'ok' }]);
      expect(picked).toEqual([bound.id, bound.id]);
    } finally {
      pool.mockRestore();
      store.deleteCooldown(bound.id, 'gemini-3.8-flash', 'family');
      store.deleteAccount(bound.id);
      store.deleteAccount(outside.id);
      store.setConfigValue('gateway_config', previous);
      settings.invalidateConfigCache();
    }
  });

  it('validates account and config writes, persists normalized values, and emits both SSE events', async () => {
    const previous = store.getConfigValue<GatewayConfig>('gateway_config');
    const account = makeAccount('model-binding-api-account');
    store.upsertAccount(account);
    const app = createApp();
    const request = (path: string, patch?: object) => app.fetch(new Request(`http://localhost:8048/api/${path}`,
      patch && { method: 'PUT', body: JSON.stringify(patch) }));
    const reader = (await request('events')).body!.getReader();
    const readEvent = async (event: string) => {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain(`event: ${event}`);
      return text;
    };
    const accountPath = `accounts/${account.id}`;
    try {
      for (const event of ['status', 'accounts', 'cooldowns', 'requests', 'config']) {
        await readEvent(event);
      }
      const initialConfig = await request('config');
      expect(initialConfig.status).toBe(200);
      expect((await initialConfig.json()).modelAccountBindings).toEqual(previous?.modelAccountBindings ?? []);
      const invalidAccount = await request(accountPath, { modelAccessRule: { mode: 'allow', patterns: [' '] } });
      expect(invalidAccount.status).toBe(400);
      const invalidConfig = await request('config', { modelAccountBindings: [makeBinding('invalid', '')] });
      expect(invalidConfig.status).toBe(400);
      expect(store.getAccount(account.id)?.modelAccessRule?.mode).toBe('all');
      expect((await request(accountPath, { modelAccessRule: { mode: 'deny', patterns: [' gemini-* '] } })).status).toBe(200);
      expect(await readEvent('accounts')).toContain('"patterns":["gemini-*"]');
      const manager = new AccountManager();
      expect(() => manager.updateAccount(account.id, { modelAccessRule: { mode: 'deny', patterns: [''] } })).toThrow('patterns');
      manager.updateAccount(account.id, { modelAccessRule: { mode: 'allow', patterns: [' gemini-4-* '] } });
      expect(await readEvent('accounts')).toContain('"patterns":["gemini-4-*"]');
      expect(store.getAccount(account.id)?.modelAccessRule).toEqual({ mode: 'allow', patterns: ['gemini-4-*'] });
      const binding = makeBinding('api-binding', ' gemini-* ', { accountIds: [account.id], mode: 'exclusive' });
      expect((await request('config', { modelAccountBindings: [binding] })).status).toBe(200);
      expect(await readEvent('config')).toContain('"modelPattern":"gemini-*"');
      settings.invalidateConfigCache();
      expect((await (await request('config')).json()).modelAccountBindings).toEqual([{ ...binding, modelPattern: 'gemini-*' }]);
      expect(store.getConfigValue<GatewayConfig>('gateway_config')?.modelAccountBindings?.[0]?.id).toBe(binding.id);

      const result = await app.fetch(new Request(
        'http://localhost:8048/v1beta/models/gemini-3.8-flash-medium:generateContent',
        {
          method: 'POST',
          headers: { 'x-goog-api-key': settings.getConfig().apiKey },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
        },
      ));
      expect(result.status).toBe(503);
      expect((await result.json()).error.message).toContain("exclusive binding 'api-binding'");
    } finally {
      await reader.cancel();
      store.deleteAccount(account.id);
      store.setConfigValue('gateway_config', previous);
      settings.invalidateConfigCache();
    }
  });
});
