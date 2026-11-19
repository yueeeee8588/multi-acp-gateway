import { afterEach, describe, expect, it } from 'bun:test';
import { WorkerError } from '../src/acp/worker';
import {
  AnthropicProtocolError,
  AnthropicStreamSerializer,
  convertAnthropicToGeminiRequest,
  convertGeminiToAnthropicResponse,
  resolveAnthropicSessionKey,
} from '../src/anthropic/protocol';
import { invalidateConfigCache, getConfig, updateConfig } from '../src/config/settings';
import { store } from '../src/db/store';
import { getModelFamily, resolveGatewayModel } from '../src/gemini/protocol';
import type { SchedulerLike, WorkerPoolLike } from '../src/gemini/handler';
import { eventBus } from '../src/logs/events';
import { createApp } from '../src/server';
import type { AccountRecord, GatewayConfig, GeminiGenerateRequest, GeminiGenerateResponse } from '../src/types';

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
    tier: 'pro',
    statusReason: '',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 1,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function parseSseEvents(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const blocks = raw.split(/\n\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let event = '';
    let dataLine = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine = line.slice(5).trim();
      }
    }
    if (event && dataLine) {
      events.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
    }
  }
  return events;
}

describe('Anthropic protocol conversion', () => {
  it('converts system, messages, thinking, redacted_thinking, base64 image, tool_use/tool_result, tools, and generationConfig', () => {
    const converted = convertAnthropicToGeminiRequest({
      model: 'claude-opus-5-5-high',
      max_tokens: 2048,
      temperature: 0.4,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['STOP_HERE'],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      system: [
        { type: 'text', text: 'System A', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'System B' },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
        {
          type: 'bash_20250124',
          name: 'bash',
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need weather' },
            { type: 'redacted_thinking', data: 'opaque' },
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'get_weather',
              input: { city: 'Tokyo' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: [{ type: 'text', text: 'Sunny 22C' }],
              is_error: true,
            },
          ],
        },
      ],
    });

    expect(converted.requestedModel).toBe('claude-opus-5-5-high');
    expect(converted.geminiRequest.systemInstruction).toEqual({
      parts: [{ text: 'System A' }, { text: 'System B' }],
    });
    expect(converted.geminiRequest.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Look at this' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'Need weather', thought: true },
          {
            functionCall: {
              id: 'toolu_123',
              name: 'get_weather',
              args: { city: 'Tokyo' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'toolu_123',
              name: 'get_weather',
              response: {
                content: 'Sunny 22C',
                is_error: true,
              },
            },
          },
        ],
      },
    ]);
    expect(converted.geminiRequest.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
    ]);
    expect(converted.geminiRequest.generationConfig).toEqual({
      maxOutputTokens: 2048,
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      stopSequences: ['STOP_HERE'],
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 1024,
      },
    });
  });

  it('validates max_tokens, non-empty messages, image source.type, and image count limit', () => {
    expect(() =>
      convertAnthropicToGeminiRequest({
        model: 'claude-sonnet-5-5-medium',
        max_tokens: 0,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).toThrow(AnthropicProtocolError);

    expect(() =>
      convertAnthropicToGeminiRequest({
        model: 'claude-sonnet-5-5-medium',
        max_tokens: 100,
        messages: [],
      })
    ).toThrow(AnthropicProtocolError);

    expect(() =>
      convertAnthropicToGeminiRequest({
        model: 'claude-sonnet-5-5-medium',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.com/a.png' },
              },
            ],
          },
        ],
      })
    ).toThrow(AnthropicProtocolError);

    expect(() =>
      convertAnthropicToGeminiRequest(
        {
          model: 'claude-sonnet-5-5-medium',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'abc' },
                },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'def' },
                },
              ],
            },
          ],
        },
        { maxImagesPerRequest: 1 }
      )
    ).toThrow(AnthropicProtocolError);
  });

  it('resolves session key with header priority, agent isolation, metadata.user_id, and hash fallback', () => {
    const req: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    };

    expect(
      resolveAnthropicSessionKey(
        req,
        new Headers({
          'X-Session-Id': 'sess-1',
          'x-thread-id': 'thread-1',
          'X-Claude-Code-Agent-Id': 'sub-9',
        }),
        'user-42'
      )
    ).toBe('sess-1|agent:sub-9');

    expect(
      resolveAnthropicSessionKey(req, new Headers({ 'x-thread-id': 'thread-1' }), 'user-42')
    ).toBe('thread-1');

    expect(resolveAnthropicSessionKey(req, new Headers(), 'user-42')).toBe('user-42');

    const fallback = resolveAnthropicSessionKey(req, new Headers());
    expect(fallback).toHaveLength(24);
  });

  it('merges adjacent thinking/text blocks, maps stop_reason, and preserves cache_read_input_tokens', () => {
    const req: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    };
    const resp = convertGeminiToAnthropicResponse(
      {
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [
                { text: 'step 1 ', thought: true },
                { text: 'step 2', thought: true },
                { text: 'hello ' },
                { text: 'world' },
                { functionCall: { id: 'toolu_1', name: 'search', args: { q: 'test' } } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 15,
          cachedContentTokenCount: 80,
        },
      },
      req,
      'claude-opus-5-5-high',
      'msg_test_1'
    );

    expect(resp).toEqual({
      id: 'msg_test_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5-high',
      content: [
        { type: 'thinking', thinking: 'step 1 step 2' },
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'test' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 45,
        cache_read_input_tokens: 80,
      },
    });
  });

  it('subtracts cache_read_input_tokens from input_tokens, clamps overflow, and passes through cache_creation_input_tokens', () => {
    const req: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    };

    const withWrite = convertGeminiToAnthropicResponse(
      {
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 10,
          cachedContentTokenCount: 150,
          cacheCreationTokenCount: 35,
        },
      },
      req,
      'claude-opus-5-5-high',
      'msg_cache_write'
    );
    expect(withWrite.usage).toEqual({
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 35,
    });

    const clamped = convertGeminiToAnthropicResponse(
      {
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 140,
        },
      },
      req,
      'claude-opus-5-5-high',
      'msg_cache_clamp'
    );
    expect(clamped.usage).toEqual({
      input_tokens: 0,
      output_tokens: 5,
      cache_read_input_tokens: 100,
    });

    const serializer = new AnthropicStreamSerializer('msg_sse_cache', 'claude-sonnet-5-5-high');
    const raw =
      serializer.startMessage(10) +
      serializer.processChunk({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      }) +
      serializer.finishMessage(req, 'STOP', {
        promptTokenCount: 200,
        candidatesTokenCount: 10,
        cachedContentTokenCount: 120,
        cacheCreationTokenCount: 25,
      });
    const events = parseSseEvents(raw);
    const deltaEvent = events.find((e) => e.event === 'message_delta');
    expect(deltaEvent?.data.usage).toEqual({
      input_tokens: 80,
      output_tokens: 10,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 25,
    });
  });

  it('serializes SSE stream events in strict Anthropic order', () => {
    const req: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    };
    const serializer = new AnthropicStreamSerializer('msg_sse_1', 'claude-sonnet-5-5-high');
    const raw =
      serializer.startMessage(10) +
      serializer.processChunk({
        candidates: [{ content: { role: 'model', parts: [{ text: 'think...', thought: true }] } }],
      }) +
      serializer.processChunk({
        candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }],
      }) +
      serializer.processChunk({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'toolu_abc', name: 'ping', args: { host: '1.1.1.1' } } }],
            },
          },
        ],
      }) +
      serializer.finishMessage(req, 'STOP', {
        promptTokenCount: 10,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 2,
      });

    const events = parseSseEvents(raw);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect((events[2]!.data.delta as { type: string }).type).toBe('thinking_delta');
    expect((events[5]!.data.delta as { type: string }).type).toBe('text_delta');
    expect((events[8]!.data.delta as { type: string }).type).toBe('input_json_delta');
    expect((events[10]!.data.delta as { stop_reason: string }).stop_reason).toBe('tool_use');
  });

  it('recognizes claude model family and preserves claude-*-5-5-* model mapping', () => {
    expect(getModelFamily('claude-opus-5-5-high')).toBe('claude');
    expect(getModelFamily('claude-sonnet-5-5-medium')).toBe('claude');
    expect(resolveGatewayModel('claude-opus-5-5-high')).toBe('claude-opus-5-5-high');
    expect(resolveGatewayModel('claude-sonnet-5-5-medium')).toBe('claude-sonnet-5-5-medium');
  });
});

describe('Anthropic HTTP handler & server integration', () => {
  const previousConfig = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');

  afterEach(() => {
    if (previousConfig) {
      store.setConfigValue('gateway_config', previousConfig);
    } else {
      updateConfig({ apiKey: '' });
    }
    invalidateConfigCache();
  });

  it('enforces x-api-key and Authorization Bearer auth when apiKey is configured', async () => {
    updateConfig({ apiKey: 'anthro-secret-key' });
    const app = createApp({
      geminiDeps: {
        scheduler: { selectAccount: () => ({ account: null }) },
        workerPool: {
          acquire: async () => {
            throw new Error('not called');
          },
          release: () => {},
        },
      },
    });

    const unauth = await app.fetch(new Request('http://localhost:8048/v1/models'));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid or missing API key',
      },
    });

    const withXApiKey = await app.fetch(
      new Request('http://localhost:8048/v1/models', {
        headers: { 'x-api-key': 'anthro-secret-key' },
      })
    );
    expect(withXApiKey.status).toBe(200);
    const modelsBody = (await withXApiKey.json()) as {
      data: Array<{ id: string; type: string; display_name: string; created_at: string }>;
      has_more: boolean;
    };
    expect(modelsBody.has_more).toBe(false);
    expect(modelsBody.data.some((m) => m.id === 'claude-opus-5-5-high' && m.type === 'model')).toBe(
      true
    );

    const withBearer = await app.fetch(
      new Request('http://localhost:8048/v1/messages/count_tokens', {
        method: 'POST',
        headers: { Authorization: 'Bearer anthro-secret-key' },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5-medium',
          messages: [{ role: 'user', content: 'Count these tokens' }],
        }),
      })
    );
    expect(withBearer.status).toBe(200);
    const countBody = (await withBearer.json()) as { input_tokens: number };
    expect(countBody.input_tokens).toBeGreaterThan(0);
  });

  it('handles non-streaming and streaming /v1/messages with pre-stream account retry and eventBus logging', async () => {
    updateConfig({ apiKey: '' });
    const acc1 = makeAccount('acc-1');
    const acc2 = makeAccount('acc-2');
    const accounts = [acc1, acc2];
    const events: string[] = [];
    const decoder = new TextDecoder();
    const fakeController = {
      enqueue(chunk: Uint8Array) {
        const text = decoder.decode(chunk);
        const match = /^event:\s*(\S+)/m.exec(text);
        if (match && (match[1] === 'request:start' || match[1] === 'request:attempt' || match[1] === 'request:finish')) {
          events.push(match[1]);
        }
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    eventBus.subscribe(fakeController);

    const scheduler: SchedulerLike = {
      selectAccount({ excludeAccountIds }) {
        const next = accounts.find((a) => !excludeAccountIds.includes(a.id)) ?? null;
        return { account: next };
      },
    };

    let attempt = 0;
    const inFlightControllers = new Map<string, AbortController>();
    const workerPool: WorkerPoolLike = {
      async acquire({ account }) {
        return {
          id: `w:${account.id}`,
          accountId: account.id,
          async generate({ onChunk }) {
            attempt += 1;
            if (attempt === 1) {
              throw new WorkerError('SOFT_ERROR', 'Transient upstream EOF', {
                upstreamStatus: 502,
              });
            }
            onChunk?.({
              candidates: [{ content: { role: 'model', parts: [{ text: 'Thinking...', thought: true }] } }],
            });
            onChunk?.({
              candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from Claude!' }] } }],
            });
            return {
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      { text: 'Thinking...', thought: true },
                      { text: 'Hello from Claude!' },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 25,
                candidatesTokenCount: 10,
                thoughtsTokenCount: 5,
              },
            };
          },
        };
      },
      release() {},
    };

    try {
      const app = createApp({
        geminiDeps: { scheduler, workerPool, inFlightControllers },
      });

      const streamRes = await app.fetch(
        new Request('http://localhost:8048/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-5-5-high',
            max_tokens: 1024,
            stream: true,
            messages: [{ role: 'user', content: 'Say hi' }],
          }),
        })
      );

      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
      const sseText = await streamRes.text();
      const parsed = parseSseEvents(sseText);
      expect(parsed[0]?.event).toBe('message_start');
      expect(parsed[parsed.length - 1]?.event).toBe('message_stop');
      expect(parsed.some((e) => e.event === 'content_block_delta')).toBe(true);
      expect(attempt).toBe(2);
      expect(inFlightControllers.size).toBe(0);
      expect(events).toContain('request:start');
      expect(events).toContain('request:attempt');
      expect(events).toContain('request:finish');

      const nonStreamRes = await app.fetch(
        new Request('http://localhost:8048/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-5-5-medium',
            max_tokens: 512,
            messages: [{ role: 'user', content: 'Say hi' }],
          }),
        })
      );
      expect(nonStreamRes.status).toBe(200);
      const body = (await nonStreamRes.json()) as {
        type: string;
        role: string;
        stop_reason: string;
        content: Array<{ type: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(body.type).toBe('message');
      expect(body.role).toBe('assistant');
      expect(body.stop_reason).toBe('end_turn');
      expect(body.content.map((c) => c.type)).toEqual(['thinking', 'text']);
      expect(body.usage).toEqual({ input_tokens: 25, output_tokens: 15 });
    } finally {
      eventBus.unsubscribe(fakeController);
    }
  });
});

// ============================================================================
// Anthropic SSE 提前放行（early release）/ keepalive / 纯思考空响应守护
// ============================================================================

describe('Anthropic SSE early release, keepalive & thought-only guard', () => {
  const thoughtChunk = (text: string): GeminiGenerateResponse => ({
    candidates: [{ content: { role: 'model', parts: [{ text, thought: true }] }, index: 0 }],
  });
  const textChunk = (text: string): GeminiGenerateResponse => ({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
  });
  const thoughtOnlyError = () =>
    new WorkerError('Model returned thought-only or empty response without effective output', {
      code: 'SOFT_ERROR',
      upstreamStatus: 502,
      rawError: 'EMPTY_OR_THOUGHT_ONLY_RESPONSE',
    });

  function makeHarness(
    accounts: AccountRecord[],
    runScript: (
      onChunk: (chunk: GeminiGenerateResponse) => void,
      accountId: string
    ) => Promise<GeminiGenerateResponse>
  ) {
    const failures: Array<{ accountId: string; status: number; reasonCode: string }> = [];
    const successes: string[] = [];
    const scheduler: SchedulerLike = {
      selectAccount({ excludeAccountIds }) {
        return { account: accounts.find((a) => !excludeAccountIds.includes(a.id)) ?? null };
      },
      reportFailure(params) {
        failures.push({
          accountId: params.accountId,
          status: params.status ?? 0,
          reasonCode: params.reasonCode ?? '',
        });
      },
      reportSuccess(accountId) {
        successes.push(accountId);
      },
    };
    const workerPool: WorkerPoolLike = {
      async acquire({ account }) {
        return {
          id: `w:${account.id}`,
          accountId: account.id,
          async generate({ onChunk }) {
            return runScript(onChunk ?? (() => {}), account.id);
          },
        };
      },
      release() {},
    };
    return { app: createApp({ geminiDeps: { scheduler, workerPool } }), failures, successes };
  }

  function streamRequest(model = 'claude-opus-5-5-high'): Request {
    return new Request('http://localhost:8048/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Say hi' }],
      }),
    });
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

  it('releases HTTP 200 + keepalive on the first thinking block, then switches account without leaking the dirty thinking', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-a1');
      const acc2 = makeAccount('acc-a2');
      let releaseAnswer!: () => void;
      const answerGate = new Promise<void>((resolve) => {
        releaseAnswer = resolve;
      });

      const { app, failures, successes } = makeHarness([acc1, acc2], async (onChunk, accountId) => {
        if (accountId === 'acc-a1') {
          onChunk(thoughtChunk('DIRTY_THINKING_FROM_ACC1'));
          throw thoughtOnlyError();
        }
        onChunk(thoughtChunk('CLEAN_THINKING_FROM_ACC2'));
        await answerGate;
        onChunk(textChunk('CLEAN_ANSWER_FROM_ACC2'));
        return {
          candidates: [
            {
              index: 0,
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: 'CLEAN_ANSWER_FROM_ACC2' }] },
            },
          ],
        };
      });

      // 答案还被 gate 卡着：app.fetch 能返回就说明首个 thinking 已经放行了 200
      const res = await app.fetch(streamRequest());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('X-Early-Release')).toBe('thought');

      releaseAnswer();
      const text = await res.text();
      const events = parseSseEvents(text);
      expect(events[0]?.event).toBe('message_start');
      expect(events[events.length - 1]?.event).toBe('message_stop');
      // keepalive 只走流通道，绝不把 sentAnyChunk / firstSettled 置位（否则换号会被锁死）
      expect(text).toContain(': keepalive');
      expect(text).toContain('CLEAN_THINKING_FROM_ACC2');
      expect(text).toContain('CLEAN_ANSWER_FROM_ACC2');
      expect(text).not.toContain('DIRTY_THINKING_FROM_ACC1');
      expect(failures).toEqual([{ accountId: 'acc-a1', status: 502, reasonCode: 'SOFT_ERROR' }]);
      expect(successes).toEqual(['acc-a2']);
    });
  });

  it('keeps returning a real HTTP error (never a 200 SSE) when every attempt fails before any thinking block', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-b1');
      const acc2 = makeAccount('acc-b2');

      const { app, failures } = makeHarness([acc1, acc2], async () => {
        throw thoughtOnlyError();
      });

      const res = await app.fetch(streamRequest());
      expect(res.headers.get('X-Early-Release')).toBeNull();
      expect(res.status).toBe(502);
      const body = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('api_error');
      expect(body.error.message).toBeTruthy();
      // acc-b1、acc-b2 各失败一次，再加 1 次同号重建重试，全部 502 SOFT_ERROR
      expect(failures.length).toBe(3);
      expect(failures.every((f) => f.status === 502 && f.reasonCode === 'SOFT_ERROR')).toBe(true);
    });
  });

  it('writes a standard Anthropic SSE error event and closes the stream when the 200 was already released', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-c1');
      const acc2 = makeAccount('acc-c2');

      const { app, failures } = makeHarness([acc1, acc2], async (onChunk, accountId) => {
        if (accountId === 'acc-c1') {
          onChunk(thoughtChunk('only thinking here'));
        }
        throw thoughtOnlyError();
      });

      const res = await app.fetch(streamRequest());
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Early-Release')).toBe('thought');

      const text = await res.text();
      const events = parseSseEvents(text);
      expect(events[0]?.event).toBe('message_start');
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent?.data.type).toBe('error');
      const errorBody = errorEvent?.data.error as { type?: string; message?: string } | undefined;
      expect(errorBody?.type).toBe('api_error');
      expect(errorBody?.message).toBeTruthy();
      expect(failures.length).toBe(3);
      expect(failures.every((f) => f.status === 502 && f.reasonCode === 'SOFT_ERROR')).toBe(true);
    });
  });

  it('allows exactly one same-account rebuild retry for EMPTY_OR_THOUGHT_ONLY_RESPONSE in a single-account pool', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const acc1 = makeAccount('acc-a-solo');
      let attempts = 0;

      const { app, failures, successes } = makeHarness([acc1], async (onChunk) => {
        attempts += 1;
        if (attempts === 1) {
          onChunk(thoughtChunk('DIRTY_THINKING_FROM_BUILD_1'));
          throw thoughtOnlyError();
        }
        onChunk(textChunk('REBUILT_ANSWER_FROM_BUILD_2'));
        return {
          candidates: [
            {
              index: 0,
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: 'REBUILT_ANSWER_FROM_BUILD_2' }] },
            },
          ],
        };
      });

      const res = await app.fetch(streamRequest());
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('REBUILT_ANSWER_FROM_BUILD_2');
      expect(text).not.toContain('DIRTY_THINKING_FROM_BUILD_1');
      expect(attempts).toBe(2);
      expect(failures).toEqual([{ accountId: 'acc-a-solo', status: 502, reasonCode: 'SOFT_ERROR' }]);
      expect(successes).toEqual(['acc-a-solo']);
    });
  });

  it('releases the 200 on the early-release deadline, and setting streamThoughtEarlyReleaseMs to 0 disables that line', async () => {
    await withConfig(
      { streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 60 },
      async () => {
        const acc1 = makeAccount('acc-d1');
        const { app } = makeHarness([acc1], async (onChunk) => {
          await new Promise((r) => setTimeout(r, 600));
          onChunk(textChunk('LATE_ANSWER'));
          return {
            candidates: [
              {
                index: 0,
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ text: 'LATE_ANSWER' }] },
              },
            ],
          };
        });

        const started = Date.now();
        const res = await app.fetch(streamRequest());
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Early-Release')).toBe('deadline');
        expect(Date.now() - started).toBeLessThan(400);
        const text = await res.text();
        expect(text).toContain(': keepalive');
        expect(text).toContain('LATE_ANSWER');
      }
    );

    await withConfig(
      { streamThoughtImmediately: false, streamThoughtEarlyReleaseMs: 0 },
      async () => {
        const acc1 = makeAccount('acc-d2');
        const { app } = makeHarness([acc1], async () => {
          await new Promise((r) => setTimeout(r, 150));
          return {
            candidates: [
              {
                index: 0,
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ text: 'NO_EARLY_RELEASE' }] },
              },
            ],
          };
        });

        const res = await app.fetch(streamRequest());
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Early-Release')).toBeNull();
        expect(await res.text()).toContain('NO_EARLY_RELEASE');
      }
    );
  });

  it('returns real HTTP 429 JSON (not a 200 empty SSE) when the scheduler has no account before any thinking block', async () => {
    await withConfig({ streamThoughtImmediately: false }, async () => {
      const app = createApp({
        geminiDeps: {
          scheduler: { selectAccount: () => ({ account: null, retryAfterSeconds: 5 }) },
          workerPool: {
            acquire: async () => {
              throw new Error('Should not be called');
            },
            release: () => {},
          },
        },
      });

      const res = await app.fetch(streamRequest());
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(res.headers.get('X-Early-Release')).toBeNull();
      const body = (await res.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('rate_limit_error');
    });
  });
});
