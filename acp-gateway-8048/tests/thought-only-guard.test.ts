import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import {
  AgySessionWorker,
  WorkerError,
  type AcpTransport,
  type AcpTransportFactory,
} from '../src/acp/worker';
import { getConfig, updateConfig } from '../src/config/settings';
import { createGeminiHandler, type SchedulerLike, type WorkerPoolLike } from '../src/gemini/handler';
import type { AccountRecord, GatewayConfig, GeminiGenerateResponse } from '../src/types';

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
      },
      isAlive() {
        return !closed;
      },
    };
    return transport;
  };
}

function createWorkerBackedHarness(
  accounts: AccountRecord[],
  runScript: (
    onUpdate: (params: Record<string, unknown>) => void,
    accountId: string,
  ) => Promise<unknown>,
) {
  const mcpServer = new LoopbackMcpServer();
  const failures: Array<{ accountId: string; status: number; reasonCode: string }> = [];
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
      });
    },
    reportSuccess(accountId) {
      successes.push(accountId);
    },
  };

  const workerPool: WorkerPoolLike = {
    async acquire({ account, model }) {
      const transportFactory: AcpTransportFactory = (opts) => {
        return createScriptedTransportFactory(runScript)({
          ...opts,
          env: { ...opts.env, MOCK_ACCOUNT_ID: account.id },
        });
      };
      const worker = new AgySessionWorker({
        account,
        model,
        mcpServer,
        idleTimeoutMs: 5000,
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
                    params.onChunk?.({
                      candidates: [{ content: { role: 'model', parts: [part] }, index: 0 }],
                    });
                  }
                : undefined,
            },
            params.signal,
          );
          return {
            candidates: [
              {
                content: { role: 'model', parts: result.parts },
                finishReason: result.finishReason,
                index: 0,
              },
            ],
            usageMetadata: result.usageMetadata,
          };
        },
      };
    },
    release() {},
  };

  const handler = createGeminiHandler({ scheduler, workerPool });
  return { handler, failures, successes, mcpServer };
}

function parseSsePayloads(bodyText: string): GeminiGenerateResponse[] {
  return bodyText
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as GeminiGenerateResponse);
}

function countSseComments(bodyText: string, comment: string): number {
  return bodyText.split('\n\n').filter((block) => block.trim() === comment).length;
}

function parseSseErrorFrame(
  bodyText: string,
): { error?: { code?: number; message?: string; status?: string } } | null {
  const block = bodyText.split('\n\n').find((b) => b.trim().startsWith('event: error'));
  if (!block) return null;
  const dataLine = block
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '));
  if (!dataLine) return null;
  return JSON.parse(dataLine.slice(6)) as { error?: { code?: number; message?: string; status?: string } };
}

/** 临时改配置跑一段用例，无论成败都把 streamThought* 还原，避免污染后续用例与持久化配置。 */
async function withConfig<T>(patch: Partial<GatewayConfig>, fn: () => Promise<T>): Promise<T> {
  const prev = getConfig();
  updateConfig(patch);
  try {
    return await fn();
  } finally {
    updateConfig({
      streamThoughtImmediately: prev.streamThoughtImmediately,
      streamThoughtEarlyReleaseMs: prev.streamThoughtEarlyReleaseMs,
    });
  }
}

describe('thought-only guard, buffer isolation, stopReason mapping & token accounting', () => {
  it('retries with next account when first attempt emits thought-only and never leaks stale thought buffer', async () => {
    const prev = getConfig().streamThoughtImmediately;
    updateConfig({ streamThoughtImmediately: false });
    try {
      const acc1 = makeAccount('acc-1');
      const acc2 = makeAccount('acc-2');

      const { handler, failures, successes } = createWorkerBackedHarness(
        [acc1, acc2],
        async (onUpdate, accountId) => {
          if (accountId === 'acc-1') {
            onUpdate({
              sessionUpdate: 'agent_thought_chunk',
              content: { text: 'SECRET_FAILED_THOUGHT_FROM_ACC1' },
            });
            return { stopReason: 'end_turn' };
          }
          onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'REAL_ANSWER_FROM_ACC2' },
          });
          return { stopReason: 'end_turn' };
        },
      );

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);

      const text = await res!.text();
      expect(text).not.toContain('SECRET_FAILED_THOUGHT_FROM_ACC1');
      expect(text).toContain('REAL_ANSWER_FROM_ACC2');
      expect(failures).toEqual([{ accountId: 'acc-1', status: 502, reasonCode: 'SOFT_ERROR' }]);
      expect(successes).toEqual(['acc-2']);
    } finally {
      updateConfig({ streamThoughtImmediately: prev });
    }
  });

  it('streams buffered thought chunks together once effective non-thought output arrives', async () => {
    const acc1 = makeAccount('acc-1');

    const { handler } = createWorkerBackedHarness([acc1], async (onUpdate) => {
      onUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { text: 'Let me think step by step.' },
      });
      await new Promise((r) => setTimeout(r, 10));
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Final answer.' },
      });
      return { stopReason: 'end_turn' };
    });

    const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'solve' }] }] }),
    });

    const res = await handler(req, new URL(req.url));
    expect(res!.status).toBe(200);
    const chunks = parseSsePayloads(await res!.text());

    const parts = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
    expect(parts.some((p) => p.thought === true && p.text === 'Let me think step by step.')).toBe(true);
    expect(parts.some((p) => !p.thought && p.text === 'Final answer.')).toBe(true);
    expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('maps real stopReason to Gemini finishReason and separates thoughtsTokenCount from candidatesTokenCount', async () => {
    const acc1 = makeAccount('acc-1');
    const thoughtText = 'A'.repeat(20); // 20 chars -> 5 thoughtsTokenCount
    const answerText = 'B'.repeat(12); // 12 chars -> 3 candidatesTokenCount

    const { handler } = createWorkerBackedHarness([acc1], async (onUpdate) => {
      onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: thoughtText } });
      onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: answerText } });
      return { stopReason: 'max_tokens' };
    });

    const streamReq = new Request(
      'http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
      },
    );
    const streamRes = await handler(streamReq, new URL(streamReq.url));
    expect(streamRes!.status).toBe(200);
    const chunks = parseSsePayloads(await streamRes!.text());
    const lastChunk = chunks.at(-1)!;
    expect(lastChunk.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
    expect(lastChunk.usageMetadata?.thoughtsTokenCount).toBe(5);
    expect(lastChunk.usageMetadata?.candidatesTokenCount).toBe(3);

    // Also verify refusal -> SAFETY in non-streaming mode
    const refusalHarness = createWorkerBackedHarness([makeAccount('acc-refuse')], async (onUpdate) => {
      onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'T'.repeat(8) } });
      onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'Cannot comply' } });
      return { stopReason: 'refusal' };
    });
    const unaryReq = new Request(
      'http://localhost/v1beta/models/gemini-2.5-pro:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'test' }] }] }),
      },
    );
    const unaryRes = await refusalHarness.handler(unaryReq, new URL(unaryReq.url));
    expect(unaryRes!.status).toBe(200);
    const unaryBody = (await unaryRes!.json()) as GeminiGenerateResponse;
    expect(unaryBody.candidates?.[0]?.finishReason).toBe('SAFETY');
    expect(unaryBody.usageMetadata?.thoughtsTokenCount).toBe(2);
    expect(unaryBody.usageMetadata?.candidatesTokenCount).toBe(Math.ceil('Cannot comply'.length / 4));
  });

  it('writes a standard in-stream error frame and closes the stream when the 200 was already released and every retry fails', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-1');
      const acc2 = makeAccount('acc-2');

      const { handler, failures, successes } = createWorkerBackedHarness(
        [acc1, acc2],
        async (onUpdate, accountId) => {
          if (accountId === 'acc-1') {
            onUpdate({
              sessionUpdate: 'agent_thought_chunk',
              content: { text: 'only thinking on acc1' },
            });
            return { stopReason: 'end_turn' };
          }
          // acc-2 也什么都没输出
          return { stopReason: 'end_turn' };
        },
      );

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      // 首个 thought 到达时就已经把 200 放行了：之后全池重试失败也不能再改状态码，
      // 必须在已打开的流里写标准错误帧后正常关闭，绝不静默假装成功。
      expect(res!.status).toBe(200);
      expect(res!.headers.get('X-Early-Release')).toBe('thought');

      const text = await res!.text();
      expect(text).toContain('event: error');
      const errorFrame = parseSseErrorFrame(text);
      expect(errorFrame?.error?.code).toBe(502);
      expect(errorFrame?.error?.status).toBe('SOFT_ERROR');
      expect(errorFrame?.error?.message).toBeTruthy();
      // 同时保留 Gemini 系客户端能识别的终止帧，且流是正常关闭而不是挂死
      const chunks = parseSsePayloads(text);
      expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe('OTHER');

      // acc-1、acc-2 各失败一次，再加 1 次同号重建重试，全部 502 SOFT_ERROR
      expect(failures.length).toBe(3);
      expect(failures.every((f) => f.status === 502 && f.reasonCode === 'SOFT_ERROR')).toBe(true);
      expect(successes).toEqual([]);
    });
  });

  it('keeps returning a real HTTP error (never a 200 SSE) when every attempt fails before any thought chunk', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-1b');
      const acc2 = makeAccount('acc-2b');

      const { handler, failures } = createWorkerBackedHarness([acc1, acc2], async () => ({
        stopReason: 'end_turn',
      }));

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      const res = await handler(req, new URL(req.url));
      // 一个 thought 都没吐过 → 从未提前放行 200，必须保持真实 HTTP 错误
      expect(res!.headers.get('X-Early-Release')).toBeNull();
      expect(res!.status).toBe(502);
      const body = (await res!.json()) as { error?: { code?: number; message?: string; status?: string } };
      expect(body.error?.status).toBe('SOFT_ERROR');
      expect(body.error?.message).toBeTruthy();
      expect(failures.length).toBe(3);
      expect(failures.every((f) => f.status === 502 && f.reasonCode === 'SOFT_ERROR')).toBe(true);
    });
  });

  it('returns real HTTP 429 JSON (not a 200 empty SSE) when the scheduler has no account before any thought', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const handler = createGeminiHandler({
        scheduler: {
          selectAccount: () => ({ account: null, retryAfterSeconds: 7 }),
        },
        workerPool: {
          acquire: async () => {
            throw new Error('Should not be called');
          },
          release: () => {},
        },
      });

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      const res = await handler(req, new URL(req.url));
      expect(res!.status).toBe(429);
      expect(res!.headers.get('Retry-After')).toBe('7');
      expect(res!.headers.get('X-Early-Release')).toBeNull();
      const body = (await res!.json()) as { error?: { code?: number; status?: string } };
      expect(body.error?.code).toBe(429);
      expect(body.error?.status).toBe('RESOURCE_EXHAUSTED');
    });
  });

  it('releases HTTP 200 + keepalive on the first thought chunk, then switches account without leaking the dirty thought', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-early-1');
      const acc2 = makeAccount('acc-early-2');
      let releaseAnswer!: () => void;
      const answerGate = new Promise<void>((resolve) => {
        releaseAnswer = resolve;
      });

      const { handler, failures, successes } = createWorkerBackedHarness(
        [acc1, acc2],
        async (onUpdate, accountId) => {
          if (accountId === 'acc-early-1') {
            onUpdate({
              sessionUpdate: 'agent_thought_chunk',
              content: { text: 'DIRTY_THOUGHT_FROM_ACC1' },
            });
            return { stopReason: 'end_turn' };
          }
          onUpdate({
            sessionUpdate: 'agent_thought_chunk',
            content: { text: 'CLEAN_THOUGHT_FROM_ACC2' },
          });
          await answerGate;
          onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'CLEAN_ANSWER_FROM_ACC2' },
          });
          return { stopReason: 'end_turn' };
        },
      );

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      // 答案还被 answerGate 卡着：handler 能返回就说明首个 thought 已经放行了 200
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('Content-Type')).toContain('text/event-stream');
      expect(res!.headers.get('X-Early-Release')).toBe('thought');

      releaseAnswer();
      const text = await res!.text();
      // keepalive 是 SSE 注释行，绝不能把 sentAnyChunk / firstSettled 置位（否则换号会被锁死）
      expect(countSseComments(text, ': keepalive')).toBeGreaterThanOrEqual(1);
      expect(text).toContain('CLEAN_THOUGHT_FROM_ACC2');
      expect(text).toContain('CLEAN_ANSWER_FROM_ACC2');
      // 失败账号的脏思考绝不能泄给客户端
      expect(text).not.toContain('DIRTY_THOUGHT_FROM_ACC1');
      expect(failures).toEqual([{ accountId: 'acc-early-1', status: 502, reasonCode: 'SOFT_ERROR' }]);
      expect(successes).toEqual(['acc-early-2']);
    });
  });

  it('allows exactly one same-account rebuild retry for EMPTY_OR_THOUGHT_ONLY_RESPONSE in a single-account pool', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-solo');
      let attempts = 0;

      const { handler, failures, successes } = createWorkerBackedHarness([acc1], async (onUpdate) => {
        attempts += 1;
        if (attempts === 1) {
          onUpdate({
            sessionUpdate: 'agent_thought_chunk',
            content: { text: 'DIRTY_THOUGHT_FROM_BUILD_1' },
          });
          return { stopReason: 'end_turn' };
        }
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'REBUILT_ANSWER_FROM_BUILD_2' },
        });
        return { stopReason: 'end_turn' };
      });

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      const res = await handler(req, new URL(req.url));
      expect(res!.status).toBe(200);
      const text = await res!.text();
      expect(text).toContain('REBUILT_ANSWER_FROM_BUILD_2');
      expect(text).not.toContain('DIRTY_THOUGHT_FROM_BUILD_1');
      // 单号池：恰好 1 次失败 + 1 次同号重建重试，没有死循环
      expect(attempts).toBe(2);
      expect(failures).toEqual([{ accountId: 'acc-solo', status: 502, reasonCode: 'SOFT_ERROR' }]);
      expect(successes).toEqual(['acc-solo']);
    });
  });

  it('releases HTTP 200 + keepalive on the early-release deadline even before any thought chunk arrives', async () => {
    await withConfig({ streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 60 }, async () => {
      const acc1 = makeAccount('acc-deadline');
      const { handler } = createWorkerBackedHarness([acc1], async (onUpdate) => {
        await new Promise((r) => setTimeout(r, 600));
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'LATE_ANSWER' } });
        return { stopReason: 'end_turn' };
      });

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });

      const started = Date.now();
      const res = await handler(req, new URL(req.url));
      const elapsed = Date.now() - started;
      // 正文要 600ms 后才到，而 200 在 60ms 的短阈值就到手了
      expect(res!.status).toBe(200);
      expect(res!.headers.get('X-Early-Release')).toBe('deadline');
      expect(elapsed).toBeLessThan(400);

      const text = await res!.text();
      expect(countSseComments(text, ': keepalive')).toBeGreaterThanOrEqual(1);
      expect(text).toContain('LATE_ANSWER');
    });
  });

  it('AgySessionWorker throws retryable WorkerError and resets session when prompt ends without non-thought parts', async () => {
    let closedCount = 0;
    const mcpServer = new LoopbackMcpServer();
    const worker = new AgySessionWorker({
      account: makeAccount('acc-direct'),
      model: 'gemini-2.5-pro',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: ({ onUpdate }) => ({
        async initialize() {
          return {};
        },
        async newSession() {
          return { sessionId: 's1' };
        },
        async setModel() { return {}; },
        async prompt() {
          onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'silent thought' } });
          return { stopReason: 'end_turn' };
        },
        async cancel() {},
        async close() {
          closedCount += 1;
        },
        isAlive() {
          return closedCount === 0;
        },
      }),
    });

    let caught: unknown;
    try {
      await worker.executePrompt({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WorkerError);
    expect((caught as WorkerError).code).toBe('SOFT_ERROR');
    expect((caught as WorkerError).upstreamStatus).toBe(502);
    expect(closedCount).toBeGreaterThanOrEqual(1);
  });

  it('propagates client AbortSignal through handler and AgySessionWorker to return 499 CANCELLED without reportSuccess or retry', async () => {
    let workerClosedCount = 0;
    let promptCancelled = false;
    const mcpServer = new LoopbackMcpServer();
    const failures: Array<{ accountId: string; status: number; reasonCode: string }> = [];
    const successes: string[] = [];

    const scheduler: SchedulerLike = {
      async selectAccount() {
        return { account: makeAccount('acc-cancel') };
      },
      reportFailure(params) {
        failures.push({
          accountId: params.accountId,
          status: params.status,
          reasonCode: params.reasonCode,
        });
      },
      reportSuccess(accountId) {
        successes.push(accountId);
      },
    };

    let workerCaught: unknown;
    const workerPool: WorkerPoolLike = {
      async acquire({ account, model }) {
        const worker = new AgySessionWorker({
          account,
          model,
          mcpServer,
          idleTimeoutMs: 5000,
          transportFactory: () => ({
            async initialize() {
              return {};
            },
            async newSession() {
              return { sessionId: 'sess-cancel' };
            },
            async setModel() { return {}; },
            async prompt() {
              return new Promise(() => {});
            },
            async cancel() {
              promptCancelled = true;
            },
            async close() {
              workerClosedCount += 1;
            },
            isAlive() {
              return workerClosedCount === 0;
            },
          }),
        });
        return {
          id: 'handle-cancel',
          accountId: account.id,
          async generate(params) {
            try {
              const result = await worker.executePrompt(
                params.request,
                {
                  onPart: params.onChunk
                    ? (part) => {
                        params.onChunk?.({
                          candidates: [{ content: { role: 'model', parts: [part] }, index: 0 }],
                        });
                      }
                    : undefined,
                },
                params.signal,
              );
              return {
                candidates: [
                  {
                    content: { role: 'model', parts: result.parts },
                    finishReason: result.finishReason,
                    index: 0,
                  },
                ],
              };
            } catch (err) {
              workerCaught = err;
              throw err;
            }
          },
        };
      },
      release() {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    const reqAbort = new AbortController();
    const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'slow' }] }] }),
      signal: reqAbort.signal,
    });

    const resPromise = handler(req, new URL(req.url));
    await new Promise((r) => setTimeout(r, 20));
    reqAbort.abort();

    const res = await resPromise;
    expect(res).not.toBeNull();
    expect(res!.status).toBe(499);
    const body = (await res!.json()) as { error?: { code?: number; status?: string } };
    expect(body.error?.status).toBe('CANCELLED');

    await new Promise((r) => setTimeout(r, 20));
    expect(workerCaught).toBeInstanceOf(WorkerError);
    expect((workerCaught as WorkerError).code).toBe('CANCELLED');
    expect(promptCancelled).toBe(true);
    expect(workerClosedCount).toBeGreaterThanOrEqual(1);
    expect(failures).toEqual([]);
    expect(successes).toEqual([]);
  });

  it('returns 499 and skips reportSuccess if signal aborts right as worker.generate resolves', async () => {
    const successes: string[] = [];
    const reqAbort = new AbortController();

    const scheduler: SchedulerLike = {
      async selectAccount() {
        return { account: makeAccount('acc-late-abort') };
      },
      reportFailure() {},
      reportSuccess(accountId) {
        successes.push(accountId);
      },
    };

    const workerPool: WorkerPoolLike = {
      async acquire({ account }) {
        return {
          id: 'handle-late',
          accountId: account.id,
          async generate() {
            reqAbort.abort();
            return {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'done too late' }] },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
            };
          },
        };
      },
      release() {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      signal: reqAbort.signal,
    });

    const res = await handler(req, new URL(req.url));
    expect(res!.status).toBe(499);
    expect(successes).toEqual([]);
  });

  it('guards against writing to streamController after stream cancel()', async () => {
    let emitMore: (() => void) | null = null;
    let finishPrompt: (() => void) | null = null;
    let signalAborted = false;

    const scheduler: SchedulerLike = {
      async selectAccount() {
        return { account: makeAccount('acc-stream-cancel') };
      },
      reportFailure() {},
      reportSuccess() {},
    };

    const workerPool: WorkerPoolLike = {
      async acquire({ account }) {
        return {
          id: 'handle-stream-cancel',
          accountId: account.id,
          async generate(params) {
            params.signal?.addEventListener('abort', () => {
              signalAborted = true;
            });
            params.onChunk?.({
              candidates: [{ content: { role: 'model', parts: [{ text: 'first chunk' }] }, index: 0 }],
            });
            await new Promise<void>((resolve) => {
              emitMore = () => {
                params.onChunk?.({
                  candidates: [{ content: { role: 'model', parts: [{ text: 'late chunk after cancel' }] }, index: 0 }],
                });
              };
              finishPrompt = resolve;
            });
            return {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'final' }] },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
            };
          },
        };
      },
      release() {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'stream' }] }] }),
    });

    const res = await handler(req, new URL(req.url));
    expect(res!.status).toBe(200);
    const reader = res!.body!.getReader();
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);

    // Cancel the stream from client side, then emit late chunk and finish upstream
    await reader.cancel();
    expect(signalAborted).toBe(true);
    expect(() => emitMore?.()).not.toThrow();
    expect(() => finishPrompt?.()).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it('preserves finishReason SAFETY without 502 retry when stopReason is refusal or safety with no effective text', async () => {
    for (const stopReason of ['refusal', 'safety'] as const) {
      let closedCount = 0;
      const mcpServer = new LoopbackMcpServer();
      const worker = new AgySessionWorker({
        account: makeAccount(`acc-${stopReason}`),
        model: 'gemini-2.5-pro',
        mcpServer,
        idleTimeoutMs: 5000,
        transportFactory: () => ({
          async initialize() {
            return {};
          },
          async newSession() {
            return { sessionId: `s-${stopReason}` };
          },
          async setModel() { return {}; },
          async prompt() {
            return { stopReason };
          },
          async cancel() {},
          async close() {
            closedCount += 1;
          },
          isAlive() {
            return closedCount === 0;
          },
        }),
      });

      const directResult = await worker.executePrompt({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      expect(directResult.finishReason).toBe('SAFETY');
      expect(directResult.parts).toEqual([]);
      expect(closedCount).toBe(0);

      const { handler, failures, successes } = createWorkerBackedHarness(
        [makeAccount(`acc-h-${stopReason}`)],
        async () => ({ stopReason }),
      );
      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });
      const res = await handler(req, new URL(req.url));
      expect(res!.status).toBe(200);
      const chunks = parseSsePayloads(await res!.text());
      expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe('SAFETY');
      expect(failures).toEqual([]);
      expect(successes).toEqual([`acc-h-${stopReason}`]);
    }
  });

  it('aborts immediately and calls resetAndClose when client cancels during coldStart', async () => {
    let closedCount = 0;
    let initializeStarted = false;
    const mcpServer = new LoopbackMcpServer();
    const abortCtrl = new AbortController();

    const worker = new AgySessionWorker({
      account: makeAccount('acc-coldstart-cancel'),
      model: 'gemini-2.5-pro',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: () => ({
        async initialize() {
          initializeStarted = true;
          // Hold coldStart in-flight until aborted
          return new Promise(() => {});
        },
        async newSession() {
          return { sessionId: 's-coldstart' };
        },
        async prompt() {
          return { stopReason: 'end_turn' };
        },
        async cancel() {},
        async close() {
          closedCount += 1;
        },
        isAlive() {
          return closedCount === 0;
        },
      }),
    });

    const promptPromise = worker.executePrompt(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      undefined,
      abortCtrl.signal,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(initializeStarted).toBe(true);
    expect(closedCount).toBe(0);

    // Abort during coldStart
    abortCtrl.abort();

    let caught: unknown;
    try {
      await promptPromise;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WorkerError);
    expect((caught as WorkerError).code).toBe('CANCELLED');
    expect(closedCount).toBeGreaterThanOrEqual(1);
    expect(worker.isBusy).toBe(false);
  });

  it('releases HTTP 200 immediately on the first thought chunk under the new streamThoughtImmediately=false default', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-thought-first');
      let releaseAnswer!: () => void;
      const answerGate = new Promise<void>((resolve) => {
        releaseAnswer = resolve;
      });

      const { handler } = createWorkerBackedHarness([acc1], async (onUpdate) => {
        onUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { text: 'Thinking first...' },
        });
        await answerGate;
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'Answer after thought.' },
        });
        return { stopReason: 'end_turn' };
      });

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'solve' }] }] }),
      });

      // 答案还在 gate 后面，200 就必须已经到手（否则一个长思考的 turn 会把客户端挂在等响应头上）
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('X-Early-Release')).toBe('thought');

      releaseAnswer();
      const text = await res!.text();
      const chunks = parseSsePayloads(text);
      const parts = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
      expect(parts.some((p) => p.thought === true && p.text === 'Thinking first...')).toBe(true);
      expect(parts.some((p) => !p.thought && p.text === 'Answer after thought.')).toBe(true);
    });
  });

  it('keeps the legacy streamThoughtImmediately=true behaviour: first thought chunk is already effective content', async () => {
    await withConfig({ streamThoughtImmediately: true }, async () => {
      const acc1 = makeAccount('acc-thought-immediate');
      const { handler } = createWorkerBackedHarness([acc1], async (onUpdate) => {
        onUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: { text: 'Immediate thought.' },
        });
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'Then answer.' },
        });
        return { stopReason: 'end_turn' };
      });

      const req = new Request('http://localhost/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'solve' }] }] }),
      });

      const res = await handler(req, new URL(req.url));
      expect(res!.status).toBe(200);
      // 开了即时吐思考就不需要提前放行旁路，第一个 thought 本身就是有效正文
      expect(res!.headers.get('X-Early-Release')).toBeNull();
      const chunks = parseSsePayloads(await res!.text());
      const parts = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []);
      expect(parts.some((p) => p.thought === true && p.text === 'Immediate thought.')).toBe(true);
      expect(parts.some((p) => !p.thought && p.text === 'Then answer.')).toBe(true);
    });
  });
});
