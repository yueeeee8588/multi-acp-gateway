import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import {
  openDirectTurn,
  buildNativeHttp2PoolKey,
  closeNativeHttp2Pool,
  getNativeHttp2PoolStats,
  NATIVE_ORIGIN,
} from '../src/gateway/native-transport.mjs';
import {
  getOutboundHttpsAgent,
  destroyOutboundProxyAgents,
} from '../src/gateway/outbound-proxy.mjs';
import { frameGrpcMessage } from '../native-wire/robin-current.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
import { StateStore } from '../src/gateway/state.mjs';
import { createGateway } from '../src/gateway/app.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-8049-w3-'));
}

function makeFakeAccounts() {
  const list = [
    { id: 'acc_w3_1', email: 'w3@example.com', enabled: true, status: 'ready' },
  ];
  return {
    list: () => list,
    getValidAccessToken: async () => 'secret-oauth-token-never-log',
    recordProviderSuccess: () => {},
    recordUpstreamError: () => {},
    close: async () => {},
  };
}

function successGrpcFrame(text = 'ok') {
  return frameGrpcMessage(
    m(
      1003,
      m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from(text)))), v(9, 1), v(41, 3), v(42, 2)])),
    ),
  );
}

test('W3-A1: HTTP/2 session pool reuses session across sequential and concurrent turns and stop() only closes stream', async (t) => {
  let serverSessions = 0;
  const server = http2.createServer();
  server.on('session', () => {
    serverSessions++;
  });
  server.on('stream', (stream) => {
    stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(successGrpcFrame('pooled'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await closeNativeHttp2Pool({ force: true });
    await new Promise((r) => server.close(r));
  });

  let connectCalls = 0;
  const connect = () => {
    connectCalls++;
    return http2.connect(`http://127.0.0.1:${server.address().port}`);
  };

  // Concurrent turns share one ClientHttp2Session.
  const turn1 = openDirectTurn(
    'synthetic-token',
    { messages: [{ role: 'user', content: 'first' }] },
    { connect, pool: true, idleTimeoutMs: 5000 },
  );
  const turn2 = openDirectTurn(
    'synthetic-token',
    { messages: [{ role: 'user', content: 'second' }] },
    { connect, pool: true, idleTimeoutMs: 5000 },
  );
  assert.equal(connectCalls, 1);
  assert.equal(getNativeHttp2PoolStats().activeStreams, 2);

  for await (const ev of turn1.events) if (ev.type === 'end') break;
  turn1.cancel();
  for await (const ev of turn2.events) if (ev.type === 'end') break;
  turn2.cancel();

  // Session remains open in the pool after stream stop()/cancel().
  assert.equal(getNativeHttp2PoolStats().sessions, 1);
  assert.equal(getNativeHttp2PoolStats().activeStreams, 0);

  // Subsequent turn reuses the same session.
  const turn3 = openDirectTurn(
    'synthetic-token',
    { messages: [{ role: 'user', content: 'third' }] },
    { connect, pool: true, idleTimeoutMs: 5000 },
  );
  for await (const ev of turn3.events) if (ev.type === 'end') break;
  turn3.cancel();

  assert.equal(connectCalls, 1);
  assert.equal(serverSessions, 1);

  await closeNativeHttp2Pool();
  assert.equal(getNativeHttp2PoolStats().sessions, 0);
});

test('W3-A2: HTTP/2 pool key isolates direct vs proxyUrl and evicts on goaway/close/idle', async (t) => {
  assert.equal(buildNativeHttp2PoolKey(NATIVE_ORIGIN, {}), `${NATIVE_ORIGIN}|direct`);
  assert.equal(
    buildNativeHttp2PoolKey(NATIVE_ORIGIN, { HTTPS_PROXY: 'http://127.0.0.1:8888' }),
    `${NATIVE_ORIGIN}|http://127.0.0.1:8888/`,
  );

  let sessionIndex = 0;
  const serverSessions = [];
  const server = http2.createServer();
  server.on('session', (s) => {
    serverSessions.push(s);
  });
  server.on('stream', (stream) => {
    stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(successGrpcFrame('ok'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await closeNativeHttp2Pool({ force: true });
    await new Promise((r) => server.close(r));
  });

  const connect = () => {
    sessionIndex++;
    return http2.connect(`http://127.0.0.1:${server.address().port}`);
  };

  // First turn creates session #1.
  const t1 = openDirectTurn(
    'synthetic-token',
    { messages: [{ role: 'user', content: 'one' }] },
    { connect, pool: true, idleTimeoutMs: 60 },
  );
  for await (const ev of t1.events) if (ev.type === 'end') break;
  t1.cancel();
  assert.equal(sessionIndex, 1);

  // Peer sends GOAWAY -> session #1 is evicted.
  serverSessions[0].goaway(0);
  await new Promise((r) => setTimeout(r, 25));

  // Next turn rebuilds session #2.
  const t2 = openDirectTurn(
    'synthetic-token',
    { messages: [{ role: 'user', content: 'two' }] },
    { connect, pool: true, idleTimeoutMs: 60 },
  );
  for await (const ev of t2.events) if (ev.type === 'end') break;
  t2.cancel();
  assert.equal(sessionIndex, 2);

  // Idle timeout (60ms) cleans up session #2.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(getNativeHttp2PoolStats().sessions, 0);
});

test('W3-A3: exhausting turn.events via for-await without cancel() releases pooled stream refcount and triggers idle eviction', async (t) => {
  const server = http2.createServer();
  server.on('stream', (stream) => {
    stream.resume();
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(successGrpcFrame('exhausted'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await closeNativeHttp2Pool({ force: true });
    await new Promise((r) => server.close(r));
  });

  const connect = () => http2.connect(`http://127.0.0.1:${server.address().port}`);
  const turn = openDirectTurn(
    'synthetic-token',
    { messages: [{ role: 'user', content: 'exhaust-without-cancel' }] },
    { connect, pool: true, idleTimeoutMs: 60 },
  );
  assert.equal(getNativeHttp2PoolStats().activeStreams, 1);

  const seenTypes = [];
  for await (const ev of turn.events) {
    seenTypes.push(ev.type);
  }
  assert.ok(seenTypes.includes('frame'));
  assert.equal(seenTypes.at(-1), 'end');

  // Even without calling turn.cancel(), activeStreams must drop to 0.
  assert.equal(getNativeHttp2PoolStats().sessions, 1);
  assert.equal(getNativeHttp2PoolStats().activeStreams, 0);

  // Subsequent cancel() remains idempotent.
  turn.cancel();
  assert.equal(getNativeHttp2PoolStats().activeStreams, 0);

  // Idle timeout cleans up the unreffed session.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(getNativeHttp2PoolStats().sessions, 0);
});

test('W3-B: outbound-proxy caches keepAlive HTTPS agents (maxSockets: 16) per direct/proxy key', (t) => {
  t.after(() => destroyOutboundProxyAgents());

  const direct1 = getOutboundHttpsAgent();
  const direct2 = getOutboundHttpsAgent();
  assert.equal(direct1, direct2);
  assert.equal(direct1.keepAlive, true);
  assert.equal(direct1.maxSockets, 16);

  const proxyA = getOutboundHttpsAgent({ proxyUrl: new URL('http://127.0.0.1:8080') });
  const proxyA2 = getOutboundHttpsAgent({ proxyUrl: new URL('http://127.0.0.1:8080') });
  const proxyB = getOutboundHttpsAgent({ proxyUrl: new URL('http://127.0.0.1:8081') });
  assert.equal(proxyA, proxyA2);
  assert.notEqual(proxyA, direct1);
  assert.notEqual(proxyA, proxyB);
  assert.equal(proxyA.keepAlive, true);
  assert.equal(proxyA.maxSockets, 16);

  destroyOutboundProxyAgents();
  const direct3 = getOutboundHttpsAgent();
  assert.notEqual(direct3, direct1);
});

test('W3-C & W3-D: all SSE routes emit early 200 keepalive headers and stdout emits sanitized request.finished JSON', async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new StateStore({
    directory: dir,
    defaultProfile: {
      context: 2,
      enableFst: true,
      clientId: '123456-abcdef.apps.googleusercontent.com',
      clientSecret: 'secret',
      scopes: ['openid', 'email'],
    },
  });
  store.lock();
  t.after(() => store.unlock());
  const { key: apiKey } = store.createKey('w3-test-key');

  const slowProvider = {
    sessions: new Map(),
    async runTurn(_accountId, canonical, deliver) {
      await new Promise((r) => setTimeout(r, 80));
      await deliver({ start: true, response: { id: 'resp_w3_1', model: canonical.model } });
      const text = 'SecretReplyTextShouldNotBeLogged';
      await deliver({ content: text, response: { id: 'resp_w3_1', model: canonical.model } });
      return {
        id: 'resp_w3_1',
        created: 1700000000,
        model: canonical.model,
        content: text,
        calls: [],
        thinkingLevel: canonical.thinking_level ?? 2,
        resolvedModeCategory: 3,
      };
    },
  };

  const gw = createGateway({
    store,
    accounts: makeFakeAccounts(),
    provider: slowProvider,
    keepaliveHeadersDelayMs: 25,
  });
  const baseUrl = await gw.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => gw.close());

  // Capture stdout lines emitted by app.mjs finally block.
  const logLines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of str.split('\n')) {
      if (line.trim().startsWith('{') && line.includes('"request.finished"')) {
        logLines.push(line.trim());
      }
    }
    return origWrite(chunk, encoding, cb);
  };
  t.after(() => {
    process.stdout.write = origWrite;
  });

  const sseCases = [
    {
      name: 'chat',
      path: '/v1/chat/completions',
      body: {
        model: 'gemini-neon',
        stream: true,
        messages: [{ role: 'user', content: 'SensitivePromptUserContent' }],
      },
    },
    {
      name: 'responses',
      path: '/v1/responses',
      body: {
        model: 'gemini-neon',
        stream: true,
        input: 'SensitivePromptUserContent',
      },
    },
    {
      name: 'google',
      path: '/v1/messages',
      body: {
        model: 'gemini-neon',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'SensitivePromptUserContent' }],
      },
    },
    {
      name: 'gemini',
      path: '/v1beta/models/gemini-neon:streamGenerateContent?alt=sse',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'SensitivePromptUserContent' }] }],
      },
    },
  ];

  for (const tc of sseCases) {
    const res = await fetch(`${baseUrl}${tc.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(tc.body),
    });
    assert.equal(res.status, 200, `${tc.name} status`);
    assert.equal(
      res.headers.get('x-gemini-keepalive-headers'),
      '1',
      `${tc.name} should emit early keepalive headers`,
    );
    const bodyText = await res.text();
    assert.ok(bodyText.startsWith(': keepalive\n\n'), `${tc.name} should start with SSE keepalive comment`);
  }

  // Non-streaming request must NOT emit keepalive headers.
  const nonStreamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gemini-neon',
      stream: false,
      messages: [{ role: 'user', content: 'SensitivePromptUserContent' }],
    }),
  });
  assert.equal(nonStreamRes.status, 200);
  assert.equal(nonStreamRes.headers.get('x-gemini-keepalive-headers'), null);

  assert.equal(logLines.length, 5);
  for (const raw of logLines) {
    const entry = JSON.parse(raw);
    assert.equal(entry.event, 'request.finished');
    assert.ok(typeof entry.time === 'string' && !Number.isNaN(Date.parse(entry.time)));
    assert.ok(entry.reqId.startsWith('req_'));
    assert.ok(['chat', 'responses', 'google', 'gemini'].includes(entry.route));
    assert.equal(entry.accountId, 'acc_w3_1');
    assert.equal(entry.status, 200);
    assert.equal(entry.attempts, 1);
    assert.equal(typeof entry.ttftMs, 'number');
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(entry.failoverReason, null);
    assert.equal(entry.errorCode, null);

    // Ensure no prompt, reply, token, cookie, or API key leaked into log line.
    assert.equal(raw.includes('SensitivePromptUserContent'), false);
    assert.equal(raw.includes('SecretReplyTextShouldNotBeLogged'), false);
    assert.equal(raw.includes('secret-oauth-token-never-log'), false);
    assert.equal(raw.includes(apiKey), false);
  }
});

test('W3-C2: GATEWAY_KEEPALIVE_HEADERS_DELAY_MS env overrides default 12000ms', async (t) => {
  const prev = process.env.GATEWAY_KEEPALIVE_HEADERS_DELAY_MS;
  process.env.GATEWAY_KEEPALIVE_HEADERS_DELAY_MS = '20';
  t.after(() => {
    if (prev === undefined) delete process.env.GATEWAY_KEEPALIVE_HEADERS_DELAY_MS;
    else process.env.GATEWAY_KEEPALIVE_HEADERS_DELAY_MS = prev;
  });

  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore({
    directory: dir,
    defaultProfile: {
      context: 2,
      enableFst: true,
      clientId: '123456-abcdef.apps.googleusercontent.com',
      clientSecret: 'secret',
      scopes: ['openid', 'email'],
    },
  });
  store.lock();
  t.after(() => store.unlock());
  const { key: apiKey } = store.createKey('w3-env-key');

  const gw = createGateway({
    store,
    accounts: makeFakeAccounts(),
    provider: {
      sessions: new Map(),
      async runTurn(_acc, canonical, deliver) {
        await new Promise((r) => setTimeout(r, 60));
        await deliver({ start: true, response: { id: 'resp_env', model: canonical.model } });
        await deliver({ content: 'ok', response: { id: 'resp_env', model: canonical.model } });
        return { id: 'resp_env', created: 1700000000, model: canonical.model, content: 'ok', calls: [] };
      },
    },
  });
  const baseUrl = await gw.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => gw.close());

  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gemini-neon', stream: true, input: 'hi' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gemini-keepalive-headers'), '1');
  const text = await res.text();
  assert.ok(text.startsWith(': keepalive\n\n'));
});
