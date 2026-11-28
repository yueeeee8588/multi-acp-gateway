import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpConnection } from './connection';
import { LoopbackMcpServer, SessionToolBroker } from './loopback-mcp';
import { AcpWorkerPool, DEFAULT_WORKER_IDLE_TTL_MS } from './pool';
import { GatewayStore, store } from '../db/store';
import { createApp } from '../server';
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

describe('8048 drain', () => {
  it('rejects new generation requests and keeps management routes available', async () => {
    const controller = new AbortController();
    const inFlightControllers = new Map([['pending', controller]]);
    const app = createApp({ geminiDeps: { inFlightControllers } });

    const drain = app.drain();
    const [openAi, gemini, status, repeatDrain] = await Promise.all([
      app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST' })),
      app.fetch(new Request('http://localhost/v1beta/models/gemini:generateContent', { method: 'POST' })),
      app.fetch(new Request('http://localhost/api/status')),
      app.fetch(new Request('http://localhost/api/drain', { method: 'POST' })),
    ]);
    expect(openAi.status).toBe(503);
    expect(gemini.status).toBe(503);
    expect(status.status).toBe(200);
    expect(repeatDrain.status).toBe(200);
    expect(await repeatDrain.json()).toEqual({ ok: true, ...await drain });
    expect(controller.signal.aborted).toBe(true);
    expect(await drain).toMatchObject({ drained: true, abortedInFlight: 1 });
    expect((await app.fetch(new Request('http://localhost/v1/messages', { method: 'POST' }))).status).toBe(503);
  });

  it('rejects both worker acquisition overloads once shutdown starts', async () => {
    const mcpServer = new LoopbackMcpServer({ port: 0 });
    const pool = new AcpWorkerPool({
      mcpServer,
      prewarmPerAccount: 0,
      transportFactory: dummyTransportFactory,
    });
    const account = makeAccount('acc-shutdown');
    const request = makeRequest('hello');
    const model = 'gemini-4-hydrogen';
    const shutdown = pool.shutdownAll();
    try {
      expect(() => pool.acquireWorker(account, model, request)).toThrow('ACP worker pool is shutting down');
      await expect(pool.acquireWorker(account, model, request, undefined, { stateless: true }))
        .rejects.toThrow('ACP worker pool is shutting down');
      expect(pool.getActiveCount(account.id)).toBe(0);
    } finally {
      await shutdown;
      mcpServer.stop();
    }
  });

  it('keeps the loopback MCP listener stopped after a late registration', () => {
    const mcpServer = new LoopbackMcpServer({ port: 0 });
    const broker = new SessionToolBroker({ tools: [] });
    expect(mcpServer.port).toBeGreaterThan(0);
    mcpServer.stop();
    try {
      expect(() => mcpServer.registerSession(broker)).toThrow('Loopback MCP server stopped');
      mcpServer.start();
      expect(mcpServer.port).toBe(0);
    } finally {
      mcpServer.stop();
    }
  });
});

describe('ACP stdout reader', () => {
  it('ignores primitive frames and continues after frame and update callback errors', async () => {
    const updates: number[] = [];
    const callbackError = new Error('update callback failed');
    const connection = new AcpConnection({
      binaryPath: '',
      args: [],
      cwd: '',
      env: {},
      onUpdate: ({ index }) => {
        if (index === 0) throw callbackError;
        updates.push(index as number);
      },
    });
    const encoder = new TextEncoder();
    const update = (index: number) => JSON.stringify({ method: 'session/update', params: { index } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'null', 'false', '42', '"text"', update(0),
          '{"id":{"valueOf":null,"toString":null}}', update(1), '',
        ].join('\n')));
        controller.enqueue(encoder.encode(update(2)));
        controller.close();
      },
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await connection['readStdoutLoop'](stream);
      expect(updates).toEqual([1, 2]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('[acp-connection] session/update callback failed:', callbackError);
      expect(warn).toHaveBeenCalledWith('[acp-connection] failed to handle stdout frame:', expect.any(TypeError));
    } finally {
      warn.mockRestore();
    }
  });
});

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

describe('AcpWorkerPool stateless-to-stateful promotion persistence', () => {
  it('keeps unpromoted stateless workers off disk, persists promoted snapshots under stateful + compat keys, and disables/cleans up on invalidation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'acp-pool-promote-'));
    const tempStore = new GatewayStore(join(tempDir, 'test.db'));
    const getSpy = spyOn(store, 'getAcpSession').mockImplementation((k) => tempStore.getAcpSession(k));
    const upsertSpy = spyOn(store, 'upsertAcpSession').mockImplementation((r) => tempStore.upsertAcpSession(r));
    const deleteSpy = spyOn(store, 'deleteAcpSession').mockImplementation((k) => tempStore.deleteAcpSession(k));
    const pruneSpy = spyOn(store, 'pruneAcpSessions').mockImplementation((ttl, now) => tempStore.pruneAcpSessions(ttl, now));

    let sessionSeq = 0;
    const mockFactory: AcpTransportFactory = ({ onUpdate }): AcpTransport => {
      let alive = true;
      let sid = '';
      return {
        initialize: async () => ({ ok: true }),
        newSession: async () => {
          sid = `sess-promote-${++sessionSeq}`;
          return { sessionId: sid };
        },
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
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
      agyPath: process.execPath,
      cleanupIntervalMs: 60_000,
      prewarmPerAccount: 0,
      transportFactory: mockFactory,
    });

    try {
      const account = makeAccount('acc-promote');
      const model = 'gemini-4-hydrogen';
      const sessionKey = 'shared-sess';
      const stickyKey = `${account.id}:${sessionKey}`;
      const compatLegacyKey = `${account.id}:${model}:${sessionKey}`;

      // 1. Unpromoted stateless turn must NOT persist to store
      const req1 = makeRequest('hello');
      const statelessLease = await pool.acquireWorker(account, model, req1, sessionKey, { stateless: true });
      const res1 = await statelessLease.worker.executePrompt(req1);
      expect(res1.parts).toEqual([{ text: 'ok' }]);
      statelessLease.release();
      expect(tempStore.getAcpSession(stickyKey)).toBeNull();
      expect(tempStore.getAcpSession(compatLegacyKey)).toBeNull();

      // 2. Stateful request reuses & promotes the idle compatible stateless worker
      const req2: GeminiGenerateRequest = {
        contents: [
          { role: 'user', parts: [{ text: 'hello' }] },
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'follow up' }] },
        ],
      };
      const statefulLease = pool.acquireWorker(account, model, req2, sessionKey);
      expect(statefulLease.worker).toBe(statelessLease.worker);
      const res2 = await statefulLease.worker.executePrompt(req2);
      expect(res2.parts).toEqual([{ text: 'ok' }]);
      statefulLease.release();

      // Promoted worker must persist under stateful stickyKey and compatLegacyKey
      const savedPrimary = tempStore.getAcpSession(stickyKey);
      const savedCompat = tempStore.getAcpSession(compatLegacyKey);
      expect(savedPrimary).not.toBeNull();
      expect(savedPrimary?.sessionId).toBe('sess-promote-1');
      expect(savedPrimary?.committedCount).toBe(3);
      expect(savedCompat).not.toBeNull();
      expect(savedCompat?.sessionId).toBe('sess-promote-1');

      // 3. Invalidation callback (null) cleans up both stickyKey and compatLegacyKey
      const workerBoundary = statefulLease.worker as unknown as {
        onSessionStateChange?: (snapshot: unknown) => void;
      };
      workerBoundary.onSessionStateChange?.(null);
      expect(tempStore.getAcpSession(stickyKey)).toBeNull();
      expect(tempStore.getAcpSession(compatLegacyKey)).toBeNull();

      // 4. Eviction/cleanup disables persistence callback so late snapshots do not write back
      const res3 = await statefulLease.worker.executePrompt({
        contents: [
          ...req2.contents!,
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'third turn' }] },
        ],
      });
      expect(res3.parts).toEqual([{ text: 'ok' }]);
      expect(tempStore.getAcpSession(stickyKey)).not.toBeNull();

      await pool.evictAccountWorkers(account.id);
      tempStore.deleteAcpSession(stickyKey);
      tempStore.deleteAcpSession(compatLegacyKey);
      workerBoundary.onSessionStateChange?.({
        stickyKey,
        sessionId: 'sess-promote-1',
        accountId: account.id,
        model,
        systemHash: 's',
        toolsHash: 't',
        sensitiveFilterFingerprint: '',
        committedHashes: [],
        committedNormalized: [],
        committedSummaries: [],
        midTurn: false,
        committedCount: 0,
        midTurnMeta: null,
        updatedAt: Date.now(),
      });
      expect(tempStore.getAcpSession(stickyKey)).toBeNull();
      expect(tempStore.getAcpSession(compatLegacyKey)).toBeNull();
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
      getSpy.mockRestore();
      upsertSpy.mockRestore();
      deleteSpy.mockRestore();
      pruneSpy.mockRestore();
      tempStore.db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('AcpWorkerPool legacy key cleanup on non-reused acquireLease', () => {
  it('disables persistence, deletes, and retires an idle non-reused legacy-key entry while preserving busy entries', async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: process.execPath,
      cleanupIntervalMs: 60_000,
      prewarmPerAccount: 0,
      transportFactory: dummyTransportFactory,
    });

    try {
      const account = makeAccount('acc-legacy-clean');
      const model = 'gemini-4-hydrogen';
      const internalPool = pool as unknown as {
        entries: Map<
          string,
          {
            accountId: string;
            model: string;
            homeDir: string;
            proxyUrl?: string;
            stateless: boolean;
            persistence?: { stickyKey: string; enabled: boolean; currentMirroredLegacyKey: string | null };
            worker: { canReuse: () => boolean; resetAndClose: () => Promise<void> };
            inUse: boolean;
          }
        >;
      };

      // 1. Idle non-reused legacy-key entry must be disabled, deleted, and retired
      const idleSessionKey = 'legacy-idle';
      const idlePrimaryKey = JSON.stringify([false, `${account.id}:${idleSessionKey}`]);
      const idleLegacyKey = JSON.stringify([false, `${account.id}:${model}:${idleSessionKey}`]);
      const lease1 = pool.acquireWorker(account, model, makeRequest('one'), idleSessionKey);
      const idleEntry = internalPool.entries.get(idlePrimaryKey)!;
      expect(idleEntry).toBeDefined();
      idleEntry.worker.canReuse = () => false;
      const idleCloseSpy = spyOn(lease1.worker, 'resetAndClose').mockImplementation(async () => {});
      lease1.release();
      internalPool.entries.delete(idlePrimaryKey);
      internalPool.entries.set(idleLegacyKey, idleEntry);

      const lease2 = pool.acquireWorker(account, model, makeRequest('two'), idleSessionKey);
      await Promise.resolve();
      expect(lease2.worker).not.toBe(lease1.worker);
      expect(idleEntry.persistence?.enabled).toBe(false);
      expect(internalPool.entries.has(idleLegacyKey)).toBe(false);
      expect(idleCloseSpy).toHaveBeenCalledTimes(1);
      lease2.release();

      // 2. Busy legacy-key entry must NOT be disabled, deleted, or retired
      const busySessionKey = 'legacy-busy';
      const busyPrimaryKey = JSON.stringify([false, `${account.id}:${busySessionKey}`]);
      const busyLegacyKey = JSON.stringify([false, `${account.id}:${model}:${busySessionKey}`]);
      const lease3 = pool.acquireWorker(account, model, makeRequest('three'), busySessionKey);
      const busyEntry = internalPool.entries.get(busyPrimaryKey)!;
      expect(busyEntry).toBeDefined();
      expect(busyEntry.inUse).toBe(true);
      const busyCloseSpy = spyOn(lease3.worker, 'resetAndClose').mockImplementation(async () => {});
      internalPool.entries.delete(busyPrimaryKey);
      internalPool.entries.set(busyLegacyKey, busyEntry);

      const lease4 = pool.acquireWorker(account, model, makeRequest('four'), busySessionKey);
      await Promise.resolve();
      expect(lease4.worker).not.toBe(lease3.worker);
      expect(busyEntry.persistence?.enabled).toBe(true);
      expect(internalPool.entries.has(busyLegacyKey)).toBe(true);
      expect(busyCloseSpy).not.toHaveBeenCalled();

      lease4.release();
      lease3.release();
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });
});
