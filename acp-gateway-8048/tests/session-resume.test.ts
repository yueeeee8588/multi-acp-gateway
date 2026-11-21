import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import { AcpWorkerPool } from '../src/acp/pool';
import { computeSensitiveFilterFingerprint } from '../src/acp/sensitive-filter';
import type { AcpTransport, AcpTransportFactory } from '../src/acp/worker';
import { getConfig, updateConfig } from '../src/config/settings';
import { DEFAULT_ACP_SESSION_TTL_MS, GatewayStore, store } from '../src/db/store';
import type { AccountRecord, GeminiGenerateRequest } from '../src/types';

function makeAccount(id = 'acc-resume-1'): AccountRecord {
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

interface RecordedCalls {
  newSessionParams: Array<Record<string, unknown>>;
  resumeSessionParams: Array<Record<string, unknown>>;
  setModelParams: Array<{ sessionId: string; modelId: string }>;
  promptParams: Array<Record<string, unknown>>;
}

function createMockTransportFactory(opts: {
  sessionId?: string;
  resumeSupported?: boolean;
  resumeShouldThrow?: boolean;
  calls: RecordedCalls;
}): AcpTransportFactory {
  let seq = 0;
  return ({ onUpdate }) => {
    let alive = true;
    const transport: AcpTransport = {
      async initialize() {
        return {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: opts.resumeSupported ?? true },
          systemPromptAppend: '',
          raw: {
            agentCapabilities: {
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
          },
        };
      },
      async newSession(params) {
        opts.calls.newSessionParams.push(params);
        seq += 1;
        return { sessionId: opts.sessionId ?? `new-sess-${seq}` };
      },
      async resumeSession(params) {
        opts.calls.resumeSessionParams.push(params);
        if (opts.resumeShouldThrow) {
          throw new Error('JSON-RPC -32002: session not found');
        }
        return { sessionId: params.sessionId };
      },
      async setModel(params) {
        opts.calls.setModelParams.push(params);
        return {};
      },
      async prompt(params) {
        opts.calls.promptParams.push(params);
        onUpdate({
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ok' },
          },
        });
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async close() {
        alive = false;
      },
      isAlive() {
        return alive;
      },
    };
    return transport;
  };
}

const cleanupKeys: string[] = [];

afterEach(() => {
  for (const key of cleanupKeys.splice(0)) {
    store.deleteAcpSession(key);
  }
});

describe('cross-restart session/resume persistence', () => {
  it('resumes persisted session across pool restart and sends only delta', async () => {
    const account = makeAccount('acc-resume-hit');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-resume-hit-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    const calls1: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };

    const mcpServer1 = new LoopbackMcpServer();
    await mcpServer1.start();
    const pool1 = new AcpWorkerPool({
      mcpServer: mcpServer1,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'persisted-sid-100',
        resumeSupported: true,
        calls: calls1,
      }),
    });

    const reqTurn1: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: 'Be concise.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Turn 1 hello' }] }],
    };

    try {
      const { worker, release } = pool1.acquireWorker(account, model, reqTurn1, sessionKey);
      const res1 = await worker.executePrompt(reqTurn1);
      release();

      expect(res1.cacheHit).toBeUndefined();
      expect(calls1.newSessionParams).toHaveLength(1);
      expect(calls1.resumeSessionParams).toHaveLength(0);
      expect(calls1.promptParams).toHaveLength(1);
    } finally {
      await pool1.shutdownAll();
      await mcpServer1.stop();
    }

    // Verify snapshot was persisted in SQLite
    const saved = store.getAcpSession(stickyKey);
    expect(saved).not.toBeNull();
    expect(saved?.sessionId).toBe('persisted-sid-100');
    expect(saved?.committedHashes).toHaveLength(1);

    // Simulate process restart with a brand new pool & mcpServer
    const calls2: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer2 = new LoopbackMcpServer();
    await mcpServer2.start();
    const pool2 = new AcpWorkerPool({
      mcpServer: mcpServer2,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        resumeSupported: true,
        calls: calls2,
      }),
    });

    const reqTurn2: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: 'Be concise.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Turn 1 hello' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'Turn 2 delta only' }] },
      ],
    };

    try {
      const { worker, release } = pool2.acquireWorker(account, model, reqTurn2, sessionKey);
      const res2 = await worker.executePrompt(reqTurn2);
      release();

      expect(res2.cacheHit).toBeUndefined();
      expect(calls2.resumeSessionParams).toHaveLength(1);
      expect(calls2.newSessionParams).toHaveLength(0);
      expect(calls2.resumeSessionParams[0]?.sessionId).toBe('persisted-sid-100');
      expect(calls2.resumeSessionParams[0]?._meta).toEqual({
        antigravity: { systemPrompt: { append: 'Be concise.' } },
      });
      // Must force setModel after resume
      expect(calls2.setModelParams).toEqual([{ sessionId: 'persisted-sid-100', modelId: model }]);

      // Only the delta (turn 2 model + turn 3 user) should be sent, NOT turn 1
      const sentBlocks = calls2.promptParams[0]?.prompt as Array<{ text?: string }>;
      const joined = sentBlocks.map((b) => b.text ?? '').join('\n');
      expect(joined).toContain('Turn 2 delta only');
      expect(joined).not.toContain('Turn 1 hello');
    } finally {
      await pool2.shutdownAll();
      await mcpServer2.stop();
    }
  });

  it('falls back to newSession and clears persisted record when prefix diverges', async () => {
    const account = makeAccount('acc-resume-diverge');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-resume-diverge-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    const calls1: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer1 = new LoopbackMcpServer();
    await mcpServer1.start();
    const pool1 = new AcpWorkerPool({
      mcpServer: mcpServer1,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'persisted-sid-diverge',
        resumeSupported: true,
        calls: calls1,
      }),
    });

    const req1: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'Original turn 1' }] }],
    };

    try {
      const { worker, release } = pool1.acquireWorker(account, model, req1, sessionKey);
      await worker.executePrompt(req1);
      release();
    } finally {
      await pool1.shutdownAll();
      await mcpServer1.stop();
    }

    // Restart with diverged prefix
    const calls2: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer2 = new LoopbackMcpServer();
    await mcpServer2.start();
    const pool2 = new AcpWorkerPool({
      mcpServer: mcpServer2,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'fresh-sid-after-diverge',
        resumeSupported: true,
        calls: calls2,
      }),
    });

    const reqDiverged: GeminiGenerateRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Edited turn 1' }] },
        { role: 'user', parts: [{ text: 'Turn 2' }] },
      ],
    };

    try {
      const { worker, release } = pool2.acquireWorker(account, model, reqDiverged, sessionKey);
      const res2 = await worker.executePrompt(reqDiverged);
      release();

      expect(res2.cacheHit).toBeUndefined();
      expect(calls2.resumeSessionParams).toHaveLength(0);
      expect(calls2.newSessionParams).toHaveLength(1);

      const sentBlocks = calls2.promptParams[0]?.prompt as Array<{ text?: string }>;
      const joined = sentBlocks.map((b) => b.text ?? '').join('\n');
      expect(joined).toContain('Edited turn 1');
      expect(joined).toContain('Turn 2');

      // Persisted record should now point to the new session
      const updated = store.getAcpSession(stickyKey);
      expect(updated?.sessionId).toBe('fresh-sid-after-diverge');
    } finally {
      await pool2.shutdownAll();
      await mcpServer2.stop();
    }
  });

  it('auto-downgrades to newSession when resumeSession throws', async () => {
    const account = makeAccount('acc-resume-err');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-resume-err-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    // Pre-populate persisted session
    const req1: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'First message' }] }],
    };
    const calls1: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer1 = new LoopbackMcpServer();
    await mcpServer1.start();
    const pool1 = new AcpWorkerPool({
      mcpServer: mcpServer1,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'dead-sid-999',
        resumeSupported: true,
        calls: calls1,
      }),
    });
    try {
      const { worker, release } = pool1.acquireWorker(account, model, req1, sessionKey);
      await worker.executePrompt(req1);
      release();
    } finally {
      await pool1.shutdownAll();
      await mcpServer1.stop();
    }

    // Restart where resumeSession throws
    const calls2: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer2 = new LoopbackMcpServer();
    await mcpServer2.start();
    const pool2 = new AcpWorkerPool({
      mcpServer: mcpServer2,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'recovered-new-sid',
        resumeSupported: true,
        resumeShouldThrow: true,
        calls: calls2,
      }),
    });

    const req2: GeminiGenerateRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'First message' }] },
        { role: 'user', parts: [{ text: 'Second message' }] },
      ],
    };

    try {
      const { worker, release } = pool2.acquireWorker(account, model, req2, sessionKey);
      const res2 = await worker.executePrompt(req2);
      release();

      expect(res2.cacheHit).toBeUndefined();
      expect(calls2.resumeSessionParams).toHaveLength(1);
      expect(calls2.newSessionParams).toHaveLength(1);

      const sentBlocks = calls2.promptParams[0]?.prompt as Array<{ text?: string }>;
      const joined = sentBlocks.map((b) => b.text ?? '').join('\n');
      expect(joined).toContain('First message');
      expect(joined).toContain('Second message');

      const updated = store.getAcpSession(stickyKey);
      expect(updated?.sessionId).toBe('recovered-new-sid');
    } finally {
      await pool2.shutdownAll();
      await mcpServer2.stop();
    }
  });

  it('expires persisted sessions after 6h TTL and prunes stale records', () => {
    const localStore = new GatewayStore(':memory:');
    try {
      const now = 1_700_000_000_000;
      const ttl = DEFAULT_ACP_SESSION_TTL_MS;
      expect(ttl).toBe(6 * 60 * 60 * 1000);

      localStore.upsertAcpSession({
        stickyKey: 'acc:model:fresh',
        sessionId: 'sid-fresh',
        accountId: 'acc',
        model: 'model',
        systemHash: 'sys',
        toolsHash: 'tools',
        committedHashes: ['h1'],
        updatedAt: now - ttl + 1000,
      });

      localStore.upsertAcpSession({
        stickyKey: 'acc:model:expired',
        sessionId: 'sid-expired',
        accountId: 'acc',
        model: 'model',
        systemHash: 'sys',
        toolsHash: 'tools',
        committedHashes: ['h1'],
        updatedAt: now - ttl - 1,
      });

      // Fresh is returned, expired returns null and is deleted
      expect(localStore.getAcpSession('acc:model:fresh', now)?.sessionId).toBe('sid-fresh');
      expect(localStore.getAcpSession('acc:model:expired', now)).toBeNull();

      // Re-insert expired and verify pruneAcpSessions removes only expired
      localStore.upsertAcpSession({
        stickyKey: 'acc:model:expired-2',
        sessionId: 'sid-expired-2',
        accountId: 'acc',
        model: 'model',
        systemHash: 'sys',
        toolsHash: 'tools',
        committedHashes: ['h1'],
        updatedAt: now - ttl - 5000,
      });

      const pruned = localStore.pruneAcpSessions(ttl, now);
      expect(pruned).toBe(1);
      expect(localStore.getAcpSession('acc:model:fresh', now)?.sessionId).toBe('sid-fresh');
      expect(localStore.getAcpSession('acc:model:expired-2', now)).toBeNull();
    } finally {
      localStore.close();
    }
  });

  it('treats corrupted committed_hashes_json as invalid, deletes row, and falls back to newSession', async () => {
    const localStore = new GatewayStore(':memory:');
    const warnCalls: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
    };

    try {
      const now = Date.now();
      const rawDb = (
        localStore as unknown as {
          db: { query: (sql: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => unknown } };
        }
      ).db;

      const cases = [
        { key: 'acc:m:bad-json', raw: '{not-valid-json' },
        { key: 'acc:m:not-array', raw: '{"a":1}' },
        { key: 'acc:m:non-string', raw: '["valid", 123]' },
      ];

      for (const c of cases) {
        localStore.upsertAcpSession({
          stickyKey: c.key,
          sessionId: 'sid-x',
          accountId: 'acc',
          model: 'm',
          systemHash: 'sys',
          toolsHash: 'tools',
          committedHashes: ['h1'],
          updatedAt: now,
        });
        rawDb.query('UPDATE acp_sessions SET committed_hashes_json = ? WHERE sticky_key = ?').run(c.raw, c.key);

        expect(localStore.getAcpSession(c.key, now)).toBeNull();
        // Corrupted row must have been deleted from SQLite
        const rowAfter = rawDb.query('SELECT sticky_key FROM acp_sessions WHERE sticky_key = ?').get(c.key);
        expect(rowAfter).toBeNull();
      }
      expect(warnCalls.length).toBeGreaterThanOrEqual(3);
    } finally {
      console.warn = origWarn;
      localStore.close();
    }

    // Also verify end-to-end pool + worker fallback to newSession on corrupted global store row
    const account = makeAccount('acc-corrupt-e2e');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-corrupt-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    store.upsertAcpSession({
      stickyKey,
      sessionId: 'corrupted-sid',
      accountId: account.id,
      model,
      systemHash: 'sys',
      toolsHash: 'tools',
      committedHashes: ['h1'],
      updatedAt: Date.now(),
    });
    const globalRawDb = (
      store as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db;
    globalRawDb
      .query('UPDATE acp_sessions SET committed_hashes_json = ? WHERE sticky_key = ?')
      .run('{broken-json', stickyKey);

    const calls: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const pool = new AcpWorkerPool({
      mcpServer,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'fresh-sid-after-corrupt',
        resumeSupported: true,
        calls,
      }),
    });

    const req: GeminiGenerateRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Turn 1' }] },
        { role: 'user', parts: [{ text: 'Turn 2' }] },
      ],
    };

    const origWarn2 = console.warn;
    console.warn = () => {};
    try {
      const { worker, release } = pool.acquireWorker(account, model, req, sessionKey);
      const res = await worker.executePrompt(req);
      release();

      expect(res.cacheHit).toBeUndefined();
      expect(calls.resumeSessionParams).toHaveLength(0);
      expect(calls.newSessionParams).toHaveLength(1);
      expect(store.getAcpSession(stickyKey)?.sessionId).toBe('fresh-sid-after-corrupt');
    } finally {
      console.warn = origWarn2;
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it('prevents concurrent worker copies from reading or overwriting primary stickyKey snapshot', async () => {
    const account = makeAccount('acc-concurrent-copy');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-concurrent-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    // Pre-seed primary persisted snapshot
    store.upsertAcpSession({
      stickyKey,
      sessionId: 'primary-persisted-sid',
      accountId: account.id,
      model,
      systemHash: 'sys-hash',
      toolsHash: 'tools-hash',
      committedHashes: ['existing-hash-1'],
      updatedAt: Date.now(),
    });

    const calls: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const pool = new AcpWorkerPool({
      mcpServer,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'concurrent-copy-sid',
        resumeSupported: true,
        calls,
      }),
    });

    const req: GeminiGenerateRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'Turn 1' }] },
        { role: 'user', parts: [{ text: 'Turn 2' }] },
      ],
    };

    try {
      // Acquire primary worker and keep it busy (inUse = true)
      const primary = pool.acquireWorker(account, model, req, sessionKey);

      // Acquire concurrent copy while primary is busy -> entryKey !== stickyKey
      const concurrent = pool.acquireWorker(account, model, req, sessionKey);
      const resCopy = await concurrent.worker.executePrompt(req);
      concurrent.release();

      // Concurrent copy must NOT resume primary's persisted session
      expect(resCopy.cacheHit).toBeUndefined();
      expect(calls.resumeSessionParams).toHaveLength(0);
      expect(calls.newSessionParams).toHaveLength(1);

      // Primary's persisted snapshot in SQLite must remain untouched
      const persistedAfterCopy = store.getAcpSession(stickyKey);
      expect(persistedAfterCopy?.sessionId).toBe('primary-persisted-sid');
      expect(persistedAfterCopy?.committedHashes).toEqual(['existing-hash-1']);

      primary.release();
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it('stores zero plaintext in any acp_sessions column', async () => {
    const account = makeAccount('acc-zero-plaintext');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-zero-pt-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    const secretSystem = 'SECRET_SYSTEM_PROMPT_9981';
    const secretTool = 'secret_tool_lookup_9981';
    const secretUser = 'SECRET_USER_MESSAGE_9981';

    const calls: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const pool = new AcpWorkerPool({
      mcpServer,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-zero-pt-1',
        resumeSupported: true,
        calls,
      }),
    });

    const req: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: secretSystem }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: secretTool,
              description: 'Confidential tool description 9981',
              parameters: { type: 'OBJECT', properties: {} },
            },
          ],
        },
      ],
      contents: [{ role: 'user', parts: [{ text: secretUser }] }],
    };

    try {
      const { worker, release } = pool.acquireWorker(account, model, req, sessionKey);
      await worker.executePrompt(req);
      release();
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }

    const rawDb = (
      store as unknown as {
        db: { query: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | null } };
      }
    ).db;
    const rawRow = rawDb
      .query('SELECT * FROM acp_sessions WHERE sticky_key = ?')
      .get(stickyKey);
    expect(rawRow).not.toBeNull();

    const serializedRow = JSON.stringify(rawRow);
    expect(serializedRow).not.toContain(secretSystem);
    expect(serializedRow).not.toContain(secretTool);
    expect(serializedRow).not.toContain('Confidential tool description 9981');
    expect(serializedRow).not.toContain(secretUser);
    expect(String(rawRow?.system_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(rawRow?.tools_hash)).toMatch(/^[a-f0-9]{64}$/);
    const hashes = JSON.parse(String(rawRow?.committed_hashes_json)) as string[];
    expect(hashes).toHaveLength(1);
    for (const h of hashes) {
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('persists sensitiveFilterFingerprint across restart, sets timings.sessionResumed=true, and sends only delta', async () => {
    const prevConfig = getConfig();
    const rules = [
      {
        pattern: 'forbidden-token',
        replace: '[REDACTED]',
        enabled: true,
        case_insensitive: false,
        scope: 'all' as const,
      },
    ];
    updateConfig({
      sensitiveFilterEnabled: true,
      sensitiveWords: rules,
    });
    const expectedFingerprint = computeSensitiveFilterFingerprint({
      sensitiveFilterEnabled: true,
      sensitiveWords: rules,
    });
    expect(expectedFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const account = makeAccount('acc-sensitive-resume');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-sensitive-resume-1';
    const stickyKey = `${account.id}:${model}:${sessionKey}`;
    cleanupKeys.push(stickyKey);

    try {
      const calls1: RecordedCalls = {
        newSessionParams: [],
        resumeSessionParams: [],
        setModelParams: [],
        promptParams: [],
      };
      const mcpServer1 = new LoopbackMcpServer();
      await mcpServer1.start();
      const pool1 = new AcpWorkerPool({
        mcpServer: mcpServer1,
        cleanupIntervalMs: 60_000,
        transportFactory: createMockTransportFactory({
          sessionId: 'sensitive-sid-100',
          resumeSupported: true,
          calls: calls1,
        }),
      });

      const reqTurn1: GeminiGenerateRequest = {
        systemInstruction: { parts: [{ text: 'System with forbidden-token' }] },
        contents: [{ role: 'user', parts: [{ text: 'Turn 1 forbidden-token' }] }],
      };

      try {
        const { worker, release } = pool1.acquireWorker(account, model, reqTurn1, sessionKey);
        const res1 = await worker.executePrompt(reqTurn1);
        release();
        expect(res1.timings?.sessionResumed).toBe(false);
      } finally {
        await pool1.shutdownAll();
        await mcpServer1.stop();
      }

      const saved = store.getAcpSession(stickyKey);
      expect(saved).not.toBeNull();
      expect(saved?.sensitiveFilterFingerprint).toBe(expectedFingerprint);

      // Restart with same sensitive filter config -> must resume with timings.sessionResumed === true
      const calls2: RecordedCalls = {
        newSessionParams: [],
        resumeSessionParams: [],
        setModelParams: [],
        promptParams: [],
      };
      const mcpServer2 = new LoopbackMcpServer();
      await mcpServer2.start();
      const pool2 = new AcpWorkerPool({
        mcpServer: mcpServer2,
        cleanupIntervalMs: 60_000,
        transportFactory: createMockTransportFactory({
          resumeSupported: true,
          calls: calls2,
        }),
      });

      const reqTurn2: GeminiGenerateRequest = {
        systemInstruction: { parts: [{ text: 'System with forbidden-token' }] },
        contents: [
          { role: 'user', parts: [{ text: 'Turn 1 forbidden-token' }] },
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'Turn 2 forbidden-token delta' }] },
        ],
      };

      try {
        const { worker, release } = pool2.acquireWorker(account, model, reqTurn2, sessionKey);
        const res2 = await worker.executePrompt(reqTurn2);
        release();

        expect(res2.timings?.sessionResumed).toBe(true);
        expect(calls2.resumeSessionParams).toHaveLength(1);
        expect(calls2.newSessionParams).toHaveLength(0);
        expect(calls2.resumeSessionParams[0]?.sessionId).toBe('sensitive-sid-100');

        const sentBlocks = calls2.promptParams[0]?.prompt as Array<{ text?: string }>;
        const joined = sentBlocks.map((b) => b.text ?? '').join('\n');
        expect(joined).toContain('Turn 2 [REDACTED] delta');
        expect(joined).not.toContain('Turn 1');
        expect(joined).not.toContain('forbidden-token');
      } finally {
        await pool2.shutdownAll();
        await mcpServer2.stop();
      }
    } finally {
      updateConfig({
        sensitiveFilterEnabled: prevConfig.sensitiveFilterEnabled,
        sensitiveWords: prevConfig.sensitiveWords,
      });
    }
  });

  it('prunes expired acp_sessions on AcpWorkerPool init and migrates legacy schema idempotently', async () => {
    const expiredKey = 'acc-pool-init-prune:gemini-4-hydrogen:sess-expired';
    const freshKey = 'acc-pool-init-prune:gemini-4-hydrogen:sess-fresh';
    cleanupKeys.push(expiredKey, freshKey);

    const now = Date.now();
    store.upsertAcpSession({
      stickyKey: expiredKey,
      sessionId: 'expired-sid',
      accountId: 'acc-pool-init-prune',
      model: 'gemini-4-hydrogen',
      systemHash: 'sys',
      toolsHash: 'tools',
      sensitiveFilterFingerprint: 'fp-1',
      committedHashes: ['h1'],
      updatedAt: now - DEFAULT_ACP_SESSION_TTL_MS - 10_000,
    });
    store.upsertAcpSession({
      stickyKey: freshKey,
      sessionId: 'fresh-sid',
      accountId: 'acc-pool-init-prune',
      model: 'gemini-4-hydrogen',
      systemHash: 'sys',
      toolsHash: 'tools',
      sensitiveFilterFingerprint: 'fp-1',
      committedHashes: ['h1'],
      updatedAt: now,
    });

    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const pool = new AcpWorkerPool({
      mcpServer,
      cleanupIntervalMs: 60_000,
    });

    try {
      expect(store.getAcpSession(expiredKey, now)).toBeNull();
      const fresh = store.getAcpSession(freshKey, now);
      expect(fresh?.sessionId).toBe('fresh-sid');
      expect(fresh?.sensitiveFilterFingerprint).toBe('fp-1');
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }

    // Verify idempotent ALTER TABLE migration on a legacy DB missing sensitive_filter_fingerprint
    const tempDir = mkdtempSync(join(tmpdir(), 'acp-legacy-db-'));
    const dbPath = join(tempDir, 'legacy.db');
    try {
      const legacyDb = new Database(dbPath, { create: true });
      legacyDb.exec(`
        CREATE TABLE acp_sessions (
          sticky_key TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          model TEXT NOT NULL,
          system_hash TEXT NOT NULL,
          tools_hash TEXT NOT NULL,
          committed_hashes_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      legacyDb
        .query(
          `INSERT INTO acp_sessions (
            sticky_key, session_id, account_id, model, system_hash, tools_hash, committed_hashes_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('legacy-key', 'legacy-sid', 'acc-1', 'gemini-4-hydrogen', 'sys', 'tools', '["h1"]', now);
      legacyDb.close();

      const migratedStore = new GatewayStore(dbPath);
      const migrated = migratedStore.getAcpSession('legacy-key', now);
      expect(migrated).not.toBeNull();
      expect(migrated?.sessionId).toBe('legacy-sid');
      expect(migrated?.sensitiveFilterFingerprint).toBe('');
      migratedStore.close();

      // Re-opening must remain idempotent
      const reopenedStore = new GatewayStore(dbPath);
      expect(reopenedStore.getAcpSession('legacy-key', now)?.sensitiveFilterFingerprint).toBe('');
      reopenedStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
