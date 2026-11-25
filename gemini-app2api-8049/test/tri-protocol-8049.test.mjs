import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StateStore, defaults } from '../src/gateway/state.mjs';
import { loadLocalEnvironment } from '../src/gateway/environment.mjs';
import { createGateway } from '../src/gateway/app.mjs';
import { createResponseDelivery } from '../src/gateway/response-delivery.mjs';
import { Security } from '../src/gateway/security.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-8049-test-'));
}

function makeFakeProvider() {
  return {
    sessions: new Map(),
    async runTurn(_accountId, canonical, deliver) {
      const hasTools = Array.isArray(canonical.tools) && canonical.tools.length > 0;
      const lastMsg = canonical.messages[canonical.messages.length - 1];
      const wantsTool = hasTools && lastMsg?.role !== 'tool';

      await deliver({ start: true, response: { id: 'resp_fake_1', model: canonical.model } });

      if (wantsTool) {
        const call = {
          id: 'call_fake_1',
          type: 'function',
          function: { name: canonical.tools[0].function.name, arguments: '{"city":"Tokyo"}' },
        };
        await deliver({ call, response: { id: 'resp_fake_1', model: canonical.model } });
        return {
          id: 'resp_fake_1',
          created: 1700000000,
          model: canonical.model,
          content: '',
          calls: [call],
          thinkingLevel: canonical.thinking_level ?? 2,
          resolvedModeCategory: 3,
        };
      }

      const text = 'Hello from 8049 tri-protocol gateway!';
      await deliver({ content: text, response: { id: 'resp_fake_1', model: canonical.model } });
      return {
        id: 'resp_fake_1',
        created: 1700000000,
        model: canonical.model,
        content: text,
        calls: [],
        thinkingLevel: canonical.thinking_level ?? 2,
        resolvedModeCategory: 3,
      };
    },
  };
}

function makeFakeAccounts(store) {
  const list = [
    { id: 'acc_1', email: 'test@example.com', enabled: true, status: 'ready' },
  ];
  return {
    list: () => list,
    getValidAccessToken: async () => 'fake-token',
    recordProviderSuccess: () => {},
    recordUpstreamError: () => {},
    close: async () => {},
  };
}

async function setupGateway({ adminPassword } = {}) {
  const dir = makeTempDir();
  const store = new StateStore({
    directory: dir,
    adminPassword,
    defaultProfile: {
      context: 2,
      enableFst: true,
      clientId: '123456-abcdef.apps.googleusercontent.com',
      clientSecret: 'secret',
      scopes: ['openid', 'email'],
    },
  });
  store.lock();
  const createdKey = store.createKey('test-key');
  const accounts = makeFakeAccounts(store);
  const provider = makeFakeProvider();
  const app = createGateway({
    store,
    accounts,
    provider,
    openTurn: () => { throw new Error('unexpected openTurn'); },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    dir,
    store,
    app,
    origin,
    apiKey: createdKey.key,
    async cleanup() {
      await app.close();
      store.unlock();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('default port is 8049 and loadLocalEnvironment works on Windows', () => {
  assert.equal(defaults.port, 8049);
  const dir = makeTempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'GEMINI_TEST_VAR=ok\n', 'utf8');
  try {
    const res = loadLocalEnvironment({ file: envFile, required: true });
    assert.equal(res.loaded, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('8046 loopback proxy bypass, /api/status, /api/drain, and strict password mode', async () => {
  const gw = await setupGateway();
  try {
    // 1. /api/status
    const statusRes = await fetch(`${gw.origin}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.service, 'gemini-app2api-8049');
    assert.equal(statusBody.accountsCount, 1);
    assert.equal(statusBody.enabledAccountsCount, 1);
    assert.equal(statusBody.keyCount, 1);

    // 2. Direct loopback without trusted proxy header must NOT bypass Host/Origin/Cookie/CSRF
    const untrustedHostStatus = await new Promise((resolve, reject) => {
      const target = new URL(`${gw.origin}/admin/api/overview`);
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'GET',
          headers: { Host: '127.0.0.1:8046' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(untrustedHostStatus, 403);

    const directNoCookie = await fetch(`${gw.origin}/admin/api/overview`);
    assert.equal(directNoCookie.status, 401);

    const directPostNoCookie = await fetch(`${gw.origin}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: gw.origin },
      body: JSON.stringify({ label: 'should-fail-401' }),
    });
    assert.equal(directPostNoCookie.status, 401);

    const directBadOrigin = await fetch(`${gw.origin}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ label: 'should-fail-403' }),
    });
    assert.equal(directBadOrigin.status, 403);

    // 3. 8046 trusted proxy channel (loopback + passwordless + x-zako-trusted-proxy: 1) bypasses Cookie/CSRF
    const overviewRes = await fetch(`${gw.origin}/admin/api/overview`, {
      headers: { Host: '127.0.0.1:8046', 'x-zako-trusted-proxy': '1' },
    });
    assert.equal(overviewRes.status, 200);
    const overview = await overviewRes.json();
    assert.equal(overview.keyCount, 1);

    // POST & DELETE mutation without Cookie/CSRF via trusted 8046 proxy
    const createRes = await fetch(`${gw.origin}/admin/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:8046',
        'x-zako-trusted-proxy': '1',
      },
      body: JSON.stringify({ label: 'proxy-key' }),
    });
    assert.equal(createRes.status, 201);
    const newKey = await createRes.json();
    assert.ok(newKey.id);

    const delRes = await fetch(`${gw.origin}/admin/api/keys/${newKey.id}`, {
      method: 'DELETE',
      headers: { Host: '127.0.0.1:8046', 'x-zako-trusted-proxy': '1' },
    });
    assert.equal(delRes.status, 200);

    // 4. Direct loopback browser session bootstrap + CSRF mutation works when Origin/Cookie/CSRF are present
    const sessionRes = await fetch(`${gw.origin}/admin/api/session`);
    assert.equal(sessionRes.status, 200);
    const setCookie = sessionRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /Path=\/;/);
    assert.doesNotMatch(setCookie, /Path=\/admin/);
    const sessionJson = await sessionRes.json();
    const cookieHeader = setCookie.split(';')[0];
    const directCreateRes = await fetch(`${gw.origin}/admin/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: gw.origin,
        Cookie: cookieHeader,
        'X-CSRF-Token': sessionJson.csrf,
      },
      body: JSON.stringify({ label: 'direct-browser-key' }),
    });
    assert.equal(directCreateRes.status, 201);

    // Direct browser mutation with Cookie + Origin but WITHOUT X-CSRF-Token must fail with 403
    const directMissingCsrf = await fetch(`${gw.origin}/admin/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: gw.origin,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ label: 'missing-csrf-403' }),
    });
    assert.equal(directMissingCsrf.status, 403);

    // 5. /api/drain works on loopback, and Security.isLoopbackAddress rejects non-loopback
    assert.equal(Security.isLoopbackAddress('10.0.0.5'), false);
    assert.equal(Security.isLoopbackAddress('127.0.0.1'), true);
    const drainRes = await fetch(`${gw.origin}/api/drain`, { method: 'POST' });
    assert.equal(drainRes.status, 200);
    assert.deepEqual(await drainRes.json(), { ok: true, draining: true });
  } finally {
    await gw.cleanup();
  }

  // Strict password mode still rejects unauthenticated /admin/api/overview even with x-zako-trusted-proxy
  const secured = await setupGateway({ adminPassword: 'super-secret-password-123' });
  try {
    const res = await fetch(`${secured.origin}/admin/api/overview`, {
      headers: { 'x-zako-trusted-proxy': '1' },
    });
    assert.equal(res.status, 401);
  } finally {
    await secured.cleanup();
  }
});

test('multi-header and query key authentication across all three protocols', async () => {
  const gw = await setupGateway();
  try {
    // Missing key -> 401
    const unauth = await fetch(`${gw.origin}/v1/models`);
    assert.equal(unauth.status, 401);

    // Bearer
    const bearer = await fetch(`${gw.origin}/v1/models`, {
      headers: { Authorization: `Bearer ${gw.apiKey}` },
    });
    assert.equal(bearer.status, 200);

    // x-api-key
    const xApi = await fetch(`${gw.origin}/v1/models`, {
      headers: { 'x-api-key': gw.apiKey },
    });
    assert.equal(xApi.status, 200);

    // x-goog-api-key
    const xGoog = await fetch(`${gw.origin}/v1beta/models`, {
      headers: { 'x-goog-api-key': gw.apiKey },
    });
    assert.equal(xGoog.status, 200);

    // ?key= on /v1beta/
    const qKey = await fetch(`${gw.origin}/v1beta/models?key=${encodeURIComponent(gw.apiKey)}`);
    assert.equal(qKey.status, 200);

    // ?pageSize= and ?pageToken= on /v1beta/models
    const qPageSize = await fetch(`${gw.origin}/v1beta/models?pageSize=100&key=${encodeURIComponent(gw.apiKey)}`);
    assert.equal(qPageSize.status, 200);
    const qPageToken = await fetch(`${gw.origin}/v1beta/models?pageSize=100&pageToken=next&key=${encodeURIComponent(gw.apiKey)}`);
    assert.equal(qPageToken.status, 200);

    // Unsupported query parameter on /v1beta/
    const badQuery = await fetch(`${gw.origin}/v1beta/models?key=${encodeURIComponent(gw.apiKey)}&foo=bar`);
    assert.equal(badQuery.status, 400);
  } finally {
    await gw.cleanup();
  }
});

test('OpenAI protocol regression (/v1/models and /v1/chat/completions)', async () => {
  const gw = await setupGateway();
  try {
    const modelsRes = await fetch(`${gw.origin}/v1/models`, {
      headers: { Authorization: `Bearer ${gw.apiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const models = await modelsRes.json();
    assert.ok(models.data.some((m) => m.id === 'gemini-neon'));

    const chatRes = await fetch(`${gw.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gw.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gemini-neon',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    assert.equal(chatRes.status, 200);
    const chat = await chatRes.json();
    assert.equal(chat.choices[0].message.content, 'Hello from 8049 tri-protocol gateway!');
  } finally {
    await gw.cleanup();
  }
});

test('Google protocol (/v1/messages non-stream, SSE stream, tools, count_tokens)', async () => {
  const gw = await setupGateway();
  try {
    // 1. Non-stream text
    const res = await fetch(`${gw.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': gw.apiKey },
      body: JSON.stringify({
        model: 'gemini-neon',
        max_tokens: 1024,
        system: [{ type: 'text', text: 'Be concise.' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        stream: false,
      }),
    });
    assert.equal(res.status, 200);
    const msg = await res.json();
    assert.equal(msg.type, 'message');
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(msg.content[0].type, 'text');
    assert.equal(msg.content[0].text, 'Hello from 8049 tri-protocol gateway!');
    assert.ok(msg.usage.input_tokens > 0);

    // 2. Stream SSE sequence
    const streamRes = await fetch(`${gw.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': gw.apiKey },
      body: JSON.stringify({
        model: 'gemini-neon',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello stream' }],
        stream: true,
      }),
    });
    assert.equal(streamRes.status, 200);
    const sseText = await streamRes.text();
    for (const ev of [
      'event: message_start',
      'event: content_block_start',
      'event: content_block_delta',
      'event: content_block_stop',
      'event: message_delta',
      'event: message_stop',
    ]) {
      assert.ok(sseText.includes(ev), `missing SSE event: ${ev}`);
    }
    assert.ok(sseText.includes('text_delta'));

    // 3. Tool call (non-stream)
    const toolRes = await fetch(`${gw.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': gw.apiKey },
      body: JSON.stringify({
        model: 'gemini-neon',
        max_tokens: 1024,
        tools: [{
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        }],
        messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
        stream: false,
      }),
    });
    assert.equal(toolRes.status, 200);
    const toolMsg = await toolRes.json();
    assert.equal(toolMsg.stop_reason, 'tool_use');
    assert.equal(toolMsg.content[0].type, 'tool_use');
    assert.equal(toolMsg.content[0].name, 'get_weather');
    assert.deepEqual(toolMsg.content[0].input, { city: 'Tokyo' });

    // 4. count_tokens
    const countRes = await fetch(`${gw.origin}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': gw.apiKey },
      body: JSON.stringify({
        model: 'gemini-neon',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Count these tokens please.' }],
      }),
    });
    assert.equal(countRes.status, 200);
    const countBody = await countRes.json();
    assert.ok(Number.isInteger(countBody.input_tokens) && countBody.input_tokens > 0);
  } finally {
    await gw.cleanup();
  }
});

test('Gemini native protocol (/v1beta/models, generateContent, streamGenerateContent, tools, countTokens)', async () => {
  const gw = await setupGateway();
  try {
    // 1. GET /v1beta/models and single model
    const listRes = await fetch(`${gw.origin}/v1beta/models?key=${encodeURIComponent(gw.apiKey)}`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.models.some((m) => m.name === 'models/gemini-neon' && m.inputTokenLimit === 512000));

    const getRes = await fetch(`${gw.origin}/v1beta/models/gemini-neon`, {
      headers: { 'x-goog-api-key': gw.apiKey },
    });
    assert.equal(getRes.status, 200);
    const modelDesc = await getRes.json();
    assert.equal(modelDesc.name, 'models/gemini-neon');

    // 2. Non-stream generateContent
    const genRes = await fetch(`${gw.origin}/v1beta/models/gemini-neon:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gw.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'System prompt' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello Gemini' }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
      }),
    });
    assert.equal(genRes.status, 200);
    const genBody = await genRes.json();
    assert.equal(genBody.candidates[0].finishReason, 'STOP');
    assert.equal(genBody.candidates[0].content.parts[0].text, 'Hello from 8049 tri-protocol gateway!');
    assert.ok(genBody.usageMetadata.totalTokenCount > 0);

    // 3. Stream SSE (?alt=sse)
    const sseRes = await fetch(`${gw.origin}/v1beta/models/gemini-neon:streamGenerateContent?alt=sse&key=${encodeURIComponent(gw.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Stream SSE' }] }],
      }),
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
    const sseBody = await sseRes.text();
    assert.ok(sseBody.includes('data: '));
    assert.ok(sseBody.includes('"finishReason":"STOP"'));

    // 4. Stream JSON array (without ?alt=sse)
    const arrRes = await fetch(`${gw.origin}/v1beta/models/gemini-neon:streamGenerateContent?key=${encodeURIComponent(gw.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Stream JSON array' }] }],
      }),
    });
    assert.equal(arrRes.status, 200);
    const arrJson = await arrRes.json();
    assert.ok(Array.isArray(arrJson) && arrJson.length >= 1);
    assert.equal(arrJson[arrJson.length - 1].candidates[0].finishReason, 'STOP');

    // 5. Tool call
    const toolRes = await fetch(`${gw.origin}/v1beta/models/gemini-neon:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gw.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Call tool' }] }],
        tools: [{
          functionDeclarations: [{
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          }],
        }],
      }),
    });
    assert.equal(toolRes.status, 200);
    const toolBody = await toolRes.json();
    assert.equal(toolBody.candidates[0].content.parts[0].functionCall.name, 'get_weather');
    assert.deepEqual(toolBody.candidates[0].content.parts[0].functionCall.args, { city: 'Tokyo' });

    // 6. countTokens
    const countRes = await fetch(`${gw.origin}/v1beta/models/gemini-neon:countTokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gw.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Count Gemini tokens.' }] }],
      }),
    });
    assert.equal(countRes.status, 200);
    const countBody = await countRes.json();
    assert.ok(Number.isInteger(countBody.totalTokens) && countBody.totalTokens > 0);
  } finally {
    await gw.cleanup();
  }
});

function createMockRes() {
  const listeners = new Map();
  return {
    statusCode: 200,
    headersSent: false,
    headers: {},
    chunks: [],
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
    once(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    off(ev, fn) {
      listeners.get(ev)?.delete(fn);
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk));
      this.writableEnded = true;
    },
    body() {
      return this.chunks.join('');
    },
  };
}

test('P0-7: Gemini non-SSE JSON array stream never emits SSE keepalive comments', async () => {
  // 1. Non-SSE JSON array: must NOT emit ': keepalive\n\n'
  const jsonRes = createMockRes();
  const jsonDelivery = createResponseDelivery(jsonRes, {
    route: 'gemini',
    stream: true,
    geminiSse: false,
    model: 'gemini-neon',
    keepaliveMs: 10,
  });
  await jsonDelivery.accept({ start: true, response: { id: 'resp_ka_1', model: 'gemini-neon' } });
  await new Promise((r) => setTimeout(r, 45));
  await jsonDelivery.accept({ content: 'Hello JSON array', response: { id: 'resp_ka_1', model: 'gemini-neon' } });
  await jsonDelivery.complete({
    id: 'resp_ka_1',
    model: 'gemini-neon',
    content: 'Hello JSON array',
    calls: [],
  });
  const jsonText = jsonRes.body();
  assert.equal(jsonText.includes(': keepalive'), false);
  const parsed = JSON.parse(jsonText);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[parsed.length - 1].candidates[0].finishReason, 'STOP');

  // 2. SSE mode: still emits ': keepalive\n\n'
  const sseRes = createMockRes();
  const sseDelivery = createResponseDelivery(sseRes, {
    route: 'gemini',
    stream: true,
    geminiSse: true,
    model: 'gemini-neon',
    keepaliveMs: 10,
  });
  await sseDelivery.accept({ start: true, response: { id: 'resp_ka_2', model: 'gemini-neon' } });
  await new Promise((r) => setTimeout(r, 45));
  await sseDelivery.complete({
    id: 'resp_ka_2',
    model: 'gemini-neon',
    content: 'Hello SSE',
    calls: [],
  });
  assert.equal(sseRes.body().includes(': keepalive\n\n'), true);
});

test('P0-8: Google and Gemini distinguish normal completion from mid-stream or non-stream failure', async () => {
  const err = Object.assign(new Error('upstream failed'), { code: 'UPSTREAM_INTERRUPTED', status: 502 });

  // 1. Google non-stream mid-turn failure before headers -> HTTP 502 + Anthropic error payload
  const gNonRes = createMockRes();
  const gNonDelivery = createResponseDelivery(gNonRes, {
    route: 'google',
    stream: false,
    model: 'gemini-neon',
  });
  await gNonDelivery.accept({ content: 'partial google text', response: { id: 'msg_non_1', model: 'gemini-neon' } });
  await gNonDelivery.interrupt(err);
  assert.equal(gNonRes.statusCode, 502);
  const gNonBody = JSON.parse(gNonRes.body());
  assert.equal(gNonBody.type, 'error');
  assert.equal(gNonBody.error.type, 'api_error');
  assert.equal(gNonBody.error.message, 'UPSTREAM_INTERRUPTED');

  // 2. Gemini non-stream mid-turn failure before headers -> HTTP 502 + Gemini error payload
  const mNonRes = createMockRes();
  const mNonDelivery = createResponseDelivery(mNonRes, {
    route: 'gemini',
    stream: false,
    model: 'gemini-neon',
  });
  await mNonDelivery.accept({ content: 'partial gemini text', response: { id: 'gem_non_1', model: 'gemini-neon' } });
  await mNonDelivery.interrupt(err);
  assert.equal(mNonRes.statusCode, 502);
  const mNonBody = JSON.parse(mNonRes.body());
  assert.equal(mNonBody.error.code, 502);
  assert.equal(mNonBody.error.status, 'INTERNAL');
  assert.equal(mNonBody.error.message, 'UPSTREAM_INTERRUPTED');

  // 3. Google stream mid-stream failure after usable output -> event: error, NO message_stop
  const gStreamRes = createMockRes();
  const gStreamDelivery = createResponseDelivery(gStreamRes, {
    route: 'google',
    stream: true,
    model: 'gemini-neon',
  });
  await gStreamDelivery.accept({ start: true, response: { id: 'msg_fail_1', model: 'gemini-neon' } });
  await gStreamDelivery.accept({ content: 'A'.repeat(2100), response: { id: 'msg_fail_1', model: 'gemini-neon' } });
  await gStreamDelivery.interrupt(err);
  const gStreamText = gStreamRes.body();
  assert.equal(gStreamText.includes('event: message_stop'), false);
  assert.equal(gStreamText.includes('event: error'), true);
  assert.match(gStreamText, /"type":"error".*"type":"api_error"/);

  // 4. Gemini SSE stream:
  // 4a. Mid-stream failure AFTER usable output (>= 2048B) -> graceful STOP finish, NO error object
  const mSseUsableRes = createMockRes();
  const mSseUsableDelivery = createResponseDelivery(mSseUsableRes, {
    route: 'gemini',
    stream: true,
    geminiSse: true,
    model: 'gemini-neon',
  });
  await mSseUsableDelivery.accept({ start: true, response: { id: 'gem_usable_1', model: 'gemini-neon' } });
  await mSseUsableDelivery.accept({ content: 'B'.repeat(2100), response: { id: 'gem_usable_1', model: 'gemini-neon' } });
  await mSseUsableDelivery.interrupt(err);
  const mSseUsableText = mSseUsableRes.body();
  assert.equal(mSseUsableText.includes('"finishReason":"STOP"'), true);
  assert.equal(mSseUsableText.includes('"finishReason":"OTHER"'), false);
  assert.equal(mSseUsableText.includes('"error":{'), false);

  // 4b. Mid-stream failure BEFORE usable output (< 2048B, not postOutputIdleStall) -> error object + finishReason OTHER
  const mSseRes = createMockRes();
  const mSseDelivery = createResponseDelivery(mSseRes, {
    route: 'gemini',
    stream: true,
    geminiSse: true,
    model: 'gemini-neon',
  });
  await mSseDelivery.accept({ start: true, response: { id: 'gem_fail_1', model: 'gemini-neon' } });
  await mSseDelivery.accept({ content: 'short', response: { id: 'gem_fail_1', model: 'gemini-neon' } });
  await mSseDelivery.interrupt(err);
  const mSseText = mSseRes.body();
  assert.equal(mSseText.includes('"finishReason":"STOP"'), false);
  assert.equal(mSseText.includes('"finishReason":"OTHER"'), true);
  assert.equal(mSseText.includes('"error":{'), true);

  // 5. Gemini JSON array stream:
  // 5a. Mid-stream failure AFTER usable output (>= 2048B) -> valid JSON array ending with finishReason STOP, NO error
  const mArrUsableRes = createMockRes();
  const mArrUsableDelivery = createResponseDelivery(mArrUsableRes, {
    route: 'gemini',
    stream: true,
    geminiSse: false,
    model: 'gemini-neon',
  });
  await mArrUsableDelivery.accept({ start: true, response: { id: 'gem_usable_2', model: 'gemini-neon' } });
  await mArrUsableDelivery.accept({ content: 'C'.repeat(2100), response: { id: 'gem_usable_2', model: 'gemini-neon' } });
  await mArrUsableDelivery.interrupt(err);
  const mArrUsableJson = JSON.parse(mArrUsableRes.body());
  assert.ok(Array.isArray(mArrUsableJson) && mArrUsableJson.length >= 2);
  const lastUsable = mArrUsableJson[mArrUsableJson.length - 1];
  assert.equal(lastUsable.error, undefined);
  assert.equal(lastUsable.candidates[0].finishReason, 'STOP');

  // 5b. Mid-stream failure BEFORE usable output (< 2048B) -> valid JSON array ending with error + finishReason OTHER, NO STOP
  const mArrRes = createMockRes();
  const mArrDelivery = createResponseDelivery(mArrRes, {
    route: 'gemini',
    stream: true,
    geminiSse: false,
    model: 'gemini-neon',
  });
  await mArrDelivery.accept({ start: true, response: { id: 'gem_fail_2', model: 'gemini-neon' } });
  await mArrDelivery.accept({ content: 'short', response: { id: 'gem_fail_2', model: 'gemini-neon' } });
  await mArrDelivery.interrupt(err);
  const mArrJson = JSON.parse(mArrRes.body());
  assert.ok(Array.isArray(mArrJson) && mArrJson.length >= 2);
  const last = mArrJson[mArrJson.length - 1];
  assert.equal(last.error.code, 502);
  assert.equal(last.candidates[0].finishReason, 'OTHER');
  assert.equal(mArrRes.body().includes('"finishReason":"STOP"'), false);
});
