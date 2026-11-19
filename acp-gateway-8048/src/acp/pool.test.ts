import { describe, expect, it, spyOn } from 'bun:test';
import { LoopbackMcpServer } from './loopback-mcp';
import { AcpWorkerPool, DEFAULT_WORKER_IDLE_TTL_MS } from './pool';
import { store } from '../db/store';
import type { AcpTransport, AcpTransportFactory } from './worker';
import type { AccountRecord, GeminiGenerateRequest } from '../types';

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
    tier: 'standard',
    statusReason: '',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRequest(text: string): GeminiGenerateRequest {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
  };
}

const dummyTransportFactory: AcpTransportFactory = () => {
  throw new Error('Transport should not be spawned in pool unit tests');
};

describe('AcpWorkerPool keepalive & unified sessionKey', () => {
  it('defaults idleTtlMs to 30 minutes and keeps idle workers alive until 30m elapses', async () => {
    expect(DEFAULT_WORKER_IDLE_TTL_MS).toBe(30 * 60 * 1000);

    const pool = new AcpWorkerPool({
      mcpServer: new LoopbackMcpServer(),
      cleanupIntervalMs: 60_000,
      transportFactory: dummyTransportFactory,
    });

    try {
      expect(pool.getIdleTtlMs()).toBe(30 * 60 * 1000);

      const account = makeAccount('acc-pool-1');
      const req = makeRequest('hello');
      const { worker, release } = pool.acquireWorker(account, 'gemini-4-hydrogen', req, 'sess-ttl-1');
      worker.canReuse = () => true;
      release();

      const releasedAt = worker.lastUsedAt;
      // 29 minutes later: still kept alive
      const evictedAt29m = await pool.cleanupIdleWorkers(releasedAt + 29 * 60 * 1000);
      expect(evictedAt29m).toBe(0);

      // Re-acquire reuses the same worker instance
      const second = pool.acquireWorker(account, 'gemini-4-hydrogen', req, 'sess-ttl-1');
      expect(second.worker).toBe(worker);
      second.release();

      // 31 minutes after last release: evicted
      const evictedAt31m = await pool.cleanupIdleWorkers(second.worker.lastUsedAt + 31 * 60 * 1000);
      expect(evictedAt31m).toBe(1);
    } finally {
      await pool.shutdownAll();
    }
  });

  it('isolates workers by unified sessionKey including |agent:<subagentId>', async () => {
    const pool = new AcpWorkerPool({
      mcpServer: new LoopbackMcpServer(),
      cleanupIntervalMs: 60_000,
      transportFactory: dummyTransportFactory,
    });

    try {
      const account = makeAccount('acc-pool-2');
      const req = makeRequest('shared prompt');

      const main1 = pool.acquireWorker(account, 'gemini-4-hydrogen', req, 'sess-main');
      main1.worker.canReuse = () => true;
      main1.release();

      const sub1 = pool.acquireWorker(account, 'gemini-4-hydrogen', req, 'sess-main|agent:sub-a');
      sub1.worker.canReuse = () => true;
      sub1.release();

      // Subagent must not reuse main agent's worker even with identical request body
      expect(sub1.worker).not.toBe(main1.worker);

      // Same sessionKey reuses its own worker
      const main2 = pool.acquireWorker(account, 'gemini-4-hydrogen', req, 'sess-main');
      expect(main2.worker).toBe(main1.worker);
      main2.release();
    } finally {
      await pool.shutdownAll();
    }
  });
});

describe('AcpWorkerPool prewarm & in-memory activeCounts', () => {
  it('tracks active counts in memory without calling store.upsertAccount', async () => {
    const upsertSpy = spyOn(store, 'upsertAccount');
    const pool = new AcpWorkerPool({
      mcpServer: new LoopbackMcpServer(),
      cleanupIntervalMs: 60_000,
      prewarmPerAccount: 0,
      transportFactory: dummyTransportFactory,
    });

    try {
      const account = makeAccount('acc-mem-1');
      const req = makeRequest('hello');

      expect(pool.getActiveCount(account.id)).toBe(0);
      const acquired = pool.acquireWorker(account, 'gemini-4-hydrogen', req, 'sess-mem-1');
      expect(pool.getActiveCount(account.id)).toBe(1);
      acquired.release();
      expect(pool.getActiveCount(account.id)).toBe(0);
      expect(upsertSpy).not.toHaveBeenCalled();
    } finally {
      upsertSpy.mockRestore();
      await pool.shutdownAll();
    }
  });

  it('prewarms ready accounts within limits, skips initialize on acquire, and refills in background', async () => {
    let initCalls = 0;
    let newSessionCalls = 0;
    let concurrentStarts = 0;
    let peakConcurrentStarts = 0;

    const mockFactory: AcpTransportFactory = ({ onUpdate }): AcpTransport => {
      let alive = true;
      return {
        initialize: async () => {
          initCalls++;
          concurrentStarts++;
          peakConcurrentStarts = Math.max(peakConcurrentStarts, concurrentStarts);
          await new Promise((r) => setTimeout(r, 15));
          concurrentStarts--;
          return { ok: true };
        },
        newSession: async () => {
          newSessionCalls++;
          return { sessionId: `sess-${newSessionCalls}` };
        },
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            sessionId: `sess-${newSessionCalls}`,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
          });
          return { stopReason: 'end_turn' };
        },
        cancel: async () => {},
        close: async () => {
          alive = false;
        },
        isAlive: () => alive,
      };
    };

    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const pool = new AcpWorkerPool({
      mcpServer,
      cleanupIntervalMs: 60_000,
      prewarmPerAccount: 1,
      maxPrewarmTotal: 2,
      maxConcurrentStarts: 2,
      transportFactory: mockFactory,
    });

    try {
      const acc1 = makeAccount('acc-pw-1');
      const acc2 = makeAccount('acc-pw-2');
      const acc3 = makeAccount('acc-pw-3');
      const accDisabled = { ...makeAccount('acc-pw-cd'), status: 'disabled' as const };

      await pool.ensurePrewarm([acc1, acc2, acc3, accDisabled]);

      // Respects maxPrewarmTotal=2, maxConcurrentStarts=2, and skips non-ready accounts
      expect(pool.getPrewarmCount()).toBe(2);
      expect(pool.getPrewarmCount(accDisabled.id)).toBe(0);
      expect(peakConcurrentStarts).toBeLessThanOrEqual(2);
      expect(initCalls).toBe(2);

      // Acquiring a worker for acc1 consumes its prewarmed transport without re-initializing
      const { worker, release } = pool.acquireWorker(
        acc1,
        'gemini-4-hydrogen',
        makeRequest('ping'),
        'sess-pw-1',
      );
      const res = await worker.executePrompt(makeRequest('ping'));
      expect(res.parts).toEqual([{ text: 'pong' }]);
      expect(res.timings?.coldStart).toBe(true);
      expect(res.timings?.initializeMs).toBeUndefined();
      expect(newSessionCalls).toBe(1);
      release();

      // Wait briefly for background refill of acc1's prewarm slot
      await new Promise((r) => setTimeout(r, 40));
      expect(pool.getPrewarmCount(acc1.id)).toBe(1);
      expect(initCalls).toBe(3);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it('silently cleans up failed prewarm attempts without breaking main flow', async () => {
    const failingFactory: AcpTransportFactory = (): AcpTransport => ({
      initialize: async () => {
        throw new Error('spawn failed');
      },
      newSession: async () => ({ sessionId: 'unused' }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      close: async () => {},
      isAlive: () => false,
    });

    const pool = new AcpWorkerPool({
      mcpServer: new LoopbackMcpServer(),
      cleanupIntervalMs: 60_000,
      prewarmPerAccount: 1,
      maxPrewarmTotal: 4,
      transportFactory: failingFactory,
    });

    try {
      const acc = makeAccount('acc-pw-fail');
      const ok = await pool.prewarmAccount(acc);
      expect(ok).toBe(false);
      expect(pool.getPrewarmCount(acc.id)).toBe(0);
    } finally {
      await pool.shutdownAll();
    }
  });
});
