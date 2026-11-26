import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import {
  AgySessionWorker,
  WorkerError,
  classifyUpstreamError,
  type AcpTransport,
  type AcpTransportFactory,
} from '../src/acp/worker';
import { createGeminiHandler, type SchedulerLike, type WorkerPoolLike } from '../src/gemini/handler';
import type { AccountRecord, GeminiPart } from '../src/types';

const REAL_503_CLI_CHUNK =
  '⚠ API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3-pro-high on the server';

function makeAccount(id: string): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Mock-${id}`,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: '',
    proxyUrl: '',
    status: 'ready',
    statusReason: '',
    tier: 'pro',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function createScriptedTransportFactory(
  script: (
    onUpdate: (params: Record<string, unknown>) => void,
    accountId: string,
  ) => Promise<unknown>,
  onClose?: (accountId: string) => void,
): AcpTransportFactory {
  return ({ onUpdate, env }) => {
    const accountId = env.MOCK_ACCOUNT_ID ?? 'unknown';
    let closed = false;
    const transport: AcpTransport = {
      async initialize() {
        return { ok: true };
      },
      async newSession() {
        return { sessionId: `sess-${accountId}` };
      },
      async setModel() {
        return {};
      },
      async prompt() {
        return script(onUpdate, accountId);
      },
      async cancel() {},
      async close() {
        closed = true;
        onClose?.(accountId);
      },
      isAlive() {
        return !closed;
      },
    };
    return transport;
  };
}

function createGeminiHarness(
  accounts: AccountRecord[],
  runScript: (
    onUpdate: (params: Record<string, unknown>) => void,
    accountId: string,
  ) => Promise<unknown>,
  onClose?: (accountId: string) => void,
) {
  const mcpServer = new LoopbackMcpServer();
  const failures: Array<{ accountId: string; status: number; reasonCode: string; isQuotaError: boolean }> = [];
  const successes: string[] = [];

  const scheduler: SchedulerLike = {
    async selectAccount({ excludeAccountIds }) {
      const next = accounts.find((a) => !excludeAccountIds.includes(a.id)) ?? null;
      return { account: next };
    },
    reportFailure(params) {
      failures.push({
        accountId: params.accountId,
        status: params.status,
        reasonCode: params.reasonCode,
        isQuotaError: params.isQuotaError,
      });
      return { retryAfterSeconds: 10 };
    },
    reportSuccess(accountId) {
      successes.push(accountId);
    },
  };

  const workerPool: WorkerPoolLike = {
    async acquire({ account, model }) {
      const transportFactory: AcpTransportFactory = (opts) =>
        createScriptedTransportFactory(runScript, onClose)({
          ...opts,
          env: { ...opts.env, MOCK_ACCOUNT_ID: account.id },
        });
      const worker = new AgySessionWorker({
        account,
        model,
        mcpServer,
        idleTimeoutMs: 5000,
        softErrorCutoffMs: 2800,
        transportFactory,
      });
      return {
        id: `handle-${account.id}`,
        accountId: account.id,
        async generate(params) {
          const result = await worker.executePrompt(
            params.request,
            {
              onPart: params.onChunk
                ? (part) => {
                    params.onChunk!({
                      candidates: [
                        {
                          index: 0,
                          content: { role: 'model', parts: [part] },
                        },
                      ],
                    });
                  }
                : undefined,
            },
            params.signal,
          );
          return {
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: result.parts },
                finishReason: result.finishReason,
              },
            ],
            usageMetadata: result.usage,
            timings: result.timings,
          };
        },
      };
    },
    release() {},
  };

  const handler = createGeminiHandler({ scheduler, workerPool });
  return { handler, failures, successes, mcpServer };
}

describe('503 capacity classification, fast abort, and real 503 passthrough', () => {
  it('1. classifyUpstreamError recognizes CLI 503 capacity errors without misclassifying plain numbers', () => {
    expect(classifyUpstreamError(REAL_503_CLI_CHUNK)).toEqual({
      code: 'CAPACITY_UNAVAILABLE',
      upstreamStatus: 503,
    });
    expect(classifyUpstreamError('Model overloaded, retrying in 2s')).toEqual({
      code: 'CAPACITY_UNAVAILABLE',
      upstreamStatus: 503,
      retryAfterMs: 2000,
    });
    expect(classifyUpstreamError('503 Service Unavailable')).toEqual({
      code: 'CAPACITY_UNAVAILABLE',
      upstreamStatus: 503,
    });
    expect(classifyUpstreamError('HTTP 503 from upstream')).toEqual({
      code: 'CAPACITY_UNAVAILABLE',
      upstreamStatus: 503,
    });
    expect(classifyUpstreamError('The conference room is 503 on floor 5.')).toBeNull();
  });

  it('2. worker fast-aborts (<100ms) on first-chunk CLI 503 without calling onPart and resets transport', async () => {
    const mcpServer = new LoopbackMcpServer();
    const closedAccounts: string[] = [];
    const emittedParts: GeminiPart[] = [];
    let releaseHungPrompt: (() => void) | null = null;
    let chunkEmittedAt = 0;

    const transportFactory = createScriptedTransportFactory(
      async (onUpdate) => {
        chunkEmittedAt = performance.now();
        onUpdate({
          sessionId: 'sess-acc-503',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: REAL_503_CLI_CHUNK },
          },
        });
        // Simulate CLI hanging while retrying 8 times internally
        await new Promise<void>((resolve) => {
          releaseHungPrompt = resolve;
        });
        return { stopReason: 'end_turn' };
      },
      (id) => closedAccounts.push(id),
    );

    const worker = new AgySessionWorker({
      account: makeAccount('acc-503'),
      model: 'gemini-3-pro-high',
      mcpServer,
      idleTimeoutMs: 5000,
      softErrorCutoffMs: 2800,
      transportFactory: (opts) =>
        transportFactory({ ...opts, env: { ...opts.env, MOCK_ACCOUNT_ID: 'acc-503' } }),
    });

    let caught: unknown;
    let abortLatencyMs = Infinity;
    try {
      await worker.executePrompt(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        { onPart: (part) => emittedParts.push(part) },
      );
    } catch (err) {
      abortLatencyMs = performance.now() - chunkEmittedAt;
      caught = err;
    } finally {
      releaseHungPrompt?.();
      mcpServer.stop();
    }

    expect(caught).toBeInstanceOf(WorkerError);
    const workerErr = caught as WorkerError;
    expect(workerErr.code).toBe('CAPACITY_UNAVAILABLE');
    expect(workerErr.upstreamStatus).toBe(503);
    expect(emittedParts).toEqual([]);
    expect(closedAccounts).toEqual(['acc-503']);
    expect(abortLatencyMs).toBeLessThan(100);
  });

  it('2b. worker fast-aborts (<100ms) on explicit error frame with 503 capacity error', async () => {
    const mcpServer = new LoopbackMcpServer();
    const closedAccounts: string[] = [];
    let releaseHungPrompt: (() => void) | null = null;

    const transportFactory = createScriptedTransportFactory(
      async (onUpdate) => {
        onUpdate({
          sessionId: 'sess-acc-err',
          update: {
            sessionUpdate: 'error',
            message: 'UNAVAILABLE (code 503): No capacity available',
          },
        });
        await new Promise<void>((resolve) => {
          releaseHungPrompt = resolve;
        });
        return { stopReason: 'end_turn' };
      },
      (id) => closedAccounts.push(id),
    );

    const worker = new AgySessionWorker({
      account: makeAccount('acc-err'),
      model: 'gemini-3-pro-high',
      mcpServer,
      idleTimeoutMs: 5000,
      softErrorCutoffMs: 2800,
      transportFactory: (opts) =>
        transportFactory({ ...opts, env: { ...opts.env, MOCK_ACCOUNT_ID: 'acc-err' } }),
    });

    const started = performance.now();
    let caught: unknown;
    try {
      await worker.executePrompt({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    } catch (err) {
      caught = err;
    } finally {
      releaseHungPrompt?.();
      mcpServer.stop();
    }
    const elapsedMs = performance.now() - started;

    expect(caught).toBeInstanceOf(WorkerError);
    expect((caught as WorkerError).code).toBe('CAPACITY_UNAVAILABLE');
    expect((caught as WorkerError).upstreamStatus).toBe(503);
    expect(closedAccounts).toEqual(['acc-err']);
    expect(elapsedMs).toBeLessThan(100);
  });

  it('3a. handler switches from account A (503 fast-abort) to account B and succeeds with 200', async () => {
    const accA = makeAccount('acc-a');
    const accB = makeAccount('acc-b');
    const closed: string[] = [];
    const resolvers: Array<() => void> = [];

    const { handler, failures, successes, mcpServer } = createGeminiHarness(
      [accA, accB],
      async (onUpdate, accountId) => {
        if (accountId === 'acc-a') {
          onUpdate({
            sessionId: 'sess-acc-a',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: REAL_503_CLI_CHUNK },
            },
          });
          await new Promise<void>((r) => resolvers.push(r));
          return { stopReason: 'end_turn' };
        }
        onUpdate({
          sessionId: 'sess-acc-b',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Recovered on account B' },
          },
        });
        return { stopReason: 'end_turn' };
      },
      (id) => closed.push(id),
    );

    try {
      const url = new URL('http://127.0.0.1:8048/v1beta/models/gemini-3-pro-high:streamGenerateContent?alt=sse');
      const req = new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        }),
      });

      const started = performance.now();
      const res = await handler(req, url);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const bodyText = await res!.text();
      const elapsedMs = performance.now() - started;

      expect(bodyText).toContain('Recovered on account B');
      expect(bodyText).not.toContain('API error');
      expect(failures).toEqual([
        {
          accountId: 'acc-a',
          status: 503,
          reasonCode: 'UNAVAILABLE',
          isQuotaError: false,
        },
      ]);
      expect(successes).toEqual(['acc-b']);
      expect(closed).toContain('acc-a');
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      for (const r of resolvers) r();
      mcpServer.stop();
    }
  });

  it('3b. handler returns real HTTP 503 UNAVAILABLE (not 429) when all accounts hit 503', async () => {
    const accA = makeAccount('acc-a');
    const accB = makeAccount('acc-b');
    const resolvers: Array<() => void> = [];

    const { handler, failures, mcpServer } = createGeminiHarness(
      [accA, accB],
      async (onUpdate, accountId) => {
        onUpdate({
          sessionId: `sess-${accountId}`,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: REAL_503_CLI_CHUNK },
          },
        });
        await new Promise<void>((r) => resolvers.push(r));
        return { stopReason: 'end_turn' };
      },
    );

    try {
      const url = new URL('http://127.0.0.1:8048/v1beta/models/gemini-3-pro-high:generateContent');
      const req = new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        }),
      });

      const res = await handler(req, url);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
      expect(res!.headers.get('Retry-After')).toBeTruthy();
      const json = (await res!.json()) as { error?: { code?: number; status?: string; message?: string } };
      expect(json.error?.code).toBe(503);
      expect(json.error?.status).toBe('UNAVAILABLE');
      expect(json.error?.message).toContain('No capacity available');
      expect(failures).toHaveLength(2);
      expect(failures.every((f) => f.status === 503 && f.reasonCode === 'UNAVAILABLE')).toBe(true);
    } finally {
      for (const r of resolvers) r();
      mcpServer.stop();
    }
  });

  it('4. guardrails: normal text mentioning 503 passes through while CLI error noise AFTER normal output is silently filtered without aborting', async () => {
    const mcpServer = new LoopbackMcpServer();
    const emittedParts: GeminiPart[] = [];
    const closedAccounts: string[] = [];

    const transportFactory = createScriptedTransportFactory(
      async (onUpdate) => {
        onUpdate({
          sessionId: 'sess-safe',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'HTTP 503 Service Unavailable means the server is overloaded.' },
          },
        });
        onUpdate({
          sessionId: 'sess-safe',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: REAL_503_CLI_CHUNK },
          },
        });
        return { stopReason: 'end_turn' };
      },
      (id) => closedAccounts.push(id),
    );

    const worker = new AgySessionWorker({
      account: makeAccount('safe'),
      model: 'gemini-3-pro-high',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: (opts) =>
        transportFactory({ ...opts, env: { ...opts.env, MOCK_ACCOUNT_ID: 'safe' } }),
    });

    try {
      const result = await worker.executePrompt(
        { contents: [{ role: 'user', parts: [{ text: 'explain 503' }] }] },
        { onPart: (part) => emittedParts.push(part) },
      );
      expect(result.parts).toEqual([
        { text: 'HTTP 503 Service Unavailable means the server is overloaded.' },
      ]);
      expect(emittedParts).toEqual(result.parts);
      expect(closedAccounts).toEqual([]);
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });

  it('5. stderr real-time 503 fast-abort: triggers immediate 503 abort across split chunks before any ACP update', async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const closedAccounts: string[] = [];
    let resolvePrompt: (() => void) | undefined;

    const worker = new AgySessionWorker({
      account: makeAccount('stderr-503'),
      model: 'gemini-3-pro-high',
      mcpServer,
      idleTimeoutMs: 5000,
      softErrorCutoffMs: 2800,
      transportFactory: ({ onStderr }) => {
        let closed = false;
        return {
          async initialize() {
            return { ok: true };
          },
          async newSession() {
            return { sessionId: 'sess-stderr-503' };
          },
          async setModel() {
            return {};
          },
          async prompt() {
            setTimeout(() => {
              onStderr?.('⚠ API error (attempt 1): No capa');
            }, 10);
            setTimeout(() => {
              onStderr?.('city available for model gemini-3-pro-high on the server\n');
            }, 25);
            await new Promise<void>((resolve) => {
              resolvePrompt = resolve;
            });
            return { stopReason: 'end_turn' };
          },
          async cancel() {},
          async close() {
            closed = true;
            closedAccounts.push('stderr-503');
            resolvePrompt?.();
          },
          isAlive() {
            return !closed;
          },
        };
      },
    });

    try {
      const started = performance.now();
      let caught: unknown;
      try {
        await worker.executePrompt({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        });
      } catch (err) {
        caught = err;
      }
      const elapsedMs = performance.now() - started;

      expect(caught).toBeInstanceOf(WorkerError);
      const wErr = caught as WorkerError;
      expect(wErr.code).toBe('CAPACITY_UNAVAILABLE');
      expect(wErr.upstreamStatus).toBe(503);
      expect(wErr.message).toContain('No capacity available');
      expect(closedAccounts).toContain('stderr-503');
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      resolvePrompt?.();
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });

  it('6. stderr guardrails: ignores 503 stderr after effective output and ignores ordinary stderr warnings', async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const closedAccounts: string[] = [];

    const worker = new AgySessionWorker({
      account: makeAccount('stderr-safe'),
      model: 'gemini-3-pro-high',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: ({ onUpdate, onStderr }) => {
        let closed = false;
        return {
          async initialize() {
            return { ok: true };
          },
          async newSession() {
            return { sessionId: 'sess-stderr-safe' };
          },
          async setModel() {
            return {};
          },
          async prompt() {
            // Ordinary stderr warning before output must not abort
            onStderr?.('warn: experimental flag enabled\n');
            onUpdate({
              sessionId: 'sess-stderr-safe',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Real effective output' },
              },
            });
            // 503 stderr after effective output must not abort
            onStderr?.(`${REAL_503_CLI_CHUNK}\n`);
            return { stopReason: 'end_turn' };
          },
          async cancel() {},
          async close() {
            closed = true;
            closedAccounts.push('stderr-safe');
          },
          isAlive() {
            return !closed;
          },
        };
      },
    });

    try {
      const result = await worker.executePrompt({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      });
      expect(result.parts).toEqual([{ text: 'Real effective output' }]);
      expect(closedAccounts).toEqual([]);
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });
});
