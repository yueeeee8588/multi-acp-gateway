import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import {
  AgySessionWorker,
  WorkerError,
  type AcpTransport,
  type AcpTransportFactory,
} from '../src/acp/worker';
import { AccountScheduler, normalizeModelFamily } from '../src/accounts/scheduler';
import { store } from '../src/db/store';
import { createApp } from '../src/server';
import type { SchedulerLike, WorkerHandle, WorkerPoolLike } from '../src/gemini/handler';
import type { AccountRecord, GeminiGenerateRequest } from '../src/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeAccount(id: string, tier: AccountRecord['tier'] = 'standard'): AccountRecord {
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
    tier,
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface ToolListBody {
  result?: { tools?: Array<{ name: string }> };
}

/**
 * Mock ACP transport：newSession 时记住网关注入的 loopback MCP url，
 * prompt() 通过该 url 发起 tools/call 并挂起等待 functionResponse 回灌。
 * 这正是历史上会触发 409 死锁的拓扑。
 */
class MockToolCallingTransport implements AcpTransport {
  public promptCalls = 0;
  public mcpUrl = '';
  public lastToolName = '';
  public lastToolResult: unknown = null;

  constructor(private readonly onUpdate: (params: Record<string, unknown>) => void) {}

  async initialize(): Promise<unknown> {
    return { ok: true };
  }

  async newSession(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    const servers = (params.mcpServers ?? []) as Array<{ url?: string }>;
    this.mcpUrl = servers[0]?.url ?? '';
    return { sessionId: 'sess-mock-1' };
  }

  async setModel(): Promise<unknown> {
    return {};
  }

  prompt(): Promise<unknown> {
    this.promptCalls += 1;
    const url = this.mcpUrl;
    return (async () => {
      const listBody = (await this.rpc(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })) as ToolListBody;
      const tools = listBody.result?.tools ?? [];
      this.lastToolName = tools.find((t) => t.name !== 'await_result')?.name ?? '';

      // 关键：这里会一直挂起，直到网关通过 deliverResults 回灌工具结果
      const callBody = await this.rpc(url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: this.lastToolName, arguments: { q: 'ping' } },
      });
      this.lastToolResult = callBody;

      // 拿到工具结果后，模型继续输出最终文本
      this.onUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'final answer' },
        },
      });
      return {};
    })();
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isAlive(): boolean {
    return true;
  }

  private async rpc(url: string, payload: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }
}

/** 永不产生任何事件、且 prompt 永挂起的静默 transport，用于看门狗测试 */
class SilentTransport implements AcpTransport {
  constructor(private readonly onUpdate: (params: Record<string, unknown>) => void) {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: 'silent-1' };
  }
  async setModel(): Promise<unknown> {
    return {};
  }
  prompt(): Promise<unknown> {
    return new Promise(() => {});
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isAlive(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 1. 工具调用死锁回归：两轮复用同一 prompt()、无 409
// ---------------------------------------------------------------------------

describe('tool deadlock & stream guard', () => {
  it('round 1 returns functionCall in <500ms and round 2 reuses the same in-flight prompt() to finish', async () => {
    const mcpServer = new LoopbackMcpServer();
    const account = makeAccount('acc-deadlock');
    let transport: MockToolCallingTransport | null = null;

    const transportFactory: AcpTransportFactory = (opts) => {
      transport = new MockToolCallingTransport(opts.onUpdate);
      return transport;
    };

    const worker = new AgySessionWorker({
      account,
      model: 'gemini-2.5-flash',
      mcpServer,
      transportFactory,
    });

    try {
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'lookup_data',
              description: 'Look up data',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          ],
        },
      ];
      const contents: GeminiGenerateRequest['contents'] = [
        { role: 'user', parts: [{ text: 'please call the tool' }] },
      ];
      const request: GeminiGenerateRequest = {
        systemInstruction: { parts: [{ text: 'deadlock test' }] },
        tools,
        contents,
      };

      // ---- Round 1: 必须在 500ms 内把 functionCall 交还给客户端 ----
      const t0 = Date.now();
      const r1 = await withTimeout(worker.executePrompt(request), 2000, 'round1');
      const round1Ms = Date.now() - t0;
      expect(round1Ms).toBeLessThan(500);

      const fc = r1.parts.find((p) => p.functionCall)?.functionCall;
      expect(fc).toBeDefined();
      expect(fc!.name).toBe('lookup_data');
      expect(typeof fc!.id).toBe('string');
      expect(transport!.promptCalls).toBe(1);

      // ---- Round 2: 带 functionResponse 复用同一挂起的 prompt() ----
      contents.push({
        role: 'model',
        parts: [{ functionCall: { id: fc!.id, name: fc!.name, args: fc!.args ?? {} } }],
      });
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: fc!.id,
              name: fc!.name,
              response: { ok: true, value: 42 },
            },
          },
        ],
      });

      const r2 = await withTimeout(worker.executePrompt(request), 3000, 'round2');
      const text = r2.parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
      expect(text).toContain('final answer');

      // 全程只调用了 1 次 prompt()，说明第二轮复用了挂起的会话
      expect(transport!.promptCalls).toBe(1);
      expect(transport!.lastToolResult).not.toBeNull();
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 2. 已发首包禁重试保护
  // -------------------------------------------------------------------------

  it('does not retry or switch accounts once the first stream chunk has been emitted', async () => {
    const account = makeAccount('acc-stream-guard');
    let selectCount = 0;
    let acquireCount = 0;

    const scheduler: SchedulerLike = {
      selectAccount() {
        selectCount += 1;
        return { account };
      },
      reportSuccess() {},
      reportFailure() {
        return {};
      },
      abandonSession() {},
    };

    const workerPool: WorkerPoolLike = {
      async acquire(): Promise<WorkerHandle> {
        acquireCount += 1;
        return {
          id: `worker-${acquireCount}`,
          accountId: account.id,
          async generate({ onChunk }) {
            onChunk?.({
              candidates: [
                { index: 0, content: { role: 'model', parts: [{ text: 'partial output' }] } },
              ],
            });
            // 首包已发出后抛一个「可重试」类错误（timeout → retryable）
            throw new Error('upstream timeout while streaming');
          },
        };
      },
      release() {},
    };

    const app = createApp({ geminiDeps: { scheduler, workerPool } });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const res = await fetch(
        `${baseUrl}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('partial output');

      expect(acquireCount).toBe(1);
      expect(selectCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  // -------------------------------------------------------------------------
  // 3. 空闲看门狗
  // -------------------------------------------------------------------------

  it('AgySessionWorker idle watchdog aborts with TIMEOUT when no events arrive', async () => {
    const mcpServer = new LoopbackMcpServer();
    const account = makeAccount('acc-idle');
    const transportFactory: AcpTransportFactory = (opts) => new SilentTransport(opts.onUpdate);

    const worker = new AgySessionWorker({
      account,
      model: 'gemini-2.5-flash',
      mcpServer,
      transportFactory,
      idleTimeoutMs: 120,
    });

    try {
      let caught: unknown;
      try {
        await withTimeout(
          worker.executePrompt({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
          2000,
          'idle watchdog',
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WorkerError);
      expect((caught as WorkerError).code).toBe('TIMEOUT');
      expect((caught as WorkerError).upstreamStatus).toBe(504);
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 4. pro 优先调度 + 非 429 短避让
  // -------------------------------------------------------------------------

  it('prefers tier=pro accounts and applies only a 10s soft-avoid for non-429 errors', async () => {
    const scheduler = new AccountScheduler();
    const model = 'test-tier-model';
    const family = normalizeModelFamily(model);
    const proId = `__test_pro_${Date.now().toString(36)}`;
    const stdId = `__test_std_${Date.now().toString(36)}`;

    const proAccount = makeAccount(proId, 'pro');
    const stdAccount = makeAccount(stdId, 'standard');
    store.upsertAccount(proAccount);
    store.upsertAccount(stdAccount);

    try {
      // --- pro 优先 ---
      const picked = await scheduler.acquireAccount(model);
      expect(picked.tier).toBe('pro');

      // --- 非 429 瞬时错误：仅 10s 短避让且 consecutiveFailures 保持 1 ---
      scheduler.recordFailure(proId, model, {
        upstreamStatus: 504,
        reasonCode: 'TIMEOUT',
        rawError: 'stream idle timeout',
      });
      let cd = store
        .listCooldowns(0)
        .find((c) => c.accountId === proId && c.family === family && c.scopeType === 'family');
      expect(cd).toBeDefined();
      const soft1 = cd!.untilMs - Date.now();
      expect(soft1).toBeGreaterThan(8000);
      expect(soft1).toBeLessThanOrEqual(10_500);
      expect(cd!.consecutiveFailures).toBe(1);

      // 连续第二次瞬时错误仍然只有 10s 短避让，不叠加到长冷却
      scheduler.recordFailure(proId, model, {
        upstreamStatus: 500,
        reasonCode: 'SOFT_ERROR',
        rawError: 'internal error',
      });
      cd = store
        .listCooldowns(0)
        .find((c) => c.accountId === proId && c.family === family && c.scopeType === 'family');
      const soft2 = cd!.untilMs - Date.now();
      expect(soft2).toBeLessThanOrEqual(10_500);
      expect(cd!.consecutiveFailures).toBe(1);
      expect(store.deleteCooldown(proId, family, 'family')).toBe(true);

      // --- 429 配额错误走 1/5 分钟长冷却阶梯 ---
      scheduler.recordFailure(stdId, model, { upstreamStatus: 429, reasonCode: 'QUOTA_EXHAUSTED' });
      let qcd = store
        .listCooldowns(0)
        .find((c) => c.accountId === stdId && c.family === family && c.scopeType === 'family');
      const quota1 = qcd!.untilMs - Date.now();
      expect(quota1).toBeGreaterThan(59_000);
      expect(quota1).toBeLessThanOrEqual(60_500);
      expect(qcd!.consecutiveFailures).toBe(1);

      scheduler.recordFailure(stdId, model, { upstreamStatus: 429, reasonCode: 'QUOTA_EXHAUSTED' });
      qcd = store
        .listCooldowns(0)
        .find((c) => c.accountId === stdId && c.family === family && c.scopeType === 'family');
      const quota2 = qcd!.untilMs - Date.now();
      expect(quota2).toBeGreaterThan(299_000);
      expect(quota2).toBeLessThanOrEqual(300_500);
      expect(qcd!.consecutiveFailures).toBe(2);
      expect(store.deleteCooldown(stdId, family, 'family')).toBe(true);
    } finally {
      store.deleteCooldown(proId, family, 'family');
      store.deleteCooldown(stdId, family, 'family');
      store.deleteAccount(proId);
      store.deleteAccount(stdId);
    }
  });
});
