import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACP_PROBE_TIMEOUT_MS,
  __setAcpProbeDepsForTest,
  __setTierDetectFetcher,
  accountManager,
  classifyAcpProbeError,
} from "../src/accounts/manager";
import { AccountScheduler } from "../src/accounts/scheduler";
import { invalidateConfigCache, updateConfig } from "../src/config/settings";
import { store } from "../src/db/store";
import { createApp } from "../src/server";
import type { AccountRecord, AccountStatus } from "../src/types";

const tempDirs: string[] = [];
const createdAccountIds: string[] = [];
const originalFetch = globalThis.fetch;

function createTempAccount(status: AccountStatus = "ready"): AccountRecord {
  const id = `test-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-test-"));
  const oauthDir = path.join(homeDir, ".gemini", "antigravity-cli");
  fs.mkdirSync(oauthDir, { recursive: true });
  fs.writeFileSync(
    path.join(oauthDir, "antigravity-oauth-token"),
    JSON.stringify({ refresh_token: "test-refresh-token" }),
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
