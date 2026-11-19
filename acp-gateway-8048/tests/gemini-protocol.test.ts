import { describe, expect, it } from 'bun:test';
import { createGeminiHandler } from '../src/gemini/handler';
import {
  GeminiProtocolError,
  computeSessionHash,
  countInlineImages,
  estimateTokens,
  formatSseChunk,
  getModelFamily,
  resolveGatewayModel,
  validateAndParseGeminiRequest,
} from '../src/gemini/protocol';
import type { AccountRecord } from '../src/types';

describe('gemini/protocol', () => {
  it('validates a standard request with tools, thought, and inlineData', () => {
    const req = validateAndParseGeminiRequest({
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Check this image' },
            { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
        {
          role: 'model',
          parts: [
            { thought: true, thoughtSignature: 'sig_abc123', text: 'Thinking...' },
            { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'get_weather', response: { temp: 22 } } },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        },
      ],
    });

    expect(req.contents.length).toBe(3);
    expect(countInlineImages(req)).toBe(1);
    expect(estimateTokens(req)).toBeGreaterThan(258);
  });

  it('rejects requests with more than 200 inlineData images with 400', () => {
    const parts = Array.from({ length: 201 }, () => ({
      inlineData: { mimeType: 'image/jpeg', data: 'AAAA' },
    }));

    expect(() =>
      validateAndParseGeminiRequest({
        contents: [{ role: 'user', parts }],
      })
    ).toThrow(GeminiProtocolError);

    try {
      validateAndParseGeminiRequest({
        contents: [{ role: 'user', parts }],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiProtocolError);
      const e = err as GeminiProtocolError;
      expect(e.statusCode).toBe(400);
      expect(e.message).toBe('Too many inlineData images: 201 exceeds limit of 200');
    }
  });

  it('computes deterministic sessionHash from systemInstruction and first user message', () => {
    const req1 = validateAndParseGeminiRequest({
      systemInstruction: { parts: [{ text: 'System A' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi' }] },
      ],
    });

    const req2 = validateAndParseGeminiRequest({
      systemInstruction: { parts: [{ text: 'System A' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi' }] },
        { role: 'user', parts: [{ text: 'Follow-up' }] },
      ],
    });

    const req3 = validateAndParseGeminiRequest({
      systemInstruction: { parts: [{ text: 'System B' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    });

    expect(computeSessionHash(req1)).toBe(computeSessionHash(req2));
    expect(computeSessionHash(req1)).not.toBe(computeSessionHash(req3));
  });

  it('formats SSE chunk as strictly single-line data: <JSON>\\n\\n with thoughtSignature preserved', () => {
    const chunk = formatSseChunk({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { thought: true, thoughtSignature: 'sig_xyz', text: 'line1\nline2' },
              { text: 'Answer' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    });

    expect(chunk.startsWith('data: ')).toBe(true);
    expect(chunk.endsWith('\n\n')).toBe(true);
    const lines = chunk.slice(0, -2).split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0].slice(6));
    expect(parsed.candidates[0].content.parts[0].thought).toBe(true);
    expect(parsed.candidates[0].content.parts[0].thoughtSignature).toBe('sig_xyz');
  });

  it('maps model names to families', () => {
    expect(getModelFamily('gemini-2.5-flash')).toBe('gemini-2.5');
    expect(getModelFamily('gemini-3-pro-preview')).toBe('gemini-3');
    expect(getModelFamily('gemini-4-argon')).toBe('gemini-4');
    expect(getModelFamily('claude-sonnet-4-5')).toBe('claude');
  });

  it('resolves legacy gemini-2.5-flash text models to gemini-3.8-flash-low', () => {
    expect(resolveGatewayModel('gemini-2.5-flash')).toBe('gemini-3.8-flash-low');
    expect(resolveGatewayModel('models/gemini-2.5-flash')).toBe('gemini-3.8-flash-low');
    expect(resolveGatewayModel('GEMINI-2.5-FLASH-LITE')).toBe('gemini-3.8-flash-low');
    expect(resolveGatewayModel('gemini-2.5-flash-thinking')).toBe('gemini-3.8-flash-low');
    expect(resolveGatewayModel('gemini-2.5-flash-preview-05-20')).toBe('gemini-3.8-flash-low');
    expect(resolveGatewayModel('gemini-2.5-flash-preview-tts')).toBe('gemini-2.5-flash-preview-tts');
    expect(resolveGatewayModel('gemini-4-hydrogen')).toBe('gemini-4-hydrogen-medium');
    expect(resolveGatewayModel('models/GEMINI-4-HYDROGEN')).toBe('gemini-4-hydrogen-medium');
    expect(resolveGatewayModel('gemini-4-hydrogen-high')).toBe('gemini-4-hydrogen-high');
    expect(resolveGatewayModel('models/gemini-3.8-flash-low')).toBe('gemini-3.8-flash-low');
  });

  it('sanitizes empty or invalid inlineData parts', () => {
    const req = validateAndParseGeminiRequest({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Hello' },
            { inlineData: { mimeType: 'image/png', data: '   ' } },
            { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    expect(countInlineImages(req)).toBe(1);
    expect(req.contents[0]!.parts.length).toBe(2);
  });
});

describe('gemini/handler', () => {
  const mockAccount: AccountRecord = {
    id: 'acc_1',
    label: 'testuser@example.com',
    homeDir: 'C:\\tmp\\acc_1',
    proxyUrl: '',
    status: 'ready',
    concurrencyLimit: 2,
    activeWorkers: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('GET /v1beta/models/:model returns model details or 404 NOT_FOUND', async () => {
    const handler = createGeminiHandler();
    const okRes = await handler(
      new Request('http://localhost:8048/v1beta/models/gemini-3.8-flash-low'),
      new URL('http://localhost:8048/v1beta/models/gemini-3.8-flash-low')
    );
    expect(okRes?.status).toBe(200);
    const okJson = (await okRes!.json()) as { name: string };
    expect(okJson.name).toBe('models/gemini-3.8-flash-low');

    const notFoundRes = await handler(
      new Request('http://localhost:8048/v1beta/models/non-existent-model-xyz'),
      new URL('http://localhost:8048/v1beta/models/non-existent-model-xyz')
    );
    expect(notFoundRes?.status).toBe(404);
    const errJson = (await notFoundRes!.json()) as { error: { code: number; status: string } };
    expect(errJson.error.code).toBe(404);
    expect(errJson.error.status).toBe('NOT_FOUND');
  }, 20_000);

  it('returns JSON array when :streamGenerateContent is called without alt=sse', async () => {
    const handler = createGeminiHandler({
      scheduler: {
        selectAccount: () => ({ account: mockAccount }),
      },
      workerPool: {
        acquire: async () => ({
          id: 'w1',
          accountId: mockAccount.id,
          generate: async (params) => {
            params.onChunk?.({
              candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hi' }] } }],
            });
            return {
              candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
            };
          },
        }),
        release: () => {},
      },
    });

    const req = new Request('http://localhost:8048/v1beta/models/gemini-3.8-flash-low:streamGenerateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }),
    });
    const res = await handler(req, new URL(req.url));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toContain('application/json');
    const arr = (await res!.json()) as Array<{ modelVersion?: string; responseId?: string }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThanOrEqual(2);
    expect(arr[0]!.modelVersion).toBe('gemini-3.8-flash-low');
    expect(arr[0]!.responseId).toBeTruthy();
  });

  it('returns SSE chunks with modelVersion, usageMetadata, finishReason and no [DONE]', async () => {
    const handler = createGeminiHandler({
      scheduler: {
        selectAccount: () => ({ account: mockAccount }),
      },
      workerPool: {
        acquire: async () => ({
          id: 'w1',
          accountId: mockAccount.id,
          generate: async (params) => {
            params.onChunk?.({
              candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello!' }] } }],
            });
            return {
              candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello!' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13, thoughtsTokenCount: 0 },
            };
          },
        }),
        release: () => {},
      },
    });

    const req = new Request('http://localhost:8048/v1beta/models/gemini-3.8-flash-low:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }),
    });
    const res = await handler(req, new URL(req.url));
    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res?.headers.get('X-Accel-Buffering')).toBe('no');
    expect(res?.headers.get('X-Mapped-Model')).toBe('gemini-3.8-flash-low');

    const text = await res!.text();
    expect(text).not.toContain('[DONE]');
    const events = text
      .trim()
      .split('\n\n')
      .map((line) => JSON.parse(line.replace(/^data:\s*/, '')));
    const last = events[events.length - 1];
    expect(last.candidates[0].finishReason).toBe('STOP');
    expect(last.usageMetadata.totalTokenCount).toBe(13);
    expect(last.modelVersion).toBe('gemini-3.8-flash-low');
  });

  it('returns HTTP 429 JSON instead of 200 empty SSE when pre-first-chunk fails', async () => {
    const handler = createGeminiHandler({
      scheduler: {
        selectAccount: () => ({ account: null, retryAfterSeconds: 42 }),
      },
      workerPool: {
        acquire: async () => {
          throw new Error('Should not be called');
        },
        release: () => {},
      },
    });

    const req = new Request('http://localhost:8048/v1beta/models/gemini-3.8-flash-low:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }),
    });
    const res = await handler(req, new URL(req.url));
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBe('42');
    const body = (await res!.json()) as { error: { code: number; status: string } };
    expect(body.error.code).toBe(429);
    expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
  });
});
