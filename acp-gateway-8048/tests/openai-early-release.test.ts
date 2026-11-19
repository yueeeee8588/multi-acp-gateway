import { describe, expect, it } from 'bun:test';
import { WorkerError } from '../src/acp/worker';
import { getConfig, updateConfig } from '../src/config/settings';
import type { SchedulerLike, WorkerPoolLike } from '../src/gemini/handler';
import { createOpenAiHandler } from '../src/openai/handler';
import type { AccountRecord, GatewayConfig, GeminiGenerateResponse } from '../src/types';

function makeAccount(id: string): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `${id}@example.com`,
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

function makeOpenAiStreamRequest(prompt = 'hi'): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-pro',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}

function parseOpenAiSse(raw: string): Array<Record<string, unknown> | '[DONE]'> {
  const results: Array<Record<string, unknown> | '[DONE]'> = [];
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          results.push('[DONE]');
        } else {
          results.push(JSON.parse(payload) as Record<string, unknown>);
        }
      }
    }
  }
  return results;
}

function countSseComments(raw: string, comment: string): number {
  return raw.split('\n\n').filter((block) => block.trim() === comment).length;
}

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

function createHarness(
  accounts: AccountRecord[],
  runGenerate: (params: {
    accountId: string;
    onChunk?: (chunk: GeminiGenerateResponse) => void;
    signal?: AbortSignal;
  }) => Promise<GeminiGenerateResponse>,
) {
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
    async acquire({ account }) {
      return {
        id: `handle-${account.id}`,
        accountId: account.id,
        async generate(params) {
          return runGenerate({
            accountId: account.id,
            onChunk: params.onChunk,
            signal: params.signal,
          });
        },
      };
    },
    release() {},
  };

  const handler = createOpenAiHandler({ scheduler, workerPool });
  return { handler, failures, successes };
}

describe('OpenAI SSE early release & immediate keepalive', () => {
  it('releases HTTP 200 + keepalive on first thought, retries seamlessly on thought-only failure without leaking stale thought', async () => {
    await withConfig({ streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 3000 }, async () => {
      const acc1 = makeAccount('acc-1');
      const acc2 = makeAccount('acc-2');
      let releaseAcc1Failure!: () => void;
      const acc1Gate = new Promise<void>((resolve) => {
        releaseAcc1Failure = resolve;
      });

      const { handler, failures, successes } = createHarness([acc1, acc2], async ({ accountId, onChunk }) => {
        if (accountId === 'acc-1') {
          onChunk?.({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'DIRTY_THOUGHT_FROM_ACC1', thought: true }] },
                index: 0,
              },
            ],
          });
          await acc1Gate;
          throw new WorkerError('EMPTY_OR_THOUGHT_ONLY_RESPONSE', {
            code: 'SOFT_ERROR',
            upstreamStatus: 502,
          });
        }

        onChunk?.({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'CLEAN_THOUGHT_FROM_ACC2', thought: true }] },
              index: 0,
            },
          ],
        });
        onChunk?.({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'CLEAN_ANSWER_FROM_ACC2' }] },
              index: 0,
            },
          ],
        });
        return {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'CLEAN_THOUGHT_FROM_ACC2', thought: true },
                  { text: 'CLEAN_ANSWER_FROM_ACC2' },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        };
      });

      const req = makeOpenAiStreamRequest('solve with thought');
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('content-type')).toContain('text/event-stream');
      expect(res!.headers.get('X-Early-Release')).toBe('thought');

      const reader = res!.body!.getReader();
      const decoder = new TextDecoder();
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      const firstFrame = decoder.decode(firstRead.value, { stream: true });
      expect(firstFrame).toContain(': keepalive\n\n');

      // 放行账号 1 失败，触发无感切换账号 2
      releaseAcc1Failure();

      let fullText = firstFrame;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        fullText += decoder.decode(next.value, { stream: true });
      }
      fullText += decoder.decode();

      expect(countSseComments(fullText, ': keepalive')).toBeGreaterThanOrEqual(1);
      expect(fullText).not.toContain('DIRTY_THOUGHT_FROM_ACC1');
      expect(fullText).toContain('CLEAN_THOUGHT_FROM_ACC2');
      expect(fullText).toContain('CLEAN_ANSWER_FROM_ACC2');

      const events = parseOpenAiSse(fullText);
      expect(events.at(-1)).toBe('[DONE]');
      expect(failures).toEqual([{ accountId: 'acc-1', status: 502, reasonCode: 'SOFT_ERROR' }]);
      expect(successes).toEqual(['acc-2']);
    });
  });

  it('releases HTTP 200 + keepalive after streamThoughtEarlyReleaseMs silence deadline, then streams content and [DONE]', async () => {
    await withConfig({ streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 50 }, async () => {
      const acc1 = makeAccount('acc-silent');
      let releaseContent!: () => void;
      const contentGate = new Promise<void>((resolve) => {
        releaseContent = resolve;
      });

      const { handler, successes } = createHarness([acc1], async ({ onChunk }) => {
        await contentGate;
        onChunk?.({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'DELAYED_ANSWER_OK' }] },
              index: 0,
            },
          ],
        });
        return {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'DELAYED_ANSWER_OK' }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        };
      });

      const req = makeOpenAiStreamRequest('slow upstream');
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('X-Early-Release')).toBe('deadline');

      const reader = res!.body!.getReader();
      const decoder = new TextDecoder();
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      const firstFrame = decoder.decode(firstRead.value, { stream: true });
      expect(firstFrame).toContain(': keepalive\n\n');

      releaseContent();

      let fullText = firstFrame;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        fullText += decoder.decode(next.value, { stream: true });
      }
      fullText += decoder.decode();

      expect(fullText).toContain('DELAYED_ANSWER_OK');
      const events = parseOpenAiSse(fullText);
      expect(events.at(-1)).toBe('[DONE]');
      expect(successes).toEqual(['acc-silent']);
    });
  });

  it('writes standard OpenAI SSE error frame + [DONE] and closes stream when all accounts fail after early release', async () => {
    await withConfig({ streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 3000 }, async () => {
      const acc1 = makeAccount('acc-fail-1');
      const acc2 = makeAccount('acc-fail-2');
      let releaseFailures!: () => void;
      const failGate = new Promise<void>((resolve) => {
        releaseFailures = resolve;
      });

      const { handler, failures } = createHarness([acc1, acc2], async ({ accountId, onChunk }) => {
        onChunk?.({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: `STALE_THOUGHT_${accountId}`, thought: true }] },
              index: 0,
            },
          ],
        });
        if (accountId === 'acc-fail-1') {
          await failGate;
        }
        throw new WorkerError('Model capacity exhausted', {
          code: 'CAPACITY_UNAVAILABLE',
          upstreamStatus: 503,
        });
      });

      const req = makeOpenAiStreamRequest('all fail after early release');
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('X-Early-Release')).toBe('thought');

      const reader = res!.body!.getReader();
      const decoder = new TextDecoder();
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      const firstFrame = decoder.decode(firstRead.value, { stream: true });
      expect(firstFrame).toContain(': keepalive\n\n');

      releaseFailures();

      let fullText = firstFrame;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        fullText += decoder.decode(next.value, { stream: true });
      }
      fullText += decoder.decode();

      // 绝不泄露失败账号的 thought
      expect(fullText).not.toContain('STALE_THOUGHT_acc-fail-1');
      expect(fullText).not.toContain('STALE_THOUGHT_acc-fail-2');

      const events = parseOpenAiSse(fullText);
      expect(events.at(-1)).toBe('[DONE]');
      const errorEvent = events.find(
        (ev): ev is { error: { message: string; type: string; code: string | null } } =>
          typeof ev === 'object' && ev !== null && 'error' in ev,
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error.message).toContain('Model capacity exhausted');
      expect(errorEvent!.error.type).toBe('server_error');
      expect(errorEvent!.error.code).toBe('service_unavailable');
      expect(failures).toHaveLength(2);
    });
  });

  it('returns real HTTP 503 JSON error (not HTTP 200 SSE) when all accounts fail before early release deadline', async () => {
    await withConfig({ streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 3000 }, async () => {
      const acc1 = makeAccount('acc-pre-fail');
      const { handler, failures } = createHarness([acc1], async () => {
        throw new WorkerError('Upstream capacity unavailable', {
          code: 'CAPACITY_UNAVAILABLE',
          upstreamStatus: 503,
        });
      });

      const req = makeOpenAiStreamRequest('fast 503 failure');
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
      expect(res!.headers.get('content-type')).toContain('application/json');
      expect(res!.headers.get('X-Early-Release')).toBeNull();

      const body = (await res!.json()) as { error?: { message?: string; code?: string } };
      expect(body.error?.message).toContain('Upstream capacity unavailable');
      expect(body.error?.code).toBe('service_unavailable');
      expect(failures).toEqual([{ accountId: 'acc-pre-fail', status: 503, reasonCode: 'UNAVAILABLE' }]);
    });
  });

  it('keeps legacy streamThoughtImmediately=true compatible without triggering early release bypass', async () => {
    await withConfig({ streamThoughtImmediately: true, streamThoughtEarlyReleaseMs: 50 }, async () => {
      const acc1 = makeAccount('acc-legacy-thought');
      const { handler } = createHarness([acc1], async ({ onChunk }) => {
        onChunk?.({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'IMMEDIATE_THOUGHT', thought: true }] },
              index: 0,
            },
          ],
        });
        onChunk?.({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'IMMEDIATE_ANSWER' }] },
              index: 0,
            },
          ],
        });
        return {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'IMMEDIATE_THOUGHT', thought: true },
                  { text: 'IMMEDIATE_ANSWER' },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        };
      });

      const req = makeOpenAiStreamRequest('legacy immediate thought');
      const res = await handler(req, new URL(req.url));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('X-Early-Release')).toBeNull();

      const text = await res!.text();
      expect(text).toContain('IMMEDIATE_THOUGHT');
      expect(text).toContain('IMMEDIATE_ANSWER');
      expect(parseOpenAiSse(text).at(-1)).toBe('[DONE]');
    });
  });
});
