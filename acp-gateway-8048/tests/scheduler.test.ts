import { describe, expect, it } from 'bun:test';
import { createApp } from '../src/server';
import { parseCodeAssistTier } from '../src/accounts/manager';
import { normalizeModelFamily } from '../src/accounts/scheduler';
import type { SchedulerLike, WorkerPoolLike } from '../src/gemini/handler';
import type { AccountRecord } from '../src/types';

function makeAccount(id: string): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Account-${id}`,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: '',
    proxyUrl: '',
    status: 'ready',
    statusReason: '',
    exitIp: '1.2.3.4',
    exitCountry: 'JP',
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

class InMemoryTestScheduler implements SchedulerLike {
  private accounts: AccountRecord[];
  private cooldowns = new Map<string, { untilMs: number; failures: number }>();
  private sticky = new Map<string, string>();
  private stepsMinutes = [1, 5, 15, 30, 60];

  constructor(accounts: AccountRecord[]) {
    this.accounts = accounts;
  }

  private key(accountId: string, family: string) {
    return `${accountId}::${normalizeModelFamily(family)}`;
  }

  selectAccount({
    family,
    sessionHash,
    excludeAccountIds,
  }: {
    family: string;
    sessionHash: string;
    excludeAccountIds: string[];
  }) {
    const now = Date.now();
    const normFamily = normalizeModelFamily(family);
    const isAvailable = (acc: AccountRecord) => {
      if (excludeAccountIds.includes(acc.id)) return false;
      const cd = this.cooldowns.get(this.key(acc.id, normFamily));
      return !cd || cd.untilMs <= now;
    };

    const stickyId = this.sticky.get(`${sessionHash}::${normFamily}`);
    if (stickyId) {
      const stickyAcc = this.accounts.find((a) => a.id === stickyId);
      if (stickyAcc && isAvailable(stickyAcc)) {
        return { account: stickyAcc };
      }
    }

    const next = this.accounts.find(isAvailable) ?? null;
    if (next) {
      this.sticky.set(`${sessionHash}::${normFamily}`, next.id);
      return { account: next };
    }

    let minWaitSec = 60;
    for (const acc of this.accounts) {
      const cd = this.cooldowns.get(this.key(acc.id, normFamily));
      if (cd && cd.untilMs > now) {
        minWaitSec = Math.min(minWaitSec, Math.max(1, Math.ceil((cd.untilMs - now) / 1000)));
      }
    }
    return { account: null, retryAfterSeconds: minWaitSec };
  }

  reportFailure({ accountId, family }: { accountId: string; family: string }) {
    const k = this.key(accountId, family);
    const prev = this.cooldowns.get(k);
    const failures = (prev?.failures ?? 0) + 1;
    const stepIdx = Math.min(failures - 1, this.stepsMinutes.length - 1);
    const minutes = this.stepsMinutes[stepIdx];
    this.cooldowns.set(k, {
      failures,
      untilMs: Date.now() + minutes * 60_000,
    });
    return { retryAfterSeconds: minutes * 60 };
  }

  getCooldownMinutes(accountId: string, family: string): number {
    const cd = this.cooldowns.get(this.key(accountId, family));
    if (!cd) return 0;
    return Math.round((cd.untilMs - Date.now()) / 60_000);
  }
}

describe('scheduler & cooldown behavior', () => {
  it('isolates cooldowns by model family and progresses 1/5/15/30/60 minutes', () => {
    const sched = new InMemoryTestScheduler([makeAccount('a1'), makeAccount('a2')]);

    // Progressive cooldowns on gemini-2.5
    expect(sched.reportFailure({ accountId: 'a1', family: 'gemini-2.5' }).retryAfterSeconds).toBe(60);
    expect(sched.reportFailure({ accountId: 'a1', family: 'gemini-2.5' }).retryAfterSeconds).toBe(300);
    expect(sched.reportFailure({ accountId: 'a1', family: 'gemini-2.5' }).retryAfterSeconds).toBe(900);
    expect(sched.reportFailure({ accountId: 'a1', family: 'gemini-2.5' }).retryAfterSeconds).toBe(1800);
    expect(sched.reportFailure({ accountId: 'a1', family: 'gemini-2.5' }).retryAfterSeconds).toBe(3600);
    expect(sched.getCooldownMinutes('a1', 'gemini-2.5')).toBe(60);

    // claude family remains unaffected for a1
    const claudePick = sched.selectAccount({ family: 'claude', sessionHash: 's1', excludeAccountIds: [] });
    expect(claudePick.account?.id).toBe('a1');

    // gemini-2.5 rebinds to a2
    const geminiPick = sched.selectAccount({ family: 'gemini-2.5', sessionHash: 's1', excludeAccountIds: [] });
    expect(geminiPick.account?.id).toBe('a2');
  });

  it('maintains sticky affinity and rebinds on cooldown', () => {
    const sched = new InMemoryTestScheduler([makeAccount('a1'), makeAccount('a2')]);
    const p1 = sched.selectAccount({ family: 'gemini-2.5', sessionHash: 'hash1', excludeAccountIds: [] });
    const p2 = sched.selectAccount({ family: 'gemini-2.5', sessionHash: 'hash1', excludeAccountIds: [] });
    expect(p1.account?.id).toBe('a1');
    expect(p2.account?.id).toBe('a1');

    sched.reportFailure({ accountId: 'a1', family: 'gemini-2.5' });
    const p3 = sched.selectAccount({ family: 'gemini-2.5', sessionHash: 'hash1', excludeAccountIds: [] });
    expect(p3.account?.id).toBe('a2');
  });

  it('returns HTTP 429 with Retry-After header when all accounts are in cooldown', async () => {
    const sched = new InMemoryTestScheduler([makeAccount('a1')]);
    sched.reportFailure({ accountId: 'a1', family: 'gemini-3.8-flash-low' });

    const dummyPool: WorkerPoolLike = {
      async acquire() {
        throw new Error('Should not acquire when pool is cooled down');
      },
      release() {},
    };

    const app = createApp({ geminiDeps: { scheduler: sched, workerPool: dummyPool } });
    const res = await app.fetch(
      new Request('http://127.0.0.1:8048/v1beta/models/gemini-3.8-flash-low:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        }),
      })
    );

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('passes the resolved Hydrogen variant to the scheduler', async () => {
    const receivedFamilies: string[] = [];
    const trackingSched: SchedulerLike = {
      selectAccount({ family }) {
        receivedFamilies.push(family);
        return { account: null, retryAfterSeconds: 10 };
      },
    };
    const dummyPool: WorkerPoolLike = {
      async acquire() {
        throw new Error('Should not acquire');
      },
      release() {},
    };

    const app = createApp({ geminiDeps: { scheduler: trackingSched, workerPool: dummyPool } });
    const res = await app.fetch(
      new Request('http://127.0.0.1:8048/v1beta/models/gemini-4-hydrogen:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        }),
      })
    );

    expect(res.status).toBe(429);
    expect(receivedFamilies).toEqual(['gemini-4-hydrogen-medium']);
    expect(normalizeModelFamily(receivedFamilies[0]!)).toBe('gemini-4-hydrogen');
    expect(normalizeModelFamily(receivedFamilies[0])).toBe('gemini-4-hydrogen');
  });
});

describe('parseCodeAssistTier', () => {
  it('reads paidTier.id and maps pro/ultra to pro', () => {
    expect(parseCodeAssistTier({ paidTier: { id: 'g1-pro-tier' } })).toBe('pro');
    expect(parseCodeAssistTier({ paidTier: { id: 'G1-ULTRA-TIER' } })).toBe('pro');
    expect(parseCodeAssistTier({ paidTier: { id: 'ultra-tier' } })).toBe('pro');
  });

  it('reads snake_case paid_tier and current_tier', () => {
    expect(parseCodeAssistTier({ paid_tier: { id: 'g1-pro-tier' } })).toBe('pro');
    expect(parseCodeAssistTier({ current_tier: { id: 'free-tier' } })).toBe('standard');
  });

  it('prefers paidTier over currentTier', () => {
    const payload = {
      paidTier: { id: 'g1-pro-tier' },
      currentTier: { id: 'free-tier' },
    };
    expect(parseCodeAssistTier(payload)).toBe('pro');
  });

  it('falls back to currentTier when paidTier is absent', () => {
    expect(parseCodeAssistTier({ currentTier: { id: 'g1-ultra-tier' } })).toBe('pro');
    expect(parseCodeAssistTier({ currentTier: { id: 'standard-tier' } })).toBe('standard');
  });

  it('maps present-but-non-pro tiers to standard', () => {
    expect(parseCodeAssistTier({ paidTier: { id: 'free-tier' } })).toBe('standard');
    expect(parseCodeAssistTier({ paidTier: { id: 'standard-tier' } })).toBe('standard');
    expect(parseCodeAssistTier({ paidTier: { id: 'legacy-tier' } })).toBe('standard');
  });

  it('accepts a plain string tier field', () => {
    expect(parseCodeAssistTier({ paidTier: 'g1-pro-tier' })).toBe('pro');
    expect(parseCodeAssistTier({ currentTier: 'free-tier' })).toBe('standard');
  });

  it('returns null when no tier field exists or id is empty', () => {
    expect(parseCodeAssistTier({})).toBeNull();
    expect(parseCodeAssistTier({ paidTier: { id: '' } })).toBeNull();
    expect(parseCodeAssistTier({ currentTier: {} })).toBeNull();
    expect(parseCodeAssistTier({ paidTier: null, currentTier: null })).toBeNull();
  });
});
