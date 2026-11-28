import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACP_PROBE_TIMEOUT_MS,
  AccountManager,
  __setAcpProbeDepsForTest,
  __setTierDetectFetcher,
  accountManager,
  classifyAcpProbeError,
} from "../src/accounts/manager";
import { createUsageReader, type UsageExecOutput } from "../src/accounts/quota";
import { AccountScheduler } from "../src/accounts/scheduler";
import { invalidateConfigCache, updateConfig } from "../src/config/settings";
import { store } from "../src/db/store";
import { eventBus } from "../src/logs/events";
import { createApp } from "../src/server";
import type { AccountRecord, AccountStatus } from "../src/types";

const tempDirs: string[] = [];
const createdAccountIds: string[] = [];
const originalFetch = globalThis.fetch;

function createTempAccount(status: AccountStatus = "ready", accessToken?: string): AccountRecord {
  const id = `test-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-test-"));
  const oauthDir = path.join(homeDir, ".gemini", "antigravity-cli");
  fs.mkdirSync(oauthDir, { recursive: true });
  fs.writeFileSync(
    path.join(oauthDir, "antigravity-oauth-token"),
    JSON.stringify({
      refresh_token: "test-refresh-token",
      ...(accessToken ? { access_token: accessToken, expiry: new Date(Date.now() + 600_000).toISOString() } : {}),
    }),
    "utf8"
  );

  const now = Date.now();
  const acc: AccountRecord = {
    id,
    label: `Test-${id}`,
    email: `${id}@example.com`,
    source: "test",
    homeDir,
    proxyUrl: "",
    status,
    tier: "standard",
    statusReason: "",
    exitIp: "1.2.3.4",
    exitCountry: "JP",
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  store.upsertAccount(acc);
  tempDirs.push(homeDir);
  createdAccountIds.push(id);
  return acc;
}

function mockAcpProbe(onPrompt: () => void = () => {}): void {
  __setAcpProbeDepsForTest({
    probeExit: async () => ({ exitIp: "1.2.3.4", exitCountry: "JP" }),
    createConnection: () => ({
      async initialize() {},
      async request<T = unknown>(method: string): Promise<T> {
        if (method === "session/new") return { sessionId: "test-probe" } as T;
        if (method === "session/prompt") onPrompt();
        return {} as T;
      },
      close() {},
    }),
  });
}

function mockOAuthAndTierFetch(): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "test-access-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as unknown as typeof fetch;

  __setTierDetectFetcher((async () =>
    new Response(JSON.stringify({ paidTier: { id: "g1-pro-tier" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setTierDetectFetcher(originalFetch);
  __setAcpProbeDepsForTest({});

  while (createdAccountIds.length > 0) {
    const id = createdAccountIds.pop()!;
    store.deleteCooldown(id, "*", "global");
    store.deleteAccount(id);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("classifyAcpProbeError", () => {
  it("classifies auth errors as auth_required", () => {
    expect(classifyAcpProbeError(new Error("HTTP 401 UNAUTHENTICATED"), "ready")).toEqual({
      status: "auth_required",
      reason: "HTTP 401 UNAUTHENTICATED",
    });
    expect(classifyAcpProbeError(new Error("invalid_grant: token expired"), "restricted")).toEqual({
      status: "auth_required",
      reason: "invalid_grant: token expired",
    });
  });

  it("classifies explicit risk/ban errors as restricted", () => {
    for (const msg of [
      "HTTP 403 Forbidden",
      "VALIDATION_REQUIRED: Verify your account",
      "Account restricted due to violation of terms",
      "Account suspended",
    ]) {
      expect(classifyAcpProbeError(new Error(msg), "ready")).toEqual({
        status: "restricted",
        reason: msg,
      });
    }
  });

  it("never misclassifies timeout or transient network errors as restricted", () => {
    for (const msg of [
      "agy.exe probe timeout (50s)",
      "ETIMEDOUT connecting to upstream",
      "ECONNRESET socket hang up",
      "HTTP 503 Service Unavailable",
    ]) {
      expect(classifyAcpProbeError(new Error(msg), "ready")).toEqual({
        status: "ready",
        reason: msg,
      });
      expect(classifyAcpProbeError(new Error(msg), "restricted")).toEqual({
        status: "restricted",
        reason: msg,
      });
      expect(classifyAcpProbeError(new Error(msg), "auth_required")).toEqual({
        status: "auth_required",
        reason: msg,
      });
    }
  });

  it("prioritizes restricted over auth_required when message contains token and 403/violation of terms", () => {
    const msg =
      "OAuth token exchange succeeded but HTTP 403 Forbidden: violation of terms of service";
    expect(classifyAcpProbeError(new Error(msg), "ready")).toEqual({
      status: "restricted",
      reason: msg,
    });
  });

  it("preserves long error messages over 200 chars including Google validation/appeal URLs", () => {
    const padding = "x".repeat(220);
    const url = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbtLongToken";
    const msg = `VALIDATION_REQUIRED: ${padding} Please verify at ${url}`;
    const result = classifyAcpProbeError(new Error(msg), "ready");
    expect(result.status).toBe("restricted");
    expect(result.reason.length).toBe(msg.length);
    expect(result.reason).toContain(url);
  });
});

describe("AccountManager.updateAccount statusReason handling", () => {
  it("clears statusReason when re-enabling to ready without explicit statusReason", () => {
    const acc = createTempAccount("restricted");
    accountManager.setAccountStatus(acc.id, "restricted", "HTTP 403 Forbidden: violation of terms");

    const updated = accountManager.updateAccount(acc.id, { status: "ready" });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("ready");
    expect(updated!.statusReason).toBe("");
  });

  it("preserves statusReason when disabling without explicit statusReason", () => {
    const acc = createTempAccount("restricted");
    const reason = "VALIDATION_REQUIRED: https://accounts.google.com/verify";
    accountManager.setAccountStatus(acc.id, "restricted", reason);

    const updated = accountManager.updateAccount(acc.id, { status: "disabled" });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("disabled");
    expect(updated!.statusReason).toBe(reason);
  });
});

describe("AccountManager OAuth renewal", () => {
  it("shares a single token exchange across quota, account refresh, and tier detection", async () => {
    const acc = createTempAccount();
    const exchangeStarted = Promise.withResolvers<void>();
    const finishExchange = Promise.withResolvers<void>();
    const refreshTokens: string[] = [];
    mockOAuthAndTierFetch();
    mockAcpProbe();
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      refreshTokens.push(new URLSearchParams(String(init.body)).get("refresh_token")!);
      exchangeStarted.resolve();
      await finishExchange.promise;
      return Response.json({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const listAccounts = spyOn(store, "listAccounts").mockImplementation(() => [store.getAccount(acc.id)!]);
    const quotaManager = new AccountManager();
    quotaManager.setUsageReaderForTest(createUsageReader({
      resolveBinary: () => "agy.exe",
      checkProxy: async () => ({ ok: true }),
      executor: async () => ({ exitCode: 7, stdout: "", stderr: "usage child ran" }),
    }));
    const quota = quotaManager.refreshAccountQuota(acc.id);
    try {
      await exchangeStarted.promise;
      const refresh = accountManager.refreshAccount(acc.id);
      const tiers = new AccountManager().detectAllAccountTiers();
      finishExchange.resolve();
      const [quotaResult, refreshResult, tierResult] = await Promise.all([quota, refresh, tiers]);
      expect(refreshTokens).toEqual(["test-refresh-token"]);
      expect(quotaResult?.quota?.error).toContain("usage child ran");
      expect(refreshResult?.status).toBe("ready");
      expect(tierResult.updated).toBe(1);
      const tokenFile = path.join(acc.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      expect(JSON.parse(fs.readFileSync(tokenFile, "utf8")).token.refresh_token).toBe("rotated-refresh");
    } finally {
      finishExchange.resolve();
      listAccounts.mockRestore();
    }
  });

  it("publishes the newly required authentication status to an accounts stream", async () => {
    const missing = createTempAccount();
    fs.unlinkSync(path.join(missing.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
    const revoked = createTempAccount();
    globalThis.fetch = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    const listAccounts = spyOn(store, "listAccounts").mockImplementation(() =>
      [store.getAccount(missing.id)!, store.getAccount(revoked.id)!]);
    let subscription!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        subscription = controller;
        eventBus.subscribe(controller);
      },
    });
    try {
      await accountManager.detectAllAccountTiers();
      eventBus.unsubscribe(subscription);
      subscription.close();
      const updates = (await new Response(stream).text()).split("\n\n")
        .filter((event) => event.startsWith("event: accounts\n"));
      expect(updates).toHaveLength(2);
      const updated = JSON.parse(updates[1].split("\ndata: ")[1]).data as AccountRecord[];
      expect(updated.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: missing.id, status: "auth_required" },
        { id: revoked.id, status: "auth_required" },
      ]);
    } finally {
      eventBus.unsubscribe(subscription);
      listAccounts.mockRestore();
    }
  });

  it.each([
    ["timeout", new DOMException("upstream timed out", "TimeoutError")],
    ["network", new TypeError("ECONNRESET")],
    ["HTTP 429", 429],
    ["HTTP 500", 500],
    ["HTTP 503", 503],
  ] as const)("returns a transient result and preserves the stored account on %s", async (_label, failure) => {
    globalThis.fetch = (async () => {
      if (typeof failure !== "number") throw failure;
      return Response.json({ error: "temporarily_unavailable" }, { status: failure });
    }) as unknown as typeof fetch;
    mockAcpProbe(() => { throw new Error("ACP probe must not run after failed renewal"); });

    for (const status of ["ready", "restricted", "auth_required"] as const) {
      const acc = createTempAccount(status);
      const before = store.getAccount(acc.id);
      const updated = await accountManager.refreshAccount(acc.id);
      expect(updated?.status).toBe(status);
      expect(updated?.statusReason).toStartWith("OAUTH_REFRESH_TRANSIENT:");
      expect(store.getAccount(acc.id)).toEqual(before);
    }
  });

  it.each([400, 401, 403])("marks the account auth_required on permanent OAuth HTTP %i", async (status) => {
    const acc = createTempAccount();
    globalThis.fetch = (async () => Response.json(
      { error: status === 400 ? "invalid_grant" : "access_denied" }, { status },
    )) as unknown as typeof fetch;
    mockAcpProbe();

    const updated = await accountManager.refreshAccount(acc.id);

    expect(updated?.status).toBe("auth_required");
    expect(updated?.statusReason).toContain("OAuth refresh failed");
    expect(store.getAccount(acc.id)?.status).toBe("auth_required");
  });
});

describe("AccountManager quota slots", () => {
  it("holds four slots after foreground timeout until a background check ends", async () => {
    const accounts = Array.from({ length: 5 }, () => createTempAccount("ready", "valid-access"));
    const start = accounts.map(() => Promise.withResolvers<void>());
    const finish = accounts.map(() => Promise.withResolvers<UsageExecOutput>());
    const output = { exitCode: 1, stdout: "", stderr: "usage child finished" };
    let started = 0;
    let active = 0;
    let peak = 0;
    const reader = createUsageReader({
      foregroundWaitMs: 15,
      resolveBinary: () => "agy.exe",
      checkProxy: async () => ({ ok: true }),
      executor: async () => {
        const index = started++;
        active++;
        peak = Math.max(peak, active);
        start[index].resolve();
        try {
          return await finish[index].promise;
        } finally {
          active--;
        }
      },
    });
    const firstManager = new AccountManager();
    const secondManager = new AccountManager();
    firstManager.setUsageReaderForTest(reader);
    secondManager.setUsageReaderForTest(reader);
    const jobs = accounts.map((acc, index) =>
      (index === 4 ? secondManager : firstManager).refreshAccountQuota(acc.id));
    try {
      const foreground = await Promise.all(jobs.slice(0, 4));
      for (const result of foreground) expect(result?.quota?.error).toStartWith("STILL_READING:");
      expect(started).toBe(4);
      expect(active).toBe(4);
      expect(firstManager.refreshAccountQuota(accounts[0].id)).toBe(jobs[0]);

      finish[0].resolve({ ...output, timedOut: true });
      await start[4].promise;
      expect(peak).toBe(4);
      finish[4].resolve(output);
      expect((await jobs[4])?.quota?.error).toContain("usage child finished");
    } finally {
      finish.forEach(({ resolve }) => resolve(output));
      await Promise.allSettled(jobs);
    }
  });
});

describe("AccountManager.refreshAccount ACP probe", () => {
  it("uses 50s default probe timeout constant", () => {
    expect(ACP_PROBE_TIMEOUT_MS).toBe(50_000);
  });

  it("calls session/set_model after session/new and before session/prompt", async () => {
    const acc = createTempAccount("ready");
    mockOAuthAndTierFetch();

    const callLog: Array<{ method: string; params?: unknown }> = [];
    let closed = false;

    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "9.9.9.9", exitCountry: "JP" }),
      createConnection: () => ({
        async initialize() {
          callLog.push({ method: "initialize" });
        },
        async request<T = unknown>(method: string, params?: unknown): Promise<T> {
          callLog.push({ method, params });
          if (method === "session/new") {
            return { sessionId: "sess-probe-1" } as T;
          }
          return {} as T;
        },
        close() {
          closed = true;
        },
      }),
    });

    const updated = await accountManager.refreshAccount(acc.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("ready");
    expect(updated!.statusReason).toBe("");
    expect(closed).toBe(true);

    expect(callLog.map((c) => c.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    expect(callLog[2]).toEqual({
      method: "session/set_model",
      params: {
        sessionId: "sess-probe-1",
        modelId: "gemini-3.8-flash-low",
      },
    });
  });

  it("continues to session/prompt and marks ready even if session/set_model rejects", async () => {
    const acc = createTempAccount("ready");
    mockOAuthAndTierFetch();

    const callLog: string[] = [];
    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "9.9.9.9", exitCountry: "JP" }),
      createConnection: () => ({
        async initialize() {
          callLog.push("initialize");
        },
        async request<T = unknown>(method: string): Promise<T> {
          callLog.push(method);
          if (method === "session/new") return { sessionId: "sess-probe-2" } as T;
          if (method === "session/set_model") throw new Error("Method not found");
          return {} as T;
        },
        close() {},
      }),
    });

    const updated = await accountManager.refreshAccount(acc.id);
    expect(updated!.status).toBe("ready");
    expect(callLog).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
  });

  it("keeps ready/restricted/auth_required status on 50s probe timeout instead of marking restricted", async () => {
    mockOAuthAndTierFetch();

    const hangProbe = {
      probeExit: async () => ({ exitIp: "9.9.9.9", exitCountry: "JP" }),
      timeoutMs: 25,
      createConnection: () => ({
        async initialize() {},
        async request<T = unknown>(method: string): Promise<T> {
          if (method === "session/new") return { sessionId: "sess-hang" } as T;
          if (method === "session/set_model") return {} as T;
          return new Promise<T>(() => {});
        },
        close() {},
      }),
    };

    for (const initialStatus of ["ready", "restricted", "auth_required"] as const) {
      const acc = createTempAccount(initialStatus);
      __setAcpProbeDepsForTest(hangProbe);

      const updated = await accountManager.refreshAccount(acc.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(initialStatus);
      expect(updated!.statusReason).toBe("agy.exe probe timeout (50s)");
    }
  });

  it("marks ready account as restricted on 403 or VALIDATION_REQUIRED", async () => {
    mockOAuthAndTierFetch();

    for (const errText of [
      "HTTP 403 Forbidden: account blocked",
      "VALIDATION_REQUIRED: please verify your account",
    ]) {
      const acc = createTempAccount("ready");
      __setAcpProbeDepsForTest({
        probeExit: async () => ({ exitIp: "9.9.9.9", exitCountry: "JP" }),
        createConnection: () => ({
          async initialize() {},
          async request<T = unknown>(method: string): Promise<T> {
            if (method === "session/new") return { sessionId: "sess-403" } as T;
            if (method === "session/set_model") return {} as T;
            throw new Error(errText);
          },
          close() {},
        }),
      });

      const updated = await accountManager.refreshAccount(acc.id);
      expect(updated!.status).toBe("restricted");
      expect(updated!.statusReason).toBe(errText);
    }
  });

  it("marks ready account as restricted when onUpdate emits ToS warning chunk even if session/prompt resolves", async () => {
    const acc = createTempAccount("ready");
    mockOAuthAndTierFetch();

    const tosWarning =
      "⚠ This service has been disabled in this account for violation of terms of service.";
    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "9.9.9.9", exitCountry: "JP" }),
      createConnection: (opts) => ({
        async initialize() {},
        async request<T = unknown>(method: string): Promise<T> {
          if (method === "session/new") return { sessionId: "sess-tos" } as T;
          if (method === "session/set_model") return {} as T;
          if (method === "session/prompt") {
            opts.onUpdate?.({
              sessionId: "sess-tos",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: tosWarning },
              },
            });
            return { stopReason: "end_turn" } as T;
          }
          return {} as T;
        },
        close() {},
      }),
    });

    const updated = await accountManager.refreshAccount(acc.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("restricted");
    expect(updated!.statusReason).toBe(tosWarning);
  });

  it.each([false, true])("preserves a global cooldown written during a successful probe (preexisting: %s)", async (preexisting) => {
    const acc = createTempAccount("restricted");
    mockOAuthAndTierFetch();
    const cooldown = {
      accountId: acc.id,
      family: "*",
      scopeType: "global" as const,
      reason: "RESTRICTED",
      untilMs: Date.now() + 6 * 60 * 60 * 1000,
      consecutiveFailures: 1,
      lastError: "HTTP 403 Forbidden",
    };
    if (preexisting) store.upsertCooldown(cooldown);
    mockAcpProbe(() => store.upsertCooldown(cooldown));

    const updated = await accountManager.refreshAccount(acc.id);

    expect(updated?.status).toBe("ready");
    expect(store.listCooldowns().find((entry) => entry.accountId === acc.id)).toEqual(cooldown);
  });

  it("preserves the old global cooldown when an ACP failure leaves the status ready", async () => {
    const acc = createTempAccount();
    mockOAuthAndTierFetch();
    store.upsertCooldown({
      accountId: acc.id,
      family: "*",
      scopeType: "global",
      reason: "RESTRICTED",
      untilMs: Date.now() + 60_000,
      consecutiveFailures: 1,
      lastError: "HTTP 403 Forbidden",
    });
    mockAcpProbe(() => { throw new Error("ECONNRESET socket hang up"); });

    const updated = await accountManager.refreshAccount(acc.id);

    expect(updated?.status).toBe("ready");
    expect(updated?.statusReason).toContain("ECONNRESET");
    expect(store.listCooldowns().some((entry) => entry.accountId === acc.id)).toBe(true);
  });

  it("clears 6h *:global cooldown and allows immediate acquireAccountLease when refreshAccount recovers to ready", async () => {
    const acc = createTempAccount("restricted");
    mockOAuthAndTierFetch();

    store.upsertCooldown({
      accountId: acc.id,
      family: "*",
      scopeType: "global",
      reason: "HTTP 403 Forbidden",
      untilMs: Date.now() + 6 * 60 * 60 * 1000,
      consecutiveFailures: 1,
      lastError: "HTTP 403 Forbidden",
    });

    expect(
      store.listCooldowns(Date.now()).some((c) => c.accountId === acc.id && c.family === "*" && c.scopeType === "global")
    ).toBe(true);

    __setAcpProbeDepsForTest({
      probeExit: async () => ({ exitIp: "9.9.9.9", exitCountry: "JP" }),
      createConnection: () => ({
        async initialize() {},
        async request<T = unknown>(method: string): Promise<T> {
          if (method === "session/new") return { sessionId: "sess-recover" } as T;
          if (method === "session/set_model") return {} as T;
          return { stopReason: "end_turn" } as T;
        },
        close() {},
      }),
    });

    const listAccountsSpy = spyOn(store, "listAccounts").mockImplementation(() => {
      const current = store.getAccount(acc.id);
      return current ? [current] : [];
    });

    try {
      const updated = await accountManager.refreshAccount(acc.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("ready");
      expect(
        store.listCooldowns(Date.now()).some((c) => c.accountId === acc.id && c.family === "*" && c.scopeType === "global")
      ).toBe(false);

      const scheduler = new AccountScheduler();
      const lease = await scheduler.acquireAccountLease("gemini-4-hydrogen");
      expect(lease.account.id).toBe(acc.id);
      lease.release();
    } finally {
      listAccountsSpy.mockRestore();
    }
  });

  it("clears 6h *:global cooldown and allows immediate acquireAccountLease when PUT /api/accounts/:id sets status to ready", async () => {
    const acc = createTempAccount("restricted");
    store.upsertCooldown({
      accountId: acc.id,
      family: "*",
      scopeType: "global",
      reason: "HTTP 403 Forbidden",
      untilMs: Date.now() + 6 * 60 * 60 * 1000,
      consecutiveFailures: 1,
      lastError: "HTTP 403 Forbidden",
    });

    expect(
      store.listCooldowns(Date.now()).some((c) => c.accountId === acc.id && c.family === "*" && c.scopeType === "global")
    ).toBe(true);

    const previousConfig = store.getConfigValue("gateway_config");
    const listAccountsSpy = spyOn(store, "listAccounts").mockImplementation(() => {
      const current = store.getAccount(acc.id);
      return current ? [current] : [];
    });

    try {
      updateConfig({ apiKey: "" });
      const scheduler = new AccountScheduler();
      const app = createApp({ geminiDeps: { scheduler } });
      const res = await app.fetch(
        new Request(`http://localhost/api/accounts/${encodeURIComponent(acc.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ready" }),
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as AccountRecord;
      expect(body.status).toBe("ready");

      expect(
        store.listCooldowns(Date.now()).some((c) => c.accountId === acc.id && c.family === "*" && c.scopeType === "global")
      ).toBe(false);

      const lease = await scheduler.acquireAccountLease("gemini-4-hydrogen");
      expect(lease.account.id).toBe(acc.id);
      lease.release();
    } finally {
      listAccountsSpy.mockRestore();
      store.setConfigValue("gateway_config", previousConfig);
      invalidateConfigCache();
    }
  });
});
