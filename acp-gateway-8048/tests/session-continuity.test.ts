import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import { AcpWorkerPool, computeSessionPrefixHash } from '../src/acp/pool';
import type { AcpTransport, AcpTransportFactory } from '../src/acp/worker';
import { GatewayStore, store } from '../src/db/store';
import { computeSessionHash } from '../src/gemini/protocol';
import type { AccountRecord, GeminiGenerateRequest } from '../src/types';

function makeAccount(id = 'acc-cont-1'): AccountRecord {
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
  setModelShouldThrowOn?: string;
  onPrompt?: (
    params: Record<string, unknown>,
    ctx: {
      onUpdate: (params: Record<string, unknown>) => void;
      mcpUrl?: string;
      promptIndex: number;
    },
  ) => Promise<Record<string, unknown>>;
  calls: RecordedCalls;
}): AcpTransportFactory {
  let seq = 0;
  let promptIdx = 0;
  return ({ onUpdate }) => {
    let alive = true;
    let mcpUrl: string | undefined;
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
        const servers = params.mcpServers as Array<{ url?: string }> | undefined;
        mcpUrl = servers?.[0]?.url;
        seq += 1;
        return { sessionId: opts.sessionId ?? `new-sess-${seq}` };
      },
      async resumeSession(params) {
        opts.calls.resumeSessionParams.push(params);
        const servers = params.mcpServers as Array<{ url?: string }> | undefined;
        mcpUrl = servers?.[0]?.url;
        if (opts.resumeShouldThrow) {
          throw new Error('JSON-RPC -32002: session not found');
        }
        return { sessionId: params.sessionId };
      },
      async setModel(params) {
        opts.calls.setModelParams.push(params);
        if (opts.setModelShouldThrowOn && params.modelId === opts.setModelShouldThrowOn) {
          throw new Error(`Model ${params.modelId} unavailable`);
        }
        return {};
      },
      async prompt(params) {
        opts.calls.promptParams.push(params);
        promptIdx += 1;
        if (opts.onPrompt) {
          return opts.onPrompt(params, { onUpdate, mcpUrl, promptIndex: promptIdx });
        }
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

describe('wp-session-core continuity (P0-1, P0-2, P1-1)', () => {
  it('P0-1: decouples stickyKey/prefixHash from model, hot-switches via set_model, and falls back on set_model failure', async () => {
    const account = makeAccount('acc-p01-hotswitch');
    const modelA = 'gemini-4-hydrogen-medium';
    const modelB = 'gemini-4-neon-high';

    const reqTurn1: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: 'Be helpful.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hello turn 1' }] },
        { role: 'model', parts: [{ text: 'Hi there' }] },
        { role: 'user', parts: [{ text: 'Continue' }] },
      ],
    };
    const reqTurn2: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: 'Be helpful.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hello turn 1' }] },
        { role: 'model', parts: [{ text: 'Hi there' }] },
        { role: 'user', parts: [{ text: 'Continue' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'Switch to modelB' }] },
      ],
    };

    const prefixHash = computeSessionPrefixHash(reqTurn1.contents);
    expect(prefixHash).toBe(computeSessionPrefixHash(reqTurn2.contents));
    cleanupKeys.push(
      `${account.id}:${prefixHash}`,
      `${account.id}:${modelA}:${prefixHash}`,
      `${account.id}:${modelB}:${prefixHash}`,
    );

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
        sessionId: 'sid-hotswitch-1',
        calls,
      }),
    });

    try {
      const w1 = pool.acquireWorker(account, modelA, reqTurn1);
      await w1.worker.executePrompt(reqTurn1);
      w1.release();

      // Switch model without sessionKey: hits same worker via decoupled prefixHash & stickyKey
      const w2 = pool.acquireWorker(account, modelB, reqTurn2);
      expect(w2.worker).toBe(w1.worker);
      await w2.worker.executePrompt(reqTurn2);
      w2.release();

      expect(calls.newSessionParams).toHaveLength(1);
      expect(calls.setModelParams.some((m) => m.modelId === modelB)).toBe(true);
      const turn2Prompt = JSON.stringify(calls.promptParams[1]?.prompt);
      expect(turn2Prompt).toContain('Switch to modelB');
      expect(turn2Prompt).not.toContain('Hello turn 1');
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }

    // Fail-Fast fallback when set_model throws on hot-switch
    const callsFail: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcpServer2 = new LoopbackMcpServer();
    await mcpServer2.start();
    const failSessionKey = 'sess-hotswitch-fail';
    cleanupKeys.push(
      `${account.id}:${failSessionKey}`,
      `${account.id}:${modelA}:${failSessionKey}`,
      `${account.id}:gemini-4-argon:${failSessionKey}`,
    );

    let throwCount = 0;
    const pool2 = new AcpWorkerPool({
      mcpServer: mcpServer2,
      cleanupIntervalMs: 60_000,
      transportFactory: ({ onUpdate }) => {
        let alive = true;
        let seq = 0;
        return {
          async initialize() {
            return { sessionCapabilities: { resume: true } };
          },
          async newSession(params) {
            callsFail.newSessionParams.push(params);
            seq += 1;
            return { sessionId: `sid-fallback-${seq}` };
          },
          async setModel(params) {
            callsFail.setModelParams.push(params);
            // Fail on the first hot-switch attempt for gemini-4-argon, succeed on cold rebuild
            if (params.modelId === 'gemini-4-argon' && throwCount === 0) {
              throwCount += 1;
              throw new Error('hot-switch rejected');
            }
            return {};
          },
          async prompt(params) {
            callsFail.promptParams.push(params);
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
      },
    });

    try {
      const a1 = pool2.acquireWorker(account, modelA, reqTurn1, failSessionKey);
      await a1.worker.executePrompt(reqTurn1);
      a1.release();

      const a2 = pool2.acquireWorker(account, 'gemini-4-argon', reqTurn2, failSessionKey);
      await a2.worker.executePrompt(reqTurn2);
      a2.release();

      // Hot-switch failed -> resetAndClose -> coldStart created a second session & replayed full history
      expect(callsFail.newSessionParams).toHaveLength(2);
      const replayPrompt = JSON.stringify(callsFail.promptParams[1]?.prompt);
      expect(replayPrompt).toContain('Hello turn 1');
      expect(replayPrompt).toContain('Switch to modelB');
    } finally {
      await pool2.shutdownAll();
      await mcpServer2.stop();
    }
  });

  it('P0-1: stabilizes systemHash across volatile lines while sending unstripped systemInstruction to agy', async () => {
    const account = makeAccount('acc-p01-volatile');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-volatile-1';
    cleanupKeys.push(
      `${account.id}:${sessionKey}`,
      `${account.id}:${model}:${sessionKey}`,
    );

    const sysTurn1 = [
      'x-anthropic-billing-header: cc_version=1.0; cost=0.01',
      'Current date: 2026-11-26',
      'You are powered by Gemini 4.',
      '[REDACTED]',
      'Core invariant instruction: always be precise.',
    ].join('\n');

    const sysTurn2 = [
      'x-anthropic-billing-header: cc_version=1.1; cost=0.99',
      'Current date: 2026-11-27',
      'You are powered by Gemini 4 Pro.',
      '[FILTERED]',
      'Core invariant instruction: always be precise.',
    ].join('\n');

    const req1: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: sysTurn1 }] },
      contents: [{ role: 'user', parts: [{ text: 'First question' }] }],
    };
    const req2: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: sysTurn2 }] },
      contents: [
        { role: 'user', parts: [{ text: 'First question' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'Second question' }] },
      ],
    };

    expect(computeSessionHash(req1)).toBe(computeSessionHash(req2));

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
        sessionId: 'sid-volatile-100',
        calls,
      }),
    });

    try {
      const w1 = pool.acquireWorker(account, model, req1, sessionKey);
      await w1.worker.executePrompt(req1);
      w1.release();

      // Verify agy received the UNSTRIPPED raw systemInstruction
      const metaAppend = (
        calls.newSessionParams[0]?._meta as {
          antigravity?: { systemPrompt?: { append?: string } };
        }
      )?.antigravity?.systemPrompt?.append;
      expect(metaAppend).toContain('x-anthropic-billing-header: cc_version=1.0');
      expect(metaAppend).toContain('Current date: 2026-11-26');

      // Turn 2 with changed volatile lines still reuses the worker
      const w2 = pool.acquireWorker(account, model, req2, sessionKey);
      expect(w2.worker).toBe(w1.worker);
      await w2.worker.executePrompt(req2);
      w2.release();
      expect(calls.newSessionParams).toHaveLength(1);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it('P0-2: reuses and cross-restart resumes on valid image downgrade and never stores base64 in SQLite', async () => {
    const account = makeAccount('acc-p02-img');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-img-downgrade';
    cleanupKeys.push(
      `${account.id}:${sessionKey}`,
      `${account.id}:${model}:${sessionKey}`,
    );

    const secretBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const req1: GeminiGenerateRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Inspect this image' },
            { inlineData: { mimeType: 'image/png', data: secretBase64 } },
          ],
        },
      ],
    };

    const req2: GeminiGenerateRequest = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Inspect this image\n[image-slim]' }],
        },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'Follow up question' }] },
      ],
    };

    const calls1: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcp1 = new LoopbackMcpServer();
    await mcp1.start();
    const pool1 = new AcpWorkerPool({
      mcpServer: mcp1,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-img-100',
        calls: calls1,
      }),
    });

    try {
      const w1 = pool1.acquireWorker(account, model, req1, sessionKey);
      await w1.worker.executePrompt(req1);
      w1.release();

      // Verify zero base64 in SQLite acp_sessions
      const rawDb = (
        store as unknown as {
          db: { query: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | null } };
        }
      ).db;
      const rawRow = rawDb
        .query('SELECT * FROM acp_sessions WHERE sticky_key = ?')
        .get(`${account.id}:${sessionKey}`);
      expect(rawRow).not.toBeNull();
      expect(JSON.stringify(rawRow)).not.toContain(secretBase64);
    } finally {
      await pool1.shutdownAll();
      await mcp1.stop();
    }

    // Cross-restart resume with image downgraded to [image-slim]
    const calls2: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcp2 = new LoopbackMcpServer();
    await mcp2.start();
    const pool2 = new AcpWorkerPool({
      mcpServer: mcp2,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-img-fallback',
        calls: calls2,
      }),
    });

    try {
      const w2 = pool2.acquireWorker(account, model, req2, sessionKey);
      const res2 = await w2.worker.executePrompt(req2);
      w2.release();

      expect(res2.timings?.sessionResumed).toBe(true);
      expect(calls2.resumeSessionParams).toHaveLength(1);
      expect(calls2.newSessionParams).toHaveLength(0);
      const deltaPrompt = JSON.stringify(calls2.promptParams[0]?.prompt);
      expect(deltaPrompt).toContain('Follow up question');
      expect(deltaPrompt).not.toContain('Inspect this image');
    } finally {
      await pool2.shutdownAll();
      await mcp2.stop();
    }
  });

  it('P1-1: idempotently migrates legacy acp_sessions table missing mid_turn and committed_summaries_json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'acp-p1-legacy-'));
    const dbPath = join(tempDir, 'legacy.db');
    const now = Date.now();
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('k1', 'sid-legacy', 'acc-1', 'gemini-4-hydrogen', 'sys', 'tools', '["h1"]', now);
      legacyDb.close();

      const s1 = new GatewayStore(dbPath);
      const rec1 = s1.getAcpSession('k1', now);
      expect(rec1).not.toBeNull();
      expect(rec1?.midTurn).toBe(false);
      expect(rec1?.committedCount).toBe(1);
      expect(rec1?.committedSummaries).toEqual([]);
      expect(rec1?.midTurnMeta).toBeNull();
      s1.close();

      const s2 = new GatewayStore(dbPath);
      const rec2 = s2.getAcpSession('k1', now);
      expect(rec2?.sessionId).toBe('sid-legacy');
      s2.close();
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows WAL file handle release may lag slightly
      }
    }
  });

  it('P1-1: parks midTurn on tool pause, resumes only delta across restart, and clears midTurn on completion/abort/timeout', async () => {
    const account = makeAccount('acc-p11-park');
    const model = 'gemini-4-hydrogen';
    const sessionKey = 'sess-park-1';
    const primaryKey = `${account.id}:${sessionKey}`;
    cleanupKeys.push(primaryKey, `${account.id}:${model}:${sessionKey}`);

    const toolsDecl = [
      {
        functionDeclarations: [
          {
            name: 'read_note',
            description: 'Read a note',
            parameters: {
              type: 'OBJECT',
              properties: { path: { type: 'STRING' } },
            },
          },
        ],
      },
    ];

    const reqTurn1: GeminiGenerateRequest = {
      tools: toolsDecl,
      contents: [{ role: 'user', parts: [{ text: 'Read note.txt please' }] }],
    };

    const calls1: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcp1 = new LoopbackMcpServer();
    await mcp1.start();
    const pool1 = new AcpWorkerPool({
      mcpServer: mcp1,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-park-100',
        calls: calls1,
        onPrompt: async (_params, { mcpUrl }) => {
          // Simulate agy calling the loopback MCP tool and parking
          expect(mcpUrl).toBeTruthy();
          const resp = await fetch(mcpUrl!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'read_note', arguments: { path: 'note.txt' } },
            }),
          });
          const data = (await resp.json()) as { result?: unknown };
          return { stopReason: 'end_turn', toolRes: data.result };
        },
      }),
    });

    let emittedCallId = '';
    try {
      const w1 = pool1.acquireWorker(account, model, reqTurn1, sessionKey);
      const res1 = await w1.worker.executePrompt(reqTurn1);
      w1.release();

      const fc = res1.parts.find((p) => p.functionCall)?.functionCall;
      expect(fc).toBeDefined();
      emittedCallId = fc!.id!;

      const parked = store.getAcpSession(primaryKey);
      expect(parked).not.toBeNull();
      expect(parked?.midTurn).toBe(true);
      expect(parked?.committedCount).toBe(1);
      expect(parked?.midTurnMeta?.awaitingTools).toHaveLength(1);
      expect(parked?.midTurnMeta?.awaitingTools[0]?.id).toBe(emittedCallId);
    } finally {
      await pool1.shutdownAll();
      await mcp1.stop();
    }

    // Restart gateway (pool2) and send functionResponse -> resumeStep sends only delta and clears midTurn
    const reqTurn2: GeminiGenerateRequest = {
      tools: toolsDecl,
      contents: [
        { role: 'user', parts: [{ text: 'Read note.txt please' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: emittedCallId,
                name: 'read_note',
                args: { path: 'note.txt' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: emittedCallId,
                name: 'read_note',
                response: { content: 'hello from note' },
              },
            },
          ],
        },
      ],
    };

    const calls2: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const mcp2 = new LoopbackMcpServer();
    await mcp2.start();
    const pool2 = new AcpWorkerPool({
      mcpServer: mcp2,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-park-fallback',
        calls: calls2,
      }),
    });

    try {
      const w2 = pool2.acquireWorker(account, model, reqTurn2, sessionKey);
      const res2 = await w2.worker.executePrompt(reqTurn2);
      w2.release();

      expect(res2.timings?.sessionResumed).toBe(true);
      expect(calls2.resumeSessionParams).toHaveLength(1);
      expect(calls2.newSessionParams).toHaveLength(0);
      const deltaPrompt = JSON.stringify(calls2.promptParams[0]?.prompt);
      expect(deltaPrompt).toContain('hello from note');
      expect(deltaPrompt).not.toContain('Read note.txt please');

      const afterDone = store.getAcpSession(primaryKey);
      expect(afterDone?.midTurn).toBe(false);
      expect(afterDone?.midTurnMeta).toBeNull();
    } finally {
      await pool2.shutdownAll();
      await mcp2.stop();
    }

    // Verify Fail-Fast fallback to newSession when midTurn resumeSession throws
    const calls3: RecordedCalls = {
      newSessionParams: [],
      resumeSessionParams: [],
      setModelParams: [],
      promptParams: [],
    };
    const errKey = 'sess-park-err';
    const errPrimary = `${account.id}:${errKey}`;
    cleanupKeys.push(errPrimary, `${account.id}:${model}:${errKey}`);
    store.upsertAcpSession({
      stickyKey: errPrimary,
      sessionId: 'dead-park-sid',
      accountId: account.id,
      model,
      systemHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      toolsHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sensitiveFilterFingerprint: '',
      committedHashes: ['h0'],
      midTurn: true,
      committedCount: 1,
      midTurnMeta: {
        awaitingTools: [{ id: 'c1', name: 'read_note', mcpName: 'read_note', args: {} }],
      },
      updatedAt: Date.now(),
    });
    const mcp3 = new LoopbackMcpServer();
    await mcp3.start();
    const pool3 = new AcpWorkerPool({
      mcpServer: mcp3,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-park-rebuilt',
        resumeShouldThrow: true,
        calls: calls3,
      }),
    });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const w3 = pool3.acquireWorker(account, model, reqTurn2, errKey);
      const res3 = await w3.worker.executePrompt(reqTurn2);
      w3.release();
      expect(res3.timings?.sessionResumed).toBe(false);
      expect(calls3.newSessionParams).toHaveLength(1);
    } finally {
      console.warn = origWarn;
      await pool3.shutdownAll();
      await mcp3.stop();
    }

    // Verify CANCELLED clears midTurn snapshot
    const cancelKey = 'sess-park-cancel';
    const cancelPrimary = `${account.id}:${cancelKey}`;
    cleanupKeys.push(cancelPrimary, `${account.id}:${model}:${cancelKey}`);
    const mcp4 = new LoopbackMcpServer();
    await mcp4.start();
    const pool4 = new AcpWorkerPool({
      mcpServer: mcp4,
      cleanupIntervalMs: 60_000,
      transportFactory: createMockTransportFactory({
        sessionId: 'sid-cancel-1',
        calls: {
          newSessionParams: [],
          resumeSessionParams: [],
          setModelParams: [],
          promptParams: [],
        },
      }),
    });
    try {
      const ac = new AbortController();
      ac.abort();
      const w4 = pool4.acquireWorker(account, model, reqTurn1, cancelKey);
      await expect(w4.worker.executePrompt(reqTurn1, undefined, ac.signal)).rejects.toThrow();
      w4.release();
      expect(store.getAcpSession(cancelPrimary)).toBeNull();
    } finally {
      await pool4.shutdownAll();
      await mcp4.stop();
    }
  });
});
