import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  __setTcpConnectProbeForTest,
  checkProxyReachable,
  detectExitIpDrift,
} from "../src/accounts/exit-probe";
import {
  __setAcpProbeDepsForTest,
  __setTierDetectFetcher,
  accountManager,
} from "../src/accounts/manager";
import { AccountScheduler, AllAccountsCooldownError, accountScheduler } from "../src/accounts/scheduler";
import { buildIsolatedAgyEnv } from "../src/acp/env";
import { LoopbackMcpServer } from "../src/acp/loopback-mcp";
import { AcpWorkerPool } from "../src/acp/pool";
import { AgySessionWorker, WorkerError, type AcpTransport } from "../src/acp/worker";
import { getConfig, resolveEffectiveProxy, updateConfig } from "../src/config/settings";
import { store } from "../src/db/store";
import type { AccountRecord, AccountStatus, GatewayConfig } from "../src/types";

const tempDirs: string[] = [];
const createdAccountIds: string[] = [];
const originalFetch = globalThis.fetch;
const originalConfigSnapshot: GatewayConfig = { ...getConfig() };

function createTempDummyBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-test-"));
  const binPath = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  fs.writeFileSync(binPath, "", "utf8");
  tempDirs.push(dir);
  return binPath;
}

function createTempAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  const id = `test-proxy-drift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-proxy-drift-"));
  const oauthDir = path.join(homeDir, ".gemini", "antigravity-cli");
  fs.mkdirSync(oauthDir, { recursive: true });
  fs.writeFileSync(
    path.join(oauthDir, "antigravity-oauth-token"),
    JSON.stringify({ refresh_token: "test-refresh-token" }),
    "utf8",
  );

  const now = Date.now();
  const acc: AccountRecord = {
    id,
    label: `Test-${id}`,
    email: `${id}@example.com`,
    source: "test",
    homeDir,
    proxyUrl: "",
    status: "ready" as AccountStatus,
    tier: "standard",
    statusReason: "",
    exitIp: "1.2.3.4",
    exitCountry: "JP",
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: now - 60_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };

  store.upsertAccount(acc);
  tempDirs.push(homeDir);
  createdAccountIds.push(id);
  return acc;
}

function mockOAuthAndTierFetch(): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "test-access-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

  __setTierDetectFetcher((async () =>
    new Response(JSON.stringify({ paidTier: { id: "g1-pro-tier" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch);
}

function createMockTransport(
  onUpdate?: (params: Record<string, unknown>) => void,
  onPromptText = "ok",
): AcpTransport {
  return {
    async initialize() {
      return { raw: { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } } };
    },
    async newSession() {
      return { sessionId: "sess-mock-1" };
    },
    async setModel() {
      return {};
    },
    async prompt() {
      onUpdate?.({
        sessionId: "sess-mock-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: onPromptText },
        },
      });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
    async close() {},
    isAlive() {
      return true;
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setTierDetectFetcher(originalFetch);
  __setAcpProbeDepsForTest({});
  __setTcpConnectProbeForTest(null);
  updateConfig({
    defaultProxy: originalConfigSnapshot.defaultProxy,
    strictProxyBinding: originalConfigSnapshot.strictProxyBinding,
    blockOnExitIpDrift: originalConfigSnapshot.blockOnExitIpDrift,
    maxWorkerSpawnsPerMinute: originalConfigSnapshot.maxWorkerSpawnsPerMinute,
  });

  while (createdAccountIds.length > 0) {
    const id = createdAccountIds.pop()!;
    store.deleteAccount(id);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkProxyReachable (local loopback TCP)", () => {
  it("returns ok=true for listening loopback port and ok=false for closed port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as net.AddressInfo;
    const proxyUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const openRes = await checkProxyReachable(proxyUrl, 1000);
      expect(openRes.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const closedRes = await checkProxyReachable(proxyUrl, 1000);
    expect(closedRes.ok).toBe(false);
    expect(closedRes.error).toBeTruthy();
  });

  it("returns ok=false on invalid proxy URL", async () => {
    const res = await checkProxyReachable("://not-a-valid-url", 500);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("Worker & Pool defaultProxy fallback + strictProxyBinding", () => {
  it("falls back to global defaultProxy when account.proxyUrl is empty", async () => {
    const globalProxy = "http://127.0.0.1:17890";
    updateConfig({ defaultProxy: globalProxy, strictProxyBinding: true });

    const probedTargets: Array<{ host: string; port: number }> = [];
    __setTcpConnectProbeForTest(async (host, port) => {
      probedTargets.push({ host, port });
      return { ok: true };
    });

    const acc = createTempAccount({ proxyUrl: "" });
    const dummyBin = createTempDummyBinary();
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let capturedEnv: Record<string, string> | undefined;
    try {
      const worker = new AgySessionWorker({
        account: acc,
        model: "gemini-3.8-flash-low",
        agyPath: dummyBin,
        mcpServer,
        workspaceDir: acc.homeDir,
        transportFactory: (opts) => {
          capturedEnv = opts.env;
          return createMockTransport(opts.onUpdate);
        },
      });

      await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });

      expect(probedTargets).toEqual([{ host: "127.0.0.1", port: 17890 }]);
      expect(capturedEnv?.HTTP_PROXY).toBe(globalProxy);
      expect(capturedEnv?.HTTPS_PROXY).toBe(globalProxy);
      expect(capturedEnv?.ALL_PROXY).toBe(globalProxy);
      await worker.resetAndClose();
    } finally {
      await mcpServer.stop();
    }
  });

  it("prewarmAccount in AcpWorkerPool also uses defaultProxy when account.proxyUrl is empty", async () => {
    const globalProxy = "http://127.0.0.1:17891";
    updateConfig({ defaultProxy: globalProxy, strictProxyBinding: true });
    __setTcpConnectProbeForTest(async () => ({ ok: true }));

    const acc = createTempAccount({ proxyUrl: "" });
    const dummyBin = createTempDummyBinary();
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let capturedEnv: Record<string, string> | undefined;
    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: dummyBin,
      workspaceDir: acc.homeDir,
      prewarmPerAccount: 1,
      maxPrewarmTotal: 2,
      transportFactory: (opts) => {
        capturedEnv = opts.env;
        return createMockTransport();
      },
    });

    try {
      const ok = await pool.prewarmAccount(acc);
      expect(ok).toBe(true);
      expect(capturedEnv?.HTTP_PROXY).toBe(globalProxy);
      expect(capturedEnv?.HTTPS_PROXY).toBe(globalProxy);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it("fails fast without spawning agy.exe when strictProxyBinding=true and proxy is unreachable", async () => {
    updateConfig({ defaultProxy: "http://127.0.0.1:19999", strictProxyBinding: true });
    __setTcpConnectProbeForTest(async () => ({ ok: false, error: "ECONNREFUSED" }));

    const acc = createTempAccount({ proxyUrl: "" });
    const dummyBin = createTempDummyBinary();
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let spawnCount = 0;
    try {
      const worker = new AgySessionWorker({
        account: acc,
        model: "gemini-3.8-flash-low",
        agyPath: dummyBin,
        mcpServer,
        workspaceDir: acc.homeDir,
        transportFactory: () => {
          spawnCount++;
          return createMockTransport();
        },
      });

      let caught: unknown;
      try {
        await worker.executePrompt({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WorkerError);
      expect((caught as Error).message).toContain("Proxy unreachable (strictProxyBinding=true)");
      expect(spawnCount).toBe(0);
    } finally {
      await mcpServer.stop();
    }
  });

  it("does not block when strictProxyBinding=false or when no proxy is configured", async () => {
    const accNoProxy = createTempAccount({ proxyUrl: "" });
    const dummyBin = createTempDummyBinary();
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let probeCallCount = 0;
    __setTcpConnectProbeForTest(async () => {
      probeCallCount++;
      return { ok: false, error: "ECONNREFUSED" };
    });

    try {
      // Case A: no proxy at all (even with strictProxyBinding=true) -> skip TCP probe
      updateConfig({ defaultProxy: "", strictProxyBinding: true });
      expect(resolveEffectiveProxy(accNoProxy.proxyUrl)).toBeUndefined();

      let spawnCountA = 0;
      const workerA = new AgySessionWorker({
        account: accNoProxy,
        model: "gemini-3.8-flash-low",
        agyPath: dummyBin,
        mcpServer,
        workspaceDir: accNoProxy.homeDir,
        transportFactory: (opts) => {
          spawnCountA++;
          return createMockTransport(opts.onUpdate);
        },
      });
      await workerA.executePrompt({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
      expect(probeCallCount).toBe(0);
      expect(spawnCountA).toBe(1);
      await workerA.resetAndClose();

      // Case B: proxy set, strictProxyBinding=false -> does not block even if unreachable
      updateConfig({ defaultProxy: "http://127.0.0.1:19998", strictProxyBinding: false });
      let spawnCountB = 0;
      const workerB = new AgySessionWorker({
        account: accNoProxy,
        model: "gemini-3.8-flash-low",
        agyPath: dummyBin,
        mcpServer,
        workspaceDir: accNoProxy.homeDir,
        transportFactory: (opts) => {
          spawnCountB++;
          return createMockTransport(opts.onUpdate);
        },
      });
      await workerB.executePrompt({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
      expect(probeCallCount).toBe(0);
      expect(spawnCountB).toBe(1);
      await workerB.resetAndClose();
    } finally {
      await mcpServer.stop();
    }
  });

  it("records worker spawn in accountScheduler on cold start", async () => {
    updateConfig({ defaultProxy: "", strictProxyBinding: false, maxWorkerSpawnsPerMinute: 1 });
    const dummyBin = createTempDummyBinary();
    const acc = createTempAccount({ proxyUrl: "" });
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    try {
      expect(accountScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(false);

      const worker = new AgySessionWorker({
        account: acc,
        model: "gemini-3.8-flash-low",
        agyPath: dummyBin,
        mcpServer,
        workspaceDir: acc.homeDir,
        transportFactory: (opts) => createMockTransport(opts.onUpdate),
      });

      await worker.executePrompt({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
      expect(accountScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(true);
      await worker.resetAndClose();
    } finally {
      await mcpServer.stop();
    }
  });
});

describe("AccountManager.refreshAccount strictProxyBinding & exit IP drift", () => {
  it("fails fast in refreshAccount when strictProxyBinding=true and proxy is unreachable", async () => {
    updateConfig({ defaultProxy: "http://127.0.0.1:19997", strictProxyBinding: true });
    __setTcpConnectProbeForTest(async () => ({ ok: false, error: "ECONNREFUSED" }));

    const acc = createTempAccount({ proxyUrl: "" });
    let probeExitCalled = false;
    let acpConnCalled = false;

    __setAcpProbeDepsForTest({
      probeExit: async () => {
        probeExitCalled = true;
        return { exitIp: "1.2.3.4", exitCountry: "JP", probeOk: true };
      },
      createConnection: () => {
        acpConnCalled = true;
        return {
          async initialize() {},
          async request<T>() {
            return {} as T;
          },
          close() {},
        };
      },
    });

    await expect(accountManager.refreshAccount(acc.id)).rejects.toThrow(
      "Proxy unreachable (strictProxyBinding=true)",
    );
    expect(probeExitCalled).toBe(false);
    expect(acpConnCalled).toBe(false);
  });

  it("marks account restricted with drift reason when blockOnExitIpDrift=true", async () => {
    updateConfig({ defaultProxy: "", blockOnExitIpDrift: true });
    mockOAuthAndTierFetch();

    const acc = createTempAccount({ exitIp: "1.2.3.4", exitCountry: "JP", status: "ready" });
    let acpConnCalled = false;
    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "5.6.7.8", exitCountry: "US", probeOk: true }),
      createConnection: () => {
        acpConnCalled = true;
        return {
          async initialize() {},
          async request<T>() {
            return {} as T;
          },
          close() {},
        };
      },
    });

    const updated = await accountManager.refreshAccount(acc.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("restricted");
    expect(updated!.statusReason).toBe("Exit IP drift detected: 1.2.3.4 (JP) -> 5.6.7.8 (US)");
    expect(updated!.exitIp).toBe("1.2.3.4");
    expect(updated!.exitCountry).toBe("JP");
    expect(acpConnCalled).toBe(false);
  });

  it("updates exitIp without restricting when blockOnExitIpDrift=false", async () => {
    updateConfig({ defaultProxy: "", blockOnExitIpDrift: false });
    mockOAuthAndTierFetch();

    const acc = createTempAccount({ exitIp: "1.2.3.4", exitCountry: "JP", status: "ready" });
    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "5.6.7.8", exitCountry: "US", probeOk: true }),
      createConnection: () => ({
        async initialize() {},
        async request<T>(method: string) {
          if (method === "session/new") return { sessionId: "sess-drift-ok" } as T;
          return {} as T;
        },
        close() {},
      }),
    });

    const updated = await accountManager.refreshAccount(acc.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("ready");
    expect(updated!.statusReason).toBe("");
    expect(updated!.exitIp).toBe("5.6.7.8");
    expect(updated!.exitCountry).toBe("US");
  });

  it("preserves lastVerifiedAt and records failure reason when exit probe fails (probeOk=false)", async () => {
    updateConfig({ defaultProxy: "", blockOnExitIpDrift: true });
    mockOAuthAndTierFetch();

    const initialVerifiedAt = Date.now() - 120_000;
    const acc = createTempAccount({
      exitIp: "1.2.3.4",
      exitCountry: "JP",
      status: "ready",
      lastVerifiedAt: initialVerifiedAt,
    });

    __setAcpProbeDepsForTest({
      probeExit: async () => ({
        exitIp: "",
        exitCountry: "",
        probeOk: false,
        error: "timeout",
      }),
      createConnection: () => ({
        async initialize() {},
        async request<T>(method: string) {
          if (method === "session/new") return { sessionId: "sess-probe-fail" } as T;
          return {} as T;
        },
        close() {},
      }),
    });

    const updated = await accountManager.refreshAccount(acc.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("ready");
    expect(updated!.exitIp).toBe("1.2.3.4");
    expect(updated!.lastVerifiedAt).toBe(initialVerifiedAt);
    expect(updated!.statusReason).toContain("Exit IP probe failed");
  });

  it("detectExitIpDrift detects both IP and country changes and skips when previous IP is empty", () => {
    expect(detectExitIpDrift({ exitIp: "", exitCountry: "" }, { exitIp: "1.2.3.4", exitCountry: "JP" }).drifted).toBe(
      false,
    );
    expect(detectExitIpDrift({ exitIp: "1.2.3.4", exitCountry: "JP" }, { exitIp: "1.2.3.4", exitCountry: "JP" }).drifted).toBe(
      false,
    );
    const countryDrift = detectExitIpDrift(
      { exitIp: "1.2.3.4", exitCountry: "JP" },
      { exitIp: "1.2.3.4", exitCountry: "SG" },
    );
    expect(countryDrift.drifted).toBe(true);
    expect(countryDrift.reason).toBe("Exit IP drift detected: 1.2.3.4 (JP) -> 1.2.3.4 (SG)");
  });

  it("Blocker 3: preserves original exitIp baseline across consecutive drift refreshes so account cannot be washed back to ready", async () => {
    updateConfig({ defaultProxy: "", blockOnExitIpDrift: true });
    mockOAuthAndTierFetch();

    const acc = createTempAccount({ exitIp: "1.1.1.1", exitCountry: "JP", status: "ready" });
    let acpConnCalled = false;
    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "2.2.2.2", exitCountry: "US", probeOk: true }),
      createConnection: () => {
        acpConnCalled = true;
        return {
          async initialize() {},
          async request<T>() {
            return {} as T;
          },
          close() {},
        };
      },
    });

    const first = await accountManager.refreshAccount(acc.id);
    expect(first).not.toBeNull();
    expect(first!.status).toBe("restricted");
    expect(first!.exitIp).toBe("1.1.1.1");
    expect(first!.exitCountry).toBe("JP");
    expect(first!.statusReason).toBe("Exit IP drift detected: 1.1.1.1 (JP) -> 2.2.2.2 (US)");

    const second = await accountManager.refreshAccount(acc.id);
    expect(second).not.toBeNull();
    expect(second!.status).toBe("restricted");
    expect(second!.exitIp).toBe("1.1.1.1");
    expect(second!.exitCountry).toBe("JP");
    expect(second!.statusReason).toBe("Exit IP drift detected: 1.1.1.1 (JP) -> 2.2.2.2 (US)");
    expect(acpConnCalled).toBe(false);
  });
});

describe("wp5 Blocker integration fixes (Scheduler wiring & Proxy reuse/NO_PROXY)", () => {
  it("Blocker 1: writes prewarm and cold-start spawns into the injected production AccountScheduler instance without double-counting adoption", async () => {
    updateConfig({ defaultProxy: "", strictProxyBinding: false, maxWorkerSpawnsPerMinute: 3 });
    const dummyBin = createTempDummyBinary();
    const acc = createTempAccount({ proxyUrl: "" });
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let prodScheduler: AccountScheduler | null = null;
    const spawnAccountIds: string[] = [];
    let transportSpawnCount = 0;

    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: dummyBin,
      workspaceDir: acc.homeDir,
      prewarmPerAccount: 1,
      maxPrewarmTotal: 2,
      onWorkerSpawn: (accountId) => {
        spawnAccountIds.push(accountId);
        prodScheduler?.recordWorkerSpawn(accountId);
      },
      transportFactory: (opts) => {
        transportSpawnCount++;
        return createMockTransport(opts.onUpdate);
      },
    });
    prodScheduler = new AccountScheduler({
      getActiveCount: (id) => pool.getActiveCount(id),
    });

    try {
      expect(prodScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(false);

      // 1. 预热写入同一个 prodScheduler（计数 = 1）
      const prewarmed = await pool.prewarmAccount(acc);
      expect(prewarmed).toBe(true);
      expect(transportSpawnCount).toBe(1);
      expect(spawnAccountIds).toEqual([acc.id]);
      expect(prodScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(false);

      // 2. 接管预热不应重复计数（acquireWorker 会异步补 1 个预热，总 spawn 次数严格等于真实 transportFactory 调用次数）
      const req1 = { contents: [{ role: "user", parts: [{ text: "first" }] }] };
      const handle1 = pool.acquireWorker(acc, "gemini-3.8-flash-low", req1, "sess-b1-1");
      await handle1.worker.executePrompt(req1);
      handle1.release();
      // 等待异步补预热完成
      await new Promise((r) => setTimeout(r, 20));
      expect(spawnAccountIds.length).toBe(transportSpawnCount);
      expect(prodScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(false);

      // 3. 清空预热池后触发冷启动，达到 maxWorkerSpawnsPerMinute=3，prodScheduler 立即限流
      await pool.evictAccountWorkers(acc.id);
      const req2 = { contents: [{ role: "user", parts: [{ text: "second" }] }] };
      const handle2 = pool.acquireWorker(acc, "gemini-3.8-flash-low", req2, "sess-b1-2");
      await handle2.worker.executePrompt(req2);
      handle2.release();
      await new Promise((r) => setTimeout(r, 20));

      expect(spawnAccountIds.length).toBe(transportSpawnCount);
      expect(prodScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(true);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it("Blocker 2: evicts and closes old worker/prewarmed transport when account proxy changes, triggers Fail-Fast on unreachable new proxy, and converges NO_PROXY", async () => {
    updateConfig({ defaultProxy: "", strictProxyBinding: true });
    const proxyA = "http://127.0.0.1:17901";
    const proxyB = "http://127.0.0.1:17902";
    const reachableProxies = new Set<string>([proxyA]);

    __setTcpConnectProbeForTest(async (host, port) => {
      const target = `http://${host}:${port}`;
      return reachableProxies.has(target) ? { ok: true } : { ok: false, error: "ECONNREFUSED" };
    });

    const acc = createTempAccount({ proxyUrl: proxyA });
    const dummyBin = createTempDummyBinary();
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let closedCount = 0;
    let spawnCount = 0;
    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: dummyBin,
      workspaceDir: acc.homeDir,
      prewarmPerAccount: 0,
      transportFactory: (opts) => {
        spawnCount++;
        const base = createMockTransport(opts.onUpdate);
        return {
          ...base,
          async close() {
            closedCount++;
            await base.close();
          },
        };
      },
    });

    try {
      // 先用 proxyA 建立一个可复用的 worker
      const req1 = { contents: [{ role: "user", parts: [{ text: "turn 1" }] }] };
      const h1 = pool.acquireWorker(acc, "gemini-3.8-flash-low", req1, "sess-b2");
      await h1.worker.executePrompt(req1);
      h1.release();
      expect(spawnCount).toBe(1);
      expect(h1.worker.getBoundProxyUrl()).toBe(proxyA);

      // 账号改绑到不可达的 proxyB，同 stickyKey + 续聊内容应拒绝复用旧 worker、关闭旧传输并触发 Fail-Fast
      const updatedAcc: AccountRecord = { ...acc, proxyUrl: proxyB };
      const req2 = {
        contents: [
          ...req1.contents,
          { role: "model", parts: [{ text: "ok" }] },
          { role: "user", parts: [{ text: "turn 2" }] },
        ],
      };
      const h2 = pool.acquireWorker(updatedAcc, "gemini-3.8-flash-low", req2, "sess-b2");
      expect(h2.worker).not.toBe(h1.worker);

      await expect(h2.worker.executePrompt(req2)).rejects.toThrow(
        "Proxy unreachable (strictProxyBinding=true)",
      );
      h2.release();
      expect(closedCount).toBeGreaterThanOrEqual(1);
      expect(spawnCount).toBe(1);

      // 验证 NO_PROXY 收敛：即使宿主环境设置了宽泛的 NO_PROXY，有代理时也只保留 loopback
      const prevNoProxy = process.env.NO_PROXY;
      const prevLowerNoProxy = process.env.no_proxy;
      process.env.NO_PROXY = "*.googleapis.com,10.0.0.0/8";
      process.env.no_proxy = "*.googleapis.com";
      try {
        const env = buildIsolatedAgyEnv({ homeDir: acc.homeDir, proxyUrl: proxyA });
        expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
        expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
      } finally {
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        if (prevLowerNoProxy === undefined) delete process.env.no_proxy;
        else process.env.no_proxy = prevLowerNoProxy;
      }
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it("Atomic spawn cap 1: rejects cold-start worker spawn once maxWorkerSpawnsPerMinute is reached without invoking transportFactory", async () => {
    const maxSpawns = 2;
    updateConfig({ defaultProxy: "", strictProxyBinding: false, maxWorkerSpawnsPerMinute: maxSpawns });
    const dummyBin = createTempDummyBinary();
    const acc = createTempAccount({ proxyUrl: "" });
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let prodScheduler: AccountScheduler | null = null;
    let transportSpawnCount = 0;

    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: dummyBin,
      workspaceDir: acc.homeDir,
      prewarmPerAccount: 0,
      tryAcquireWorkerSpawn: (accountId) => prodScheduler!.tryConsumeWorkerSpawn(accountId),
      transportFactory: (opts) => {
        transportSpawnCount++;
        return createMockTransport(opts.onUpdate);
      },
    });
    prodScheduler = new AccountScheduler({
      getActiveCount: (id) => pool.getActiveCount(id),
    });

    try {
      const req1 = { contents: [{ role: "user", parts: [{ text: "c1" }] }] };
      const h1 = pool.acquireWorker(acc, "gemini-3.8-flash-low", req1, "sess-cap-1");
      await h1.worker.executePrompt(req1);
      h1.release();

      const req2 = { contents: [{ role: "user", parts: [{ text: "c2" }] }] };
      const h2 = pool.acquireWorker(acc, "gemini-3.8-flash-low", req2, "sess-cap-2");
      await h2.worker.executePrompt(req2);
      h2.release();

      expect(transportSpawnCount).toBe(maxSpawns);
      expect(prodScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(true);

      // 第 3 次冷启动必须被原子判限拦截，直接抛出 503 WorkerError，绝不调用 transportFactory
      const req3 = { contents: [{ role: "user", parts: [{ text: "c3" }] }] };
      const h3 = pool.acquireWorker(acc, "gemini-3.8-flash-low", req3, "sess-cap-3");
      let caught: unknown;
      try {
        await h3.worker.executePrompt(req3);
      } catch (err) {
        caught = err;
      } finally {
        h3.release();
      }

      expect(caught).toBeInstanceOf(WorkerError);
      expect((caught as WorkerError).code).toBe("SOFT_ERROR");
      expect((caught as WorkerError).upstreamStatus).toBe(503);
      expect(transportSpawnCount).toBeLessThanOrEqual(maxSpawns);
      expect(transportSpawnCount).toBe(maxSpawns);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it("Atomic spawn cap 2: skips auto-prewarm silently once maxWorkerSpawnsPerMinute is reached without invoking transportFactory", async () => {
    const maxSpawns = 1;
    updateConfig({ defaultProxy: "", strictProxyBinding: false, maxWorkerSpawnsPerMinute: maxSpawns });
    const dummyBin = createTempDummyBinary();
    const acc = createTempAccount({ proxyUrl: "" });
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let prodScheduler: AccountScheduler | null = null;
    let transportSpawnCount = 0;

    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: dummyBin,
      workspaceDir: acc.homeDir,
      prewarmPerAccount: 1,
      maxPrewarmTotal: 2,
      tryAcquireWorkerSpawn: (accountId) => prodScheduler!.tryConsumeWorkerSpawn(accountId),
      transportFactory: (opts) => {
        transportSpawnCount++;
        return createMockTransport(opts.onUpdate);
      },
    });
    prodScheduler = new AccountScheduler({
      getActiveCount: (id) => pool.getActiveCount(id),
    });

    try {
      // 第 1 次预热占用唯一额度
      const firstPrewarm = await pool.prewarmAccount(acc);
      expect(firstPrewarm).toBe(true);
      expect(transportSpawnCount).toBe(1);

      // 接管预热后 acquireWorker 会异步触发自动补预热，因已达上限=1，必须静默跳过且不调用 transportFactory
      const req = { contents: [{ role: "user", parts: [{ text: "adopt-then-prewarm" }] }] };
      const handle = pool.acquireWorker(acc, "gemini-3.8-flash-low", req, "sess-prewarm-cap");
      await handle.worker.executePrompt(req);
      handle.release();
      await new Promise((r) => setTimeout(r, 30));

      // 再次显式调用 prewarmAccount 也必须返回 false 且不触发 transportFactory
      const secondPrewarm = await pool.prewarmAccount(acc);
      expect(secondPrewarm).toBe(false);
      expect(transportSpawnCount).toBeLessThanOrEqual(maxSpawns);
      expect(transportSpawnCount).toBe(maxSpawns);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });

  it("Atomic spawn cap 3: acquireFallbackAccountLease rejects rate-limited account so it is never selected or spawned", async () => {
    const maxSpawns = 1;
    updateConfig({ defaultProxy: "", strictProxyBinding: false, maxWorkerSpawnsPerMinute: maxSpawns });
    const dummyBin = createTempDummyBinary();
    const acc = createTempAccount({ proxyUrl: "" });
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let prodScheduler: AccountScheduler | null = null;
    let transportSpawnCount = 0;

    const pool = new AcpWorkerPool({
      mcpServer,
      agyPath: dummyBin,
      workspaceDir: acc.homeDir,
      prewarmPerAccount: 0,
      tryAcquireWorkerSpawn: (accountId) => prodScheduler!.tryConsumeWorkerSpawn(accountId),
      transportFactory: (opts) => {
        transportSpawnCount++;
        return createMockTransport(opts.onUpdate);
      },
    });
    prodScheduler = new AccountScheduler({
      getActiveCount: (id) => pool.getActiveCount(id),
    });

    try {
      // 消耗掉唯一 1 次拉起额度
      const req = { contents: [{ role: "user", parts: [{ text: "initial" }] }] };
      const handle = pool.acquireWorker(acc, "gemini-3.8-flash-low", req, "sess-fb-cap");
      await handle.worker.executePrompt(req);
      handle.release();
      expect(transportSpawnCount).toBe(1);
      expect(prodScheduler.isWorkerSpawnRateLimited(acc.id)).toBe(true);

      // 显式 fallback 选号必须跳过/拒绝该已达限额的账号，不发放租约也不触发后续拉起
      let caught: unknown;
      try {
        await prodScheduler.acquireFallbackAccountLease(acc.id, "gemini-3.8-flash-low", "sess-fb-cap");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AllAccountsCooldownError);
      expect(transportSpawnCount).toBeLessThanOrEqual(maxSpawns);
      expect(transportSpawnCount).toBe(1);
    } finally {
      await pool.shutdownAll();
      await mcpServer.stop();
    }
  });
});
