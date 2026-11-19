import { afterEach, describe, expect, it } from 'bun:test';
import { WorkerError } from '../src/acp/worker';
import { invalidateConfigCache, updateConfig } from '../src/config/settings';
import { store } from '../src/db/store';
import type { SchedulerLike, WorkerPoolLike } from '../src/gemini/handler';
import { eventBus } from '../src/logs/events';
import {
  OpenAiProtocolError,
  OpenAiStreamSerializer,
  convertGeminiToOpenAiResponse,
  convertOpenAiToGeminiRequest,
  resolveOpenAiSessionKey,
} from '../src/openai/protocol';
import { createApp } from '../src/server';
import type { AccountRecord, GatewayConfig, GeminiGenerateRequest } from '../src/types';

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

function parseOpenAiSse(raw: string): Array<Record<string, unknown> | '[DONE]'> {
  const results: Array<Record<string, unknown> | '[DONE]'> = [];
  const blocks = raw.split(/\n\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/)) {
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

describe('OpenAI protocol conversion', () => {
  it('converts system/developer, user image_url, assistant reasoning+tool_calls, tool responses, tools, and generationConfig', () => {
    const converted = convertOpenAiToGeminiRequest({
      model: 'gemini-3-flash',
      max_completion_tokens: 2048,
      max_tokens: 1024,
      temperature: 0.3,
      top_p: 0.95,
      stop: ['END', 'STOP'],
      reasoning_effort: 'medium',
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather by city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      messages: [
        { role: 'system', content: 'Sys 1' },
        { role: 'developer', content: [{ type: 'text', text: 'Dev 2' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check this image' },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              },
            },
          ],
        },
        {
          role: 'assistant',
          reasoning_content: 'Let me check Tokyo weather.',
          content: null,
          tool_calls: [
            {
              id: 'call_wx_1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Tokyo"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_wx_1',
          content: 'Sunny 24C',
        },
      ],
    });

    expect(converted.requestedModel).toBe('gemini-3-flash');
    expect(converted.stream).toBe(true);
    expect(converted.includeUsage).toBe(true);
    expect(converted.geminiRequest.systemInstruction).toEqual({
      parts: [{ text: 'Sys 1' }, { text: 'Dev 2' }],
    });
    expect(converted.geminiRequest.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Check this image' },
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
          { text: 'Let me check Tokyo weather.', thought: true },
          {
            functionCall: {
              id: 'call_wx_1',
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
              id: 'call_wx_1',
              name: 'get_weather',
              response: { content: 'Sunny 24C' },
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
            description: 'Get weather by city',
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
      temperature: 0.3,
      topP: 0.95,
      stopSequences: ['END', 'STOP'],
      thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
    });
  });

  it('validates model, messages, non-data image_url, maxImagesPerRequest, and reasoning_effort', () => {
    expect(() =>
      convertOpenAiToGeminiRequest({
        model: '',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).toThrow(OpenAiProtocolError);

    expect(() =>
      convertOpenAiToGeminiRequest({
        model: 'gpt-oss-120b-medium',
        messages: [],
      })
    ).toThrow(OpenAiProtocolError);

    expect(() =>
      convertOpenAiToGeminiRequest({
        model: 'gpt-oss-120b-medium',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            ],
          },
        ],
      })
    ).toThrow(OpenAiProtocolError);

    expect(() =>
      convertOpenAiToGeminiRequest(
        {
          model: 'gpt-oss-120b-medium',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB=' } },
              ],
            },
          ],
        },
        { maxImagesPerRequest: 1 }
      )
    ).toThrow(OpenAiProtocolError);

    expect(() =>
      convertOpenAiToGeminiRequest({
        model: 'gpt-oss-120b-medium',
        reasoning_effort: 'ultra',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).toThrow(OpenAiProtocolError);
  });

  it('resolves session key with header priority, agent isolation, prompt_cache_key, user, and hash fallback', () => {
    const req: GeminiGenerateRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    };

    expect(
      resolveOpenAiSessionKey(
        req,
        new Headers({
          'x-session-id': 'sess-1',
          'x-claude-code-agent-id': 'sub-a',
        }),
        'cache-k',
        'user-1'
      )
    ).toBe('sess-1:agent:sub-a');

    expect(
      resolveOpenAiSessionKey(req, new Headers({ 'x-thread-id': 'thread-9' }), 'cache-k', 'user-1')
    ).toBe('thread-9');

    expect(resolveOpenAiSessionKey(req, new Headers(), 'cache-k', 'user-1')).toBe('cache-k');
    expect(resolveOpenAiSessionKey(req, new Headers(), '', 'user-1')).toBe('user-1');

    const hashed = resolveOpenAiSessionKey(req, new Headers());
    expect(hashed).toMatch(/^[a-f0-9]{24}$/);
  });

  it('converts Gemini response to OpenAI chat.completion with reasoning_content, tool_calls, and detailed usage', () => {
    const resp = convertGeminiToOpenAiResponse(
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
                { functionCall: { id: 'call_1', name: 'search', args: { q: 'test' } } },
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
      { completionId: 'chatcmpl-test1', model: 'claude-sonnet-5-5-medium', created: 1700000000 }
    );

    expect(resp).toEqual({
      id: 'chatcmpl-test1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'claude-sonnet-5-5-medium',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello world',
            reasoning_content: 'step 1 step 2',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"q":"test"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        total_tokens: 165,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 15 },
      },
    });
  });

  it('serializes SSE stream chunks with deltas, finish_reason, optional usage, and [DONE]', () => {
    const serializer = new OpenAiStreamSerializer('chatcmpl-sse', 'gemini-3-flash', 1700000001);
    const raw =
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
              parts: [{ functionCall: { id: 'call_abc', name: 'ping', args: { host: '1.1.1.1' } } }],
            },
          },
        ],
      }) +
      serializer.finishStream(
        'STOP',
        {
          promptTokenCount: 10,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 2,
        },
        true
      );

    const parsed = parseOpenAiSse(raw);
    expect(parsed.length).toBe(6);
    expect(parsed[5]).toBe('[DONE]');

    const c0 = parsed[0] as { choices: Array<{ delta: Record<string, unknown> }> };
    const c1 = parsed[1] as { choices: Array<{ delta: Record<string, unknown> }> };
    const c2 = parsed[2] as { choices: Array<{ delta: Record<string, unknown> }> };
    const c3 = parsed[3] as { choices: Array<{ finish_reason: string }> };
    const c4 = parsed[4] as { choices: unknown[]; usage: { total_tokens: number } };

    expect(c0.choices[0]!.delta).toEqual({ role: 'assistant', reasoning_content: 'think...' });
    expect(c1.choices[0]!.delta).toEqual({ content: 'answer' });
    expect(c2.choices[0]!.delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_abc',
        type: 'function',
        function: { name: 'ping', arguments: '{"host":"1.1.1.1"}' },
      },
    ]);
    expect(c3.choices[0]!.finish_reason).toBe('tool_calls');
    expect(c4.choices).toEqual([]);
    expect(c4.usage.total_tokens).toBe(20);
  });
});

describe('OpenAI HTTP handler & server integration', () => {
  const previousConfig = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');

  afterEach(() => {
    if (previousConfig) {
      store.setConfigValue('gateway_config', previousConfig);
    }
    invalidateConfigCache();
  });

  it('enforces Bearer / x-api-key auth on /v1/chat/completions and returns OpenAI+Anthropic compatible /v1/models', async () => {
    updateConfig({ apiKey: 'secret-openai-key' });
    const app = createApp({
      geminiDeps: {
        scheduler: { selectAccount: () => ({ account: null }) },
        workerPool: {
          async acquire() {
            throw new Error('should not be called');
          },
          release() {},
        },
      },
    });

    const unauth = await app.fetch(
      new Request('http://localhost:8048/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    );
    expect(unauth.status).toBe(401);
    const unauthBody = (await unauth.json()) as {
      error: { type: string; param: null; code: string };
    };
    expect(unauthBody.error.type).toBe('authentication_error');
    expect(unauthBody.error.param).toBeNull();
    expect(unauthBody.error.code).toBe('invalid_api_key');

    const modelsRes = await app.fetch(
      new Request('http://localhost:8048/v1/models', {
        headers: { Authorization: 'Bearer secret-openai-key' },
      })
    );
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as {
      object: string;
      has_more: boolean;
      data: Array<{ id: string; object: string; type: string; display_name: string }>;
    };
    expect(modelsJson.object).toBe('list');
    expect(modelsJson.has_more).toBe(false);
    expect(modelsJson.data.length).toBeGreaterThan(0);
    expect(modelsJson.data[0]!.object).toBe('model');
    expect(modelsJson.data[0]!.type).toBe('model');
  });

  it('handles non-streaming and streaming /v1/chat/completions with pre-stream retry and eventBus logging', async () => {
    updateConfig({ apiKey: '' });
    const acc1 = makeAccount('acc-oai-1');
    const acc2 = makeAccount('acc-oai-2');
    const accounts = [acc1, acc2];

    const events: string[] = [];
    const decoder = new TextDecoder();
    const fakeController = {
      enqueue(chunk: Uint8Array) {
        const text = decoder.decode(chunk);
        const match = /^event:\s*(\S+)/m.exec(text);
        if (
          match &&
          (match[1] === 'request:start' ||
            match[1] === 'request:attempt' ||
            match[1] === 'request:finish')
        ) {
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
              candidates: [{ content: { role: 'model', parts: [{ text: 'Hello OpenAI!' }] } }],
            });
            return {
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      { text: 'Thinking...', thought: true },
                      { text: 'Hello OpenAI!' },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 20,
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
        new Request('http://localhost:8048/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-5-5-high',
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: 'user', content: 'Say hi' }],
          }),
        })
      );

      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
      const sseText = await streamRes.text();
      const parsed = parseOpenAiSse(sseText);
      expect(parsed[parsed.length - 1]).toBe('[DONE]');
      expect(attempt).toBe(2);
      expect(inFlightControllers.size).toBe(0);
      expect(events).toContain('request:start');
      expect(events).toContain('request:attempt');
      expect(events).toContain('request:finish');

      const nonStreamRes = await app.fetch(
        new Request('http://localhost:8048/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-5-5-medium',
            messages: [{ role: 'user', content: 'Say hi' }],
          }),
        })
      );
      expect(nonStreamRes.status).toBe(200);
      const body = (await nonStreamRes.json()) as {
        object: string;
        choices: Array<{
          finish_reason: string;
          message: { role: string; content: string; reasoning_content: string };
        }>;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0]!.finish_reason).toBe('stop');
      expect(body.choices[0]!.message.content).toBe('Hello OpenAI!');
      expect(body.choices[0]!.message.reasoning_content).toBe('Thinking...');
      expect(body.usage.prompt_tokens).toBe(20);
      expect(body.usage.completion_tokens).toBe(15);
      expect(body.usage.total_tokens).toBe(35);
    } finally {
      eventBus.unsubscribe(fakeController);
    }
  });
});
