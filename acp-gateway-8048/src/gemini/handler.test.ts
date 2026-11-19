import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer } from '../acp/loopback-mcp';
import { AgySessionWorker, WorkerError, type AcpTransport } from '../acp/worker';
import { GatewayStore, store } from '../db/store';
import { eventBus } from '../logs/events';
import { createApp } from '../server';
import {
  applyGenerationConfigGuardrails,
  createGeminiHandler,
  discoverAgyModels,
  parseAgyModelsOutput,
  refreshModelCatalogOnce,
  resetModelCatalogCacheForTest,
  setModelsFetcherForTest,
  SUPPORTED_GEMINI_MODELS,
  type ModelLimitsMap,
  type SchedulerLike,
  type WorkerHandle,
  type WorkerPoolLike,
} from './handler';
import { estimateTokens, resolveGatewayModel } from './protocol';
import { createOpenAiHandler } from '../openai/handler';
import { createAnthropicHandler } from '../anthropic/handler';
import type { AccountRecord, GeminiGenerateRequest, GeminiGenerateResponse } from '../types';

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
    tier: 'standard',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Gemini handler stream interruption & guardrails', () => {
  it('migrates legacy request_logs and round-trips cached_tokens including zero', () => {
    const legacy = new GatewayStore(':memory:');
    try {
      legacy.db.exec('ALTER TABLE request_logs DROP COLUMN cached_tokens');
      // Re-run startup migration against the legacy schema, without touching a disk database.
      const schema = legacy as unknown as { initSchema(): void };
      schema.initSchema();
      schema.initSchema(); // Migration must be idempotent.
      for (const cachedTokens of [undefined, 0, 25]) {
        legacy.upsertRequestLog({
          id: 'legacy-cached-tokens', model: 'test', family: 'test', endpoint: 'generateContent',
          stream: false, state: 'completed', startedAt: 1, switchCount: 0,
          inputTokens: 100, cachedTokens, attempts: [],
        });
        expect(legacy.getRecentRequestLogs(1)[0]?.cachedTokens).toBe(cachedTokens);
      }
    } finally {
      legacy.db.close();
    }
  });

  it.each([
    { raw: 0, expected: 0 },
    { raw: -5, expected: 0 },
    { raw: 7, expected: 7 },
    { raw: 50, expected: 10 },
  ])('normalizes cachedTokens $raw to $expected in SSE usage and logs', async ({ raw, expected }) => {
    const account = makeAccount('acc-cached-sse');
    const handler = createGeminiHandler({
      scheduler: { selectAccount: () => ({ account }) },
      workerPool: {
        acquire: async () => ({
          id: 'w-cached-sse', accountId: account.id,
          generate: async (params) => {
            params.onChunk?.({ candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] });
            return {
              candidates: [{ finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
              cacheHit: raw > 0, cachedTokens: raw,
            };
          },
        }),
        release: () => {},
      },
    });
    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:streamGenerateContent?alt=sse');
    const response = await handler(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    }), url);
    expect(response?.status).toBe(200);
    const chunks = (await response!.text()).split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as GeminiGenerateResponse);
    expect(chunks.at(-1)?.usageMetadata?.cachedContentTokenCount).toBe(expected > 0 ? expected : undefined);
    for (const chunk of chunks) {
      expect('cachedTokens' in chunk).toBe(false);
      expect('cacheHit' in chunk).toBe(false);
    }
    const log = store.getRecentRequestLogs(100).find((item) => `resp_${item.id}` === chunks.at(-1)?.responseId);
    expect(log?.cachedTokens).toBe(expected);
  });

  it('emits finishReason OTHER instead of MAX_TOKENS or STOP when stream is interrupted after first chunk', async () => {
    const account = makeAccount('acc-stream-err');
    const scheduler: SchedulerLike = {
      selectAccount: () => ({ account }),
    };
    const workerPool: WorkerPoolLike = {
      acquire: async (): Promise<WorkerHandle> => ({
        id: 'w-1',
        accountId: account.id,
        generate: async (params) => {
          params.onChunk?.({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'partial output' }] },
                index: 0,
              },
            ],
          });
          throw new Error('upstream connection reset');
        },
      }),
      release: () => {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:streamGenerateContent?alt=sse');
    const req = new Request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    });

    const res = await handler(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const bodyText = await res!.text();
    const events = bodyText
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice(6)) as GeminiGenerateResponse);

    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1]!;
    expect(last.candidates?.[0]?.finishReason).toBe('OTHER');
    expect(last.candidates?.[0]?.finishReason).not.toBe('MAX_TOKENS');
    expect(last.candidates?.[0]?.finishMessage).toContain('Upstream interrupted');
  });

  it('omits hardcoded inputTokenLimit and outputTokenLimit in /v1beta/models', async () => {
    const handler = createGeminiHandler({});
    const listUrl = new URL('http://localhost:8048/v1beta/models');
    const listRes = await handler(new Request(listUrl.toString()), listUrl);
    expect(listRes).not.toBeNull();
    expect(listRes!.status).toBe(200);

    const listJson = (await listRes!.json()) as { models: Array<Record<string, unknown>> };
    expect(listJson.models.length).toBeGreaterThan(0);
    for (const model of listJson.models) {
      expect('inputTokenLimit' in model).toBe(false);
      expect('outputTokenLimit' in model).toBe(false);
    }

    const detailUrl = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium');
    const detailRes = await handler(new Request(detailUrl.toString()), detailUrl);
    expect(detailRes).not.toBeNull();
    expect(detailRes!.status).toBe(200);
    const detailJson = (await detailRes!.json()) as Record<string, unknown>;
    expect('inputTokenLimit' in detailJson).toBe(false);
    expect('outputTokenLimit' in detailJson).toBe(false);
  });

  it('expands maxOutputTokens when smaller than thinkingBudget without 65536 cap when outputTokenLimit is omitted', () => {
    const req: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'think hard' }] }],
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 8192 },
      },
    };
    applyGenerationConfigGuardrails(req);
    expect(req.generationConfig?.maxOutputTokens).toBe(10240);

    const reqHighBudget: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'think beyond 65536' }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 80000 },
      },
    };
    applyGenerationConfigGuardrails(reqHighBudget);
    expect(reqHighBudget.generationConfig?.maxOutputTokens).toBe(84096);

    const reqCapped: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'think max' }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 32000 },
      },
    };
    applyGenerationConfigGuardrails(reqCapped, 32768);
    expect(reqCapped.generationConfig?.maxOutputTokens).toBe(32768);
  });

  it('dynamically updates, clears, and validates /api/models/:id/limits and /v1beta/models', async () => {
    const prevLimits = store.getConfigValue<ModelLimitsMap>('model_limits') ?? {};
    const app = createApp();
    const targetModel = 'gemini-4-hydrogen-medium';

    try {
      // 1. Configure limits via PUT /api/models/:id/limits
      const putRes = await app.fetch(
        new Request(`http://localhost:8048/api/models/${encodeURIComponent(targetModel)}/limits`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputTokenLimit: 500000, outputTokenLimit: 32000 }),
        })
      );
      expect(putRes.status).toBe(200);
      const putJson = (await putRes.json()) as {
        ok: boolean;
        model: string;
        limits: { inputTokenLimit?: number; outputTokenLimit?: number } | null;
      };
      expect(putJson).toEqual({
        ok: true,
        model: targetModel,
        limits: { inputTokenLimit: 500000, outputTokenLimit: 32000 },
      });

      // 2. GET /api/models/limits returns persisted limits
      const getLimitsRes = await app.fetch(new Request('http://localhost:8048/api/models/limits'));
      expect(getLimitsRes.status).toBe(200);
      const getLimitsJson = (await getLimitsRes.json()) as { limits: ModelLimitsMap };
      expect(getLimitsJson.limits[targetModel]).toEqual({
        inputTokenLimit: 500000,
        outputTokenLimit: 32000,
      });

      // 3. /v1beta/models and /v1beta/models/:model reflect new values in real time
      const listRes = await app.fetch(new Request('http://localhost:8048/v1beta/models'));
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as { models: Array<Record<string, unknown>> };
      const listed = listJson.models.find((m) => m.name === `models/${targetModel}`);
      expect(listed?.inputTokenLimit).toBe(500000);
      expect(listed?.outputTokenLimit).toBe(32000);

      const detailRes = await app.fetch(
        new Request(`http://localhost:8048/v1beta/models/${targetModel}`)
      );
      expect(detailRes.status).toBe(200);
      const detailJson = (await detailRes.json()) as Record<string, unknown>;
      expect(detailJson.inputTokenLimit).toBe(500000);
      expect(detailJson.outputTokenLimit).toBe(32000);

      // 4. Passing null clears the fields and removes them from /v1beta/models
      const clearRes = await app.fetch(
        new Request(`http://localhost:8048/api/models/${encodeURIComponent(targetModel)}/limits`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputTokenLimit: null, outputTokenLimit: null }),
        })
      );
      expect(clearRes.status).toBe(200);
      const clearJson = (await clearRes.json()) as { ok: boolean; model: string; limits: null };
      expect(clearJson).toEqual({ ok: true, model: targetModel, limits: null });

      const afterListRes = await app.fetch(new Request('http://localhost:8048/v1beta/models'));
      const afterListJson = (await afterListRes.json()) as { models: Array<Record<string, unknown>> };
      const afterListed = afterListJson.models.find((m) => m.name === `models/${targetModel}`)!;
      expect('inputTokenLimit' in afterListed).toBe(false);
      expect('outputTokenLimit' in afterListed).toBe(false);

      // 5. Invalid values fail fast with 400
      for (const badBody of [
        { inputTokenLimit: -1 },
        { outputTokenLimit: 0 },
        { inputTokenLimit: 12.5 },
        { outputTokenLimit: '1000' },
      ]) {
        const badRes = await app.fetch(
          new Request(`http://localhost:8048/api/models/${encodeURIComponent(targetModel)}/limits`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(badBody),
          })
        );
        expect(badRes.status).toBe(400);
      }
    } finally {
      store.setConfigValue('model_limits', prevLimits);
    }
  });

  it('records upstream cold cachedTokens = 0 and warm cachedTokens without local estimation override', async () => {
    const account = makeAccount('acc-cache-hit');
    const mcpServer = new LoopbackMcpServer();
    let sessionCounter = 0;
    let promptCounter = 0;

    const worker = new AgySessionWorker({
      account,
      model: 'gemini-4-hydrogen-medium',
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: `sess-${++sessionCounter}` }),
        setModel: async () => ({}),
        prompt: async () => {
          promptCounter++;
          onUpdate({
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
            },
          });
          if (promptCounter === 1) {
            return {
              stopReason: 'end_turn',
              usage: {
                inputTokens: 120,
                cachedReadTokens: 0,
                outputTokens: 10,
                thoughtTokens: 0,
                totalTokens: 130,
              },
            };
          }
          return {
            stopReason: 'end_turn',
            usage: {
              inputTokens: 150,
              cachedReadTokens: 90,
              outputTokens: 30,
              thoughtTokens: 10,
              totalTokens: 180,
            },
          };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    const req1: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: 'Keep answers short.' }] },
      tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Look up a value' }] }],
      contents: [{ role: 'user', parts: [{ text: 'turn 1' }] }],
    };
    const res1 = await worker.executePrompt(req1);
    expect(res1.cacheHit).toBe(false);
    expect(res1.cachedTokens).toBe(0);
    expect(res1.usageMetadata).toEqual({
      promptTokenCount: 120,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 0,
      totalTokenCount: 130,
    });

    const req2: GeminiGenerateRequest = {
      systemInstruction: req1.systemInstruction,
      tools: req1.tools,
      contents: [
        { role: 'user', parts: [{ text: 'turn 1' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'turn 2' }] },
      ],
    };
    const res2 = await worker.executePrompt(req2);
    expect(res2.cacheHit).toBe(true);
    expect(res2.cachedTokens).toBe(90);
    expect(res2.usageMetadata).toEqual({
      promptTokenCount: 150,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 10,
      totalTokenCount: 180,
      cachedContentTokenCount: 90,
    });
    await worker.resetAndClose();

    // Verify worker result -> handler -> eventBus -> store passes upstream usage through untouched.
    let callCount = 0;
    const scheduler: SchedulerLike = {
      selectAccount: () => ({ account }),
    };
    const workerPool: WorkerPoolLike = {
      acquire: async (): Promise<WorkerHandle> => ({
        id: 'w-cache',
        accountId: account.id,
        generate: async () => {
          const result = callCount++ === 0 ? res1 : res2;
          return {
            candidates: [{ content: { role: 'model', parts: result.parts }, finishReason: 'STOP', index: 0 }],
            usageMetadata: result.usageMetadata,
            cacheHit: result.cacheHit,
            cachedTokens: result.cachedTokens,
          };
        },
      }),
      release: () => {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:generateContent');

    const httpRes1 = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req1),
      }),
      url
    );
    expect(httpRes1!.status).toBe(200);
    const body1 = (await httpRes1!.json()) as GeminiGenerateResponse & Record<string, unknown>;
    expect('cacheHit' in body1).toBe(false);
    expect('cachedTokens' in body1).toBe(false);
    expect(body1.usageMetadata).toEqual({
      promptTokenCount: 120,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 0,
      totalTokenCount: 130,
    });

    await Bun.sleep(2);

    const httpRes2 = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req2),
      }),
      url
    );
    expect(httpRes2!.status).toBe(200);
    const body2 = (await httpRes2!.json()) as GeminiGenerateResponse;
    expect('cacheHit' in body2).toBe(false);
    expect('cachedTokens' in body2).toBe(false);
    expect(body2.usageMetadata).toEqual({
      promptTokenCount: 150,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 10,
      totalTokenCount: 180,
      cachedContentTokenCount: 90,
    });

    const memLogs = eventBus.getRecentRequests(2);
    expect(memLogs[0]?.cacheHit).toBe(true);
    expect(memLogs[0]?.cachedTokens).toBe(90);
    expect(memLogs[0]?.inputTokens).toBe(150);
    expect(memLogs[0]?.outputTokens).toBe(20);
    expect(memLogs[1]?.cacheHit).toBe(false);
    expect(memLogs[1]?.cachedTokens).toBe(0);
    expect(memLogs[1]?.inputTokens).toBe(120);
    expect(memLogs[1]?.outputTokens).toBe(10);

    const dbLogs = store.getRecentRequestLogs(2);
    expect(dbLogs[0]?.cacheHit).toBe(true);
    expect(dbLogs[0]?.cachedTokens).toBe(90);
    expect(dbLogs[0]?.inputTokens).toBe(150);
    expect(dbLogs[0]?.outputTokens).toBe(20);
    expect(dbLogs[1]?.cacheHit).toBe(false);
    expect(dbLogs[1]?.cachedTokens).toBe(0);
    expect(dbLogs[1]?.inputTokens).toBe(120);
    expect(dbLogs[1]?.outputTokens).toBe(10);
  });

  it('leaves cachedTokens and cacheHit undefined in logs when worker omits usage (e.g. intermediate tool turn)', async () => {
    const account = makeAccount('acc-undefined-usage');
    const scheduler: SchedulerLike = {
      selectAccount: () => ({ account }),
    };
    const workerPool: WorkerPoolLike = {
      acquire: async (): Promise<WorkerHandle> => ({
        id: 'w-mid',
        accountId: account.id,
        generate: async () => ({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} } }],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: undefined,
          cacheHit: undefined,
          cachedTokens: undefined,
        }),
      }),
      release: () => {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    await Bun.sleep(2);
    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:generateContent');
    const httpRes = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'call tool' }] }] }),
      }),
      url
    );
    expect(httpRes!.status).toBe(200);
    const body = (await httpRes!.json()) as GeminiGenerateResponse;
    expect(body.usageMetadata?.cachedContentTokenCount).toBeUndefined();

    const memLog = eventBus.getRecentRequests(1)[0];
    expect(memLog?.cachedTokens).toBeUndefined();
    expect(memLog?.cacheHit).toBeUndefined();

    const dbLog = store.getRecentRequestLogs(1)[0];
    expect(dbLog?.cachedTokens).toBeUndefined();
    expect(dbLog?.cacheHit).toBeUndefined();
  });

  it.each(['upstream EOF', 'socket hang up'])(
    'switches to next available account on retryable network transient error: %s',
    async (errorMessage) => {
      const acc1 = makeAccount('acc-transient-1');
      const acc2 = makeAccount('acc-transient-2');
      const accounts = [acc1, acc2];

      const scheduler: SchedulerLike = {
        selectAccount: ({ excludeAccountIds }) => {
          const available = accounts.find((a) => !excludeAccountIds?.includes(a.id));
          return { account: available ?? null };
        },
      };

      let attempt = 0;
      const workerPool: WorkerPoolLike = {
        acquire: async ({ account }): Promise<WorkerHandle> => ({
          id: `w-${account.id}`,
          accountId: account.id,
          generate: async () => {
            attempt++;
            if (account.id === acc1.id) {
              throw new Error(errorMessage);
            }
            return {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'recovered after network drop' }] },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
            };
          },
        }),
        release: () => {},
      };

      const handler = createGeminiHandler({ scheduler, workerPool });
      const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:generateContent');
      const req = new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        }),
      });

      const res = await handler(req, url);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const json = (await res!.json()) as GeminiGenerateResponse;
      expect(json.candidates?.[0]?.content?.parts?.[0]?.text).toBe('recovered after network drop');
      expect(attempt).toBe(2);
    }
  );

  it('extracts x-session-id / x-thread-id / x-claude-code-agent-id case-insensitively and isolates subagent sessionHash', async () => {
    const acc = makeAccount('acc-subagent-1');
    const seenSessionHashes: string[] = [];
    const seenSuccessUsages: Array<{ sessionHash: string; inputTokens?: number; cachedTokens?: number }> = [];

    const scheduler: SchedulerLike = {
      selectAccount: ({ sessionHash }) => {
        seenSessionHashes.push(sessionHash);
        return { account: acc };
      },
      reportSuccess: (_accountId, _family, sessionHash, usage) => {
        seenSuccessUsages.push({
          sessionHash,
          inputTokens: usage?.inputTokens,
          cachedTokens: usage?.cachedTokens,
        });
      },
    };

    const workerPool: WorkerPoolLike = {
      acquire: async ({ account, sessionHash }): Promise<WorkerHandle> => ({
        id: `w-${account.id}-${sessionHash}`,
        accountId: account.id,
        generate: async () => ({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'ok' }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 10 },
          cachedTokens: 0,
        }),
      }),
      release: () => {},
    };

    const handler = createGeminiHandler({ scheduler, workerPool });
    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:generateContent');
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'same body' }] }],
    });

    // Main agent with mixed-case X-Session-Id
    const resMain = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'sess-alpha' },
        body,
      }),
      url
    );
    expect(resMain?.status).toBe(200);
    expect(resMain?.headers.get('X-Session-Id')).toBe('sess-alpha');

    // Subagent with same X-Session-Id + X-Claude-Code-Agent-Id
    const resSub = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SESSION-ID': 'sess-alpha',
          'X-Claude-Code-Agent-Id': 'sub-42',
        },
        body,
      }),
      url
    );
    expect(resSub?.status).toBe(200);
    expect(resSub?.headers.get('X-Session-Id')).toBe('sess-alpha|agent:sub-42');

    // Thread fallback with X-Thread-Id + subagent
    const resThread = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Thread-Id': 'thread-99',
          'x-claude-code-agent-id': 'sub-7',
        },
        body,
      }),
      url
    );
    expect(resThread?.status).toBe(200);
    expect(resThread?.headers.get('X-Session-Id')).toBe('thread-99|agent:sub-7');

    expect(seenSessionHashes).toEqual([
      'sess-alpha',
      'sess-alpha|agent:sub-42',
      'thread-99|agent:sub-7',
    ]);
    expect(seenSuccessUsages).toEqual([
      { sessionHash: 'sess-alpha', inputTokens: 1500, cachedTokens: 0 },
      { sessionHash: 'sess-alpha|agent:sub-42', inputTokens: 1500, cachedTokens: 0 },
      { sessionHash: 'thread-99|agent:sub-7', inputTokens: 1500, cachedTokens: 0 },
    ]);
  });

  it('does not replay across accounts on pre-first-chunk TIMEOUT and returns 504', async () => {
    const accounts = [makeAccount('acc-timeout-1'), makeAccount('acc-timeout-2')];
    const selectedAccounts: string[] = [];
    const failedAccounts: Array<{ accountId: string; status?: number; reasonCode?: string }> = [];

    const handler = createGeminiHandler({
      scheduler: {
        selectAccount: ({ excludeAccountIds }) => {
          const next = accounts.find((a) => !excludeAccountIds.includes(a.id)) ?? null;
          if (next) selectedAccounts.push(next.id);
          return { account: next };
        },
        reportFailure: (params) => {
          failedAccounts.push({
            accountId: params.accountId,
            status: params.status,
            reasonCode: params.reasonCode,
          });
        },
      },
      workerPool: {
        acquire: async ({ account }) => ({
          id: `w-${account.id}`,
          accountId: account.id,
          generate: async () => {
            throw new WorkerError('First event timed out during prefill', {
              code: 'TIMEOUT',
              upstreamStatus: 504,
            });
          },
        }),
        release: () => {},
      },
    });

    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:streamGenerateContent?alt=sse');
    const res = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'huge context' }] }] }),
      }),
      url,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(504);
    const body = (await res!.json()) as { error?: { code?: number; status?: string; message?: string } };
    expect(body.error?.code).toBe(504);
    expect(body.error?.status).toBe('TIMEOUT');
    expect(selectedAccounts).toEqual(['acc-timeout-1']);
    expect(failedAccounts).toEqual([
      { accountId: 'acc-timeout-1', status: 504, reasonCode: 'TIMEOUT' },
    ]);
  });

  it.each(['generateContent', 'streamGenerateContent'])('reports rejected model selection without switching accounts (%s)', async (action) => {
    const account = makeAccount(`model-selection-${action}`);
    let selections = 0;
    let failures = 0;
    const workerError = Object.assign(new WorkerError('ACP could not switch to the requested model', {
      code: 'MODEL_SELECTION_FAILED',
      rawError: 'Unsupported model',
    }), {
      timings: { setModelMs: 7, initializeMs: 12 },
      modelSelection: { confirmedModel: 'gemini-3.8-flash-high' },
    });
    const handler = createGeminiHandler({
      scheduler: {
        selectAccount: () => ({ account: selections++ === 0 ? account : null }),
        reportFailure: () => { failures++; },
      },
      workerPool: {
        acquire: async () => ({
          id: 'rejected-model', accountId: account.id,
          generate: async () => { throw workerError; },
        }),
        release: () => {},
      },
    });
    const url = new URL(`http://localhost:8048/v1beta/models/gemini-4-hydrogen:${action}`);
    const response = await handler(new Request(url, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    }), url);
    expect(response?.status).toBe(502);
    expect(await response!.json()).toMatchObject({ error: { status: 'MODEL_SELECTION_FAILED' } });
    expect(selections).toBe(1);
    expect(failures).toBe(0);
    const log = store.getRecentRequestLogs(100).find((item) => item.attempts.some((attempt) => attempt.accountId === account.id));
    expect(log?.attempts[0]).toMatchObject({
      requestedModel: 'gemini-4-hydrogen',
      confirmedModel: 'gemini-3.8-flash-high',
      outcome: 'failed',
      rawError: 'Unsupported model',
    });
    expect(log?.attempts[0]?.phaseTimingsMs.setModelMs).toBe(7);
  });

  it.each(['generateContent', 'streamGenerateContent'])('switches to the next account when one account reports Unknown model ID (%s)', async (action) => {
    const missingModelAccount = makeAccount(`model-missing-${action}`);
    const healthyAccount = makeAccount(`model-ok-${action}`);
    const queue = [missingModelAccount, healthyAccount];
    let acquires = 0;
    const handler = createGeminiHandler({
      scheduler: {
        selectAccount: () => {
          const next = queue.shift();
          return { account: next ?? null };
        },
        reportFailure: () => {},
      },
      workerPool: {
        acquire: async () => {
          const call = acquires++;
          return {
            id: `w-model-${call}`,
            accountId: call === 0 ? missingModelAccount.id : healthyAccount.id,
            generate: async () => {
              if (call === 0) {
                throw new WorkerError('ACP could not switch to the requested model gemini-4-hydrogen-medium', {
                  code: 'MODEL_SELECTION_FAILED',
                  rawError: 'Unknown model ID: gemini-4-hydrogen-medium',
                });
              }
              return {
                candidates: [
                  {
                    content: { role: 'model', parts: [{ text: 'ok' }] },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
                modelSelection: { confirmedModel: 'gemini-4-hydrogen-medium', modelSelectionAcknowledged: true },
              } as GeminiGenerateResponse;
            },
          } as WorkerHandle;
        },
        release: () => {},
      },
    });
    const url = new URL(`http://localhost:8048/v1beta/models/gemini-4-hydrogen:${action}`);
    const response = await handler(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      }),
      url,
    );
    expect(response?.status).toBe(200);
    expect(acquires).toBe(2);
  });

  it('merges worker timings into attempt phaseTimingsMs without leaking timings in response', async () => {
    const account = makeAccount('acc-timings');
    const handler = createGeminiHandler({
      scheduler: { selectAccount: () => ({ account }) },
      workerPool: {
        acquire: async () => ({
          id: 'w-timings',
          accountId: account.id,
          generate: async () => ({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'ok' }] },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
            modelSelection: { confirmedModel: 'gemini-4-hydrogen-medium', modelSelectionAcknowledged: true },
            timings: {
              spawnMs: 12,
              initializeMs: 34,
              sessionSetupMs: 56,
              setModelMs: 7,
              promptToFirstEventMs: 89,
              coldStart: true,
              sessionResumed: false,
            },
          }),
        }),
        release: () => {},
      },
    });

    const url = new URL('http://localhost:8048/v1beta/models/gemini-4-hydrogen-medium:generateContent');
    const res = await handler(
      new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      }),
      url,
    );

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as GeminiGenerateResponse;
    expect('timings' in body).toBe(false);
    expect('modelSelection' in body).toBe(false);

    const log = store.getRecentRequestLogs(100).find((item) => `resp_${item.id}` === body.responseId);
    expect(log?.attempts[0]).toMatchObject({
      requestedModel: 'gemini-4-hydrogen-medium',
      confirmedModel: 'gemini-4-hydrogen-medium',
      modelSelectionAcknowledged: true,
    });
    expect(log!.attempts[0]?.phaseTimingsMs).toMatchObject({
      spawnMs: 12,
      initializeMs: 34,
      sessionSetupMs: 56,
      setModelMs: 7,
      promptToFirstEventMs: 89,
      coldStart: true,
      sessionResumed: false,
    });
  });
});

describe('gemini-4-neon dynamic thinking depth routing', () => {
  it.each([
    // thinkingLevel (case-insensitive)
    { options: { thinkingConfig: { thinkingLevel: 'LOW' } }, expected: 'gemini-4-neon-low' },
    { options: { thinkingConfig: { thinkingLevel: 'MEDIUM' } }, expected: 'gemini-4-neon-medium' },
    { options: { thinkingConfig: { thinkingLevel: 'HIGH' } }, expected: 'gemini-4-neon-high' },
    { options: { thinkingConfig: { thinkingLevel: 'xhigh' } }, expected: 'gemini-4-neon-xhigh' },
    { options: { thinkingConfig: { thinkingLevel: 'off' } }, expected: 'gemini-4-neon-low' },
    { options: { thinkingConfig: { thinkingLevel: 'none' } }, expected: 'gemini-4-neon-low' },
    { options: { thinkingConfig: { thinkingLevel: 'minimal' } }, expected: 'gemini-4-neon-low' },
    { options: { thinkingConfig: { thinkingLevel: 'max' } }, expected: 'gemini-4-neon-xhigh' },
    { options: { thinkingConfig: { thinkingLevel: 'extra_high' } }, expected: 'gemini-4-neon-xhigh' },
    // includeThoughts === false
    { options: { thinkingConfig: { includeThoughts: false } }, expected: 'gemini-4-neon-low' },
    // thinkingBudget thresholds
    { options: { thinkingConfig: { thinkingBudget: 0 } }, expected: 'gemini-4-neon-low' },
    { options: { thinkingConfig: { thinkingBudget: 1024 } }, expected: 'gemini-4-neon-low' },
    { options: { thinkingConfig: { thinkingBudget: 8192 } }, expected: 'gemini-4-neon-medium' },
    { options: { thinkingConfig: { thinkingBudget: 24576 } }, expected: 'gemini-4-neon-high' },
    { options: { thinkingConfig: { thinkingBudget: 32000 } }, expected: 'gemini-4-neon-xhigh' },
    { options: { thinkingConfig: { thinkingBudget: -1 } }, expected: 'gemini-4-neon-medium' },
    // reasoningEffort (takes precedence over thinkingConfig)
    { options: { reasoningEffort: 'low', thinkingConfig: { thinkingBudget: 24576 } }, expected: 'gemini-4-neon-low' },
    { options: { reasoningEffort: 'medium' }, expected: 'gemini-4-neon-medium' },
    { options: { reasoningEffort: 'high' }, expected: 'gemini-4-neon-high' },
    { options: { reasoningEffort: 'xhigh', thinkingConfig: { thinkingBudget: 24576 } }, expected: 'gemini-4-neon-xhigh' },
    { options: { reasoningEffort: 'none' }, expected: 'gemini-4-neon-low' },
    { options: { reasoningEffort: 'minimal' }, expected: 'gemini-4-neon-low' },
    // default fallback
    { options: undefined, expected: 'gemini-4-neon-medium' },
    { options: {}, expected: 'gemini-4-neon-medium' },
  ])('resolves gemini-4-neon with $options -> $expected', ({ options, expected }) => {
    expect(resolveGatewayModel('gemini-4-neon', options)).toBe(expected);
    expect(resolveGatewayModel('models/gemini-4-neon', options)).toBe(expected);
  });

  it('keeps other models unchanged regardless of thinking options', () => {
    const opts = { reasoningEffort: 'xhigh', thinkingConfig: { thinkingLevel: 'low' } };
    expect(resolveGatewayModel('gemini-4-hydrogen', opts)).toBe('gemini-4-hydrogen-medium');
    expect(resolveGatewayModel('gemini-4-hydrogen-high', opts)).toBe('gemini-4-hydrogen-high');
    expect(resolveGatewayModel('gemini-4-argon-low', opts)).toBe('gemini-4-argon-low');
    expect(resolveGatewayModel('gemini-4-neon-high', opts)).toBe('gemini-4-neon-high');
    expect(resolveGatewayModel('claude-sonnet-5-5-medium', opts)).toBe('claude-sonnet-5-5-medium');
  });

  it('exposes models/gemini-4-neon in GET /v1beta/models and GET /v1beta/models/gemini-4-neon', async () => {
    const handler = createGeminiHandler();
    const listUrl = new URL('http://localhost:8048/v1beta/models');
    const listRes = await handler(new Request(listUrl.toString()), listUrl);
    expect(listRes?.status).toBe(200);
    const listJson = (await listRes!.json()) as { models: Array<{ name: string }> };
    const names = listJson.models.map((m) => m.name);
    expect(names).toContain('models/gemini-4-neon');
    expect(names).toContain('models/gemini-4-neon-low');
    expect(names).toContain('models/gemini-4-neon-medium');
    expect(names).toContain('models/gemini-4-neon-high');
    expect(names).toContain('models/gemini-4-neon-xhigh');

    const detailUrl = new URL('http://localhost:8048/v1beta/models/gemini-4-neon');
    const detailRes = await handler(new Request(detailUrl.toString()), detailUrl);
    expect(detailRes?.status).toBe(200);
    const detailJson = (await detailRes!.json()) as { name: string };
    expect(detailJson.name).toBe('models/gemini-4-neon');
  });

  it('routes Gemini POST /v1beta/models/gemini-4-neon:generateContent by thinkingConfig', async () => {
    const capturedModels: string[] = [];
    const account = makeAccount('acc-neon-gemini');
    const handler = createGeminiHandler({
      scheduler: { selectAccount: () => ({ account }) },
      workerPool: {
        acquire: async (params) => {
          capturedModels.push(params.model);
          return {
            id: 'w-neon-gemini',
            accountId: account.id,
            generate: async () => ({
              candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 }],
            }),
          };
        },
        release: () => {},
      },
    });

    const cases = [
      { thinkingConfig: { thinkingLevel: 'LOW' }, expected: 'gemini-4-neon-low' },
      { thinkingConfig: { thinkingLevel: 'HIGH' }, expected: 'gemini-4-neon-high' },
      { thinkingConfig: { thinkingBudget: 32000 }, expected: 'gemini-4-neon-xhigh' },
      { thinkingConfig: undefined, expected: 'gemini-4-neon-medium' },
    ];

    for (const c of cases) {
      const url = new URL('http://localhost:8048/v1beta/models/gemini-4-neon:generateContent');
      const res = await handler(
        new Request(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
            ...(c.thinkingConfig ? { generationConfig: { thinkingConfig: c.thinkingConfig } } : {}),
          }),
        }),
        url,
      );
      expect(res?.status).toBe(200);
      const body = (await res!.json()) as GeminiGenerateResponse;
      expect(body.modelVersion).toBe(c.expected);
    }

    expect(capturedModels).toEqual(cases.map((c) => c.expected));
  });

  it('routes OpenAI POST /v1/chat/completions for gemini-4-neon by reasoning_effort', async () => {
    const capturedModels: string[] = [];
    const account = makeAccount('acc-neon-openai');
    const handler = createOpenAiHandler({
      scheduler: { selectAccount: () => ({ account }) },
      workerPool: {
        acquire: async (params) => {
          capturedModels.push(params.model);
          return {
            id: 'w-neon-openai',
            accountId: account.id,
            generate: async () => ({
              candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 }],
            }),
          };
        },
        release: () => {},
      },
    });

    const efforts: Array<{ effort?: string; expected: string }> = [
      { effort: 'low', expected: 'gemini-4-neon-low' },
      { effort: 'medium', expected: 'gemini-4-neon-medium' },
      { effort: 'high', expected: 'gemini-4-neon-high' },
      { effort: 'xhigh', expected: 'gemini-4-neon-xhigh' },
      { effort: undefined, expected: 'gemini-4-neon-medium' },
    ];

    for (const item of efforts) {
      const url = new URL('http://localhost:8048/v1/chat/completions');
      const res = await handler(
        new Request(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-neon',
            messages: [{ role: 'user', content: 'OK' }],
            ...(item.effort ? { reasoning_effort: item.effort } : {}),
          }),
        }),
        url,
      );
      expect(res?.status).toBe(200);
      expect(res?.headers.get('X-Mapped-Model')).toBe(item.expected);
    }

    expect(capturedModels).toEqual(efforts.map((e) => e.expected));
  });

  it('routes Anthropic POST /v1/messages for gemini-4-neon by thinking config', async () => {
    const capturedModels: string[] = [];
    const account = makeAccount('acc-neon-anthropic');
    const handler = createAnthropicHandler({
      scheduler: { selectAccount: () => ({ account }) },
      workerPool: {
        acquire: async (params) => {
          capturedModels.push(params.model);
          return {
            id: 'w-neon-anthropic',
            accountId: account.id,
            generate: async () => ({
              candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 }],
            }),
          };
        },
        release: () => {},
      },
    });

    const cases: Array<{ thinking?: Record<string, unknown>; expected: string }> = [
      { thinking: { type: 'disabled' }, expected: 'gemini-4-neon-low' },
      { thinking: { type: 'enabled', budget_tokens: 1024 }, expected: 'gemini-4-neon-low' },
      { thinking: { type: 'enabled', budget_tokens: 8192 }, expected: 'gemini-4-neon-medium' },
      { thinking: { type: 'enabled', budget_tokens: 24576 }, expected: 'gemini-4-neon-high' },
      { thinking: { type: 'enabled', budget_tokens: 32000 }, expected: 'gemini-4-neon-xhigh' },
      { thinking: undefined, expected: 'gemini-4-neon-medium' },
    ];

    for (const c of cases) {
      const url = new URL('http://localhost:8048/v1/messages');
      const res = await handler(
        new Request(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-4-neon',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'OK' }],
            ...(c.thinking ? { thinking: c.thinking } : {}),
          }),
        }),
        url,
      );
      expect(res?.status).toBe(200);
      expect(res?.headers.get('X-Mapped-Model')).toBe(c.expected);
    }

    expect(capturedModels).toEqual(cases.map((c) => c.expected));
  });
});

describe('agy models dynamic catalog replacement', () => {
  it('parses id\\tDisplay Name lines while preserving order, deduplicating, and ignoring non-model lines', () => {
    const raw = [
      '',
      '# Available models',
      'Fetching models...',
      'Fetching...',
      'Model ID\tDisplay Name',
      '---',
      'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
      'models/gemini-4-neon-medium\tGemini 4 Neon (Medium)',
      'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
      'claude-sonnet-5-5-high\tClaude Sonnet 5.5 High',
      '   ',
    ].join('\n');

    expect(parseAgyModelsOutput(raw)).toEqual([
      'gemini-4-hydrogen-medium',
      'gemini-4-neon-medium',
      'claude-sonnet-5-5-high',
    ]);
  });

  it('replaces static catalog with live upstream list and drops delisted gemini-4-argon-* models', async () => {
    resetModelCatalogCacheForTest();
    try {
      await refreshModelCatalogOnce(async () => [
        'gemini-4-hydrogen-medium',
        'claude-sonnet-5-5-high',
      ]);

      const models = await discoverAgyModels();
      const names = models.map((m) => m.name);
      expect(names).toEqual([
        'models/gemini-4-hydrogen-medium',
        'models/claude-sonnet-5-5-high',
      ]);
      expect(names.some((name) => name.includes('gemini-4-argon'))).toBe(false);

      const handler = createGeminiHandler({});
      const listUrl = new URL('http://localhost:8048/v1beta/models');
      const listRes = await handler(new Request(listUrl.toString()), listUrl);
      expect(listRes?.status).toBe(200);
      const listJson = (await listRes!.json()) as { models: Array<{ name: string }> };
      expect(listJson.models.map((m) => m.name)).toEqual([
        'models/gemini-4-hydrogen-medium',
        'models/claude-sonnet-5-5-high',
      ]);

      const delistedUrl = new URL('http://localhost:8048/v1beta/models/gemini-4-argon-medium');
      const delistedRes = await handler(new Request(delistedUrl.toString()), delistedUrl);
      expect(delistedRes?.status).toBe(404);
    } finally {
      setModelsFetcherForTest(null);
      resetModelCatalogCacheForTest();
    }
  });

  it('falls back to static catalog on empty/failed initial fetch and preserves existing cache on subsequent failures', async () => {
    resetModelCatalogCacheForTest();
    try {
      // 1. Initial failure -> static fallback
      await refreshModelCatalogOnce(async () => {
        throw new Error('agy.exe failed');
      });
      const fallbackOnError = await discoverAgyModels();
      expect(fallbackOnError.map((m) => m.name)).toEqual(
        SUPPORTED_GEMINI_MODELS.map((m) => m.name),
      );

      // 2. Initial empty list -> static fallback
      resetModelCatalogCacheForTest();
      await refreshModelCatalogOnce(async () => []);
      const fallbackOnEmpty = await discoverAgyModels();
      expect(fallbackOnEmpty.map((m) => m.name)).toEqual(
        SUPPORTED_GEMINI_MODELS.map((m) => m.name),
      );

      // 3. Successful refresh followed by empty/failed refresh -> keep previous live cache
      await refreshModelCatalogOnce(async () => ['gemini-4-hydrogen-high']);
      await refreshModelCatalogOnce(async () => []);
      await refreshModelCatalogOnce(async () => {
        throw new Error('temporary timeout');
      });
      const preserved = await discoverAgyModels();
      expect(preserved.map((m) => m.name)).toEqual(['models/gemini-4-hydrogen-high']);
    } finally {
      setModelsFetcherForTest(null);
      resetModelCatalogCacheForTest();
    }
  });

  it('auto-adds bare models/gemini-4-neon when upstream returns gemini-4-neon-* variants without bare entry', async () => {
    resetModelCatalogCacheForTest();
    try {
      await refreshModelCatalogOnce(async () => [
        'gemini-4-hydrogen-medium',
        'gemini-4-neon-medium',
      ]);

      const models = await discoverAgyModels();
      expect(models.map((m) => m.name)).toEqual([
        'models/gemini-4-hydrogen-medium',
        'models/gemini-4-neon-medium',
        'models/gemini-4-neon',
      ]);
    } finally {
      setModelsFetcherForTest(null);
      resetModelCatalogCacheForTest();
    }
  });

  it('keeps discoverAgyModels non-blocking when upstream fetcher hangs', async () => {
    resetModelCatalogCacheForTest();
    try {
      setModelsFetcherForTest(() => new Promise<string[]>(() => {}));
      const started = Date.now();
      const models = await discoverAgyModels(true);
      const elapsedMs = Date.now() - started;

      expect(elapsedMs).toBeLessThan(200);
      expect(models.length).toBe(SUPPORTED_GEMINI_MODELS.length);
    } finally {
      setModelsFetcherForTest(null);
      resetModelCatalogCacheForTest();
    }
  });
});

