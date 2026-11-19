import { afterEach, describe, expect, it } from 'bun:test';
import { createServer } from 'node:net';
import { LoopbackMcpServer, SessionToolBroker } from '../src/acp/loopback-mcp';
import { sanitizeToolDeclarations } from '../src/acp/schema-sanitizer';
import { createApp } from '../src/server';

function makeTools() {
  const { tools } = sanitizeToolDeclarations([
    {
      name: 'slow_tool',
      description: 'A slow tool for timeout/abort testing',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
      },
    },
  ]);
  return tools;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')));
      }
    });
  });
}

describe('LoopbackMcpServer & Gateway 3-layer hardening', () => {
  const originalTimeoutEnv = process.env.AGY_8048_TOOL_CALL_TIMEOUT_MS;
  const originalPortEnv = process.env.AGY_8048_LOOPBACK_MCP_PORT;

  afterEach(() => {
    if (originalTimeoutEnv === undefined) {
      delete process.env.AGY_8048_TOOL_CALL_TIMEOUT_MS;
    } else {
      process.env.AGY_8048_TOOL_CALL_TIMEOUT_MS = originalTimeoutEnv;
    }
    if (originalPortEnv === undefined) {
      delete process.env.AGY_8048_LOOPBACK_MCP_PORT;
    } else {
      process.env.AGY_8048_LOOPBACK_MCP_PORT = originalPortEnv;
    }
  });

  it('1. toolCallTimeoutMs 触发超时并清理 pendingCount === 0', async () => {
    const broker = new SessionToolBroker({
      tools: makeTools(),
      toolCallTimeoutMs: 40,
    });

    const res = await broker.handleJsonRpc({
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: { name: 'slow_tool', arguments: { q: 'hang' } },
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      jsonrpc: string;
      id: number;
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(body.id).toBe(101);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain('Tool call timed out after 40ms (call_id=fc_');
    expect(broker.pendingCount).toBe(0);
  });

  it('2a. AbortSignal 断连取消挂起的 tools/call 并清理 pendingCount === 0', async () => {
    const broker = new SessionToolBroker({
      tools: makeTools(),
      toolCallTimeoutMs: 10_000,
    });
    const controller = new AbortController();

    const pendingPromise = broker.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 202,
        method: 'tools/call',
        params: { name: 'slow_tool', arguments: { q: 'disconnect' } },
      },
      controller.signal,
    );

    // 等待 tools/call 进入 parked 状态
    await new Promise((r) => setTimeout(r, 15));
    expect(broker.pendingCount).toBe(1);

    controller.abort();
    const res = await pendingPromise;
    expect(res.status).toBe(200);
    const body = res.body as {
      id: number;
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(body.id).toBe(202);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe('Client disconnected before tool result arrived');
    expect(broker.pendingCount).toBe(0);
  });

  it('2b. AbortSignal 断连取消挂起的 await_result 并清理 pendingCount === 0', async () => {
    let capturedCallId = '';
    const broker = new SessionToolBroker({
      tools: makeTools(),
      toolCallTimeoutMs: 10_000,
      batchWindowMs: 5,
      onBatchReady: (calls) => {
        capturedCallId = calls[0]?.id ?? '';
      },
    });

    const primaryPromise = broker.handleJsonRpc({
      jsonrpc: '2.0',
      id: 203,
      method: 'tools/call',
      params: { name: 'slow_tool', arguments: { q: 'wait' } },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedCallId).toMatch(/^fc_/);
    expect(broker.pendingCount).toBe(1);

    const awaitController = new AbortController();
    const awaitPromise = broker.handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 204,
        method: 'tools/call',
        params: { name: 'await_result', arguments: { call_id: capturedCallId } },
      },
      awaitController.signal,
    );

    await new Promise((r) => setTimeout(r, 10));
    awaitController.abort();

    const [primaryRes, awaitRes] = await Promise.all([primaryPromise, awaitPromise]);
    expect((awaitRes.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result.isError).toBe(
      true,
    );
    expect(
      (awaitRes.body as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
    ).toBe('Client disconnected before tool result arrived');
    expect(
      (primaryRes.body as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
    ).toBe('Client disconnected before tool result arrived');
    expect(broker.pendingCount).toBe(0);
  });

  it('3a. LoopbackMcpServer 支持传入固定端口与环境变量端口', async () => {
    const fixedPort = await findFreePort();
    const server = new LoopbackMcpServer({ port: fixedPort });
    try {
      expect(server.port).toBe(fixedPort);
      const broker = new SessionToolBroker({ tools: makeTools() });
      const session = server.registerSession(broker);
      expect(session.url).toContain(`http://127.0.0.1:${fixedPort}/mcp/`);

      const res = await fetch(session.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { jsonrpc: string; id: number; result: Record<string, unknown> };
      expect(json).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    } finally {
      server.stop();
    }

    const envPort = await findFreePort();
    process.env.AGY_8048_LOOPBACK_MCP_PORT = String(envPort);
    const envServer = new LoopbackMcpServer();
    try {
      expect(envServer.port).toBe(envPort);
    } finally {
      envServer.stop();
    }
  });

  it('3b. 未知或失效 token 返回 HTTP 401 + 标准 JSON-RPC -32001 并保留请求 id', async () => {
    const server = new LoopbackMcpServer();
    try {
      const deadToken = 'a'.repeat(64);
      const url = `http://127.0.0.1:${server.port}/mcp/${deadToken}`;

      const resWithId = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }),
      });
      expect(resWithId.status).toBe(401);
      const bodyWithId = (await resWithId.json()) as {
        jsonrpc: string;
        id: unknown;
        error: { code: number; message: string };
      };
      expect(bodyWithId).toEqual({
        jsonrpc: '2.0',
        id: 42,
        error: {
          code: -32001,
          message: 'MCP session expired or invalidated (gateway restarted); please reconnect',
        },
      });

      const resBadJson = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid-json',
      });
      expect(resBadJson.status).toBe(401);
      const bodyBadJson = (await resBadJson.json()) as {
        jsonrpc: string;
        id: unknown;
        error: { code: number; message: string };
      };
      expect(bodyBadJson.id).toBeNull();
      expect(bodyBadJson.error.code).toBe(-32001);
    } finally {
      server.stop();
    }
  });

  it('4. POST /api/drain 触发排空并中止在途请求，非回环 Host 被 403 拒绝', async () => {
    const inFlightControllers = new Map<string, AbortController>();
    const c1 = new AbortController();
    const c2 = new AbortController();
    inFlightControllers.set('req-1', c1);
    inFlightControllers.set('req-2', c2);

    const app = createApp({
      geminiDeps: {
        inFlightControllers,
      },
    });

    // 非回环 Host 必须被拒绝
    const forbiddenRes = await app.fetch(
      new Request('http://example.com:8048/api/drain', {
        method: 'POST',
        headers: { host: 'example.com:8048' },
      }),
    );
    expect(forbiddenRes.status).toBe(403);
    expect(c1.signal.aborted).toBe(false);

    // 本机回环 Host 触发排空
    const drainRes = await app.fetch(
      new Request('http://127.0.0.1:8048/api/drain', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: '127.0.0.1:8048' },
        body: JSON.stringify({ reason: 'Unit test drain' }),
      }),
    );
    expect(drainRes.status).toBe(200);
    const json = (await drainRes.json()) as {
      ok: boolean;
      drained: boolean;
      cancelledPending: number;
      abortedInFlight: number;
    };
    expect(json).toEqual({
      ok: true,
      drained: true,
      cancelledPending: 0,
      abortedInFlight: 2,
    });
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(inFlightControllers.size).toBe(0);
  });
});
