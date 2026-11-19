import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setTierDetectFetcher, accountManager } from "../src/accounts/manager";
import { store } from "../src/db/store";
import { eventBus } from "../src/logs/events";
import type { AccountRecord, AccountStatus } from "../src/types";

const tempDirs: string[] = [];
const createdAccountIds: string[] = [];
const originalFetch = globalThis.fetch;

function createTempAccount(opts: {
  status?: AccountStatus;
  withOAuthToken?: boolean;
}): AccountRecord {
  const status = opts.status ?? "ready";
  const withOAuthToken = opts.withOAuthToken ?? true;
  const id = `test-tier-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tier-sync-test-"));

  if (withOAuthToken) {
    const oauthDir = path.join(homeDir, ".gemini", "antigravity-cli");
    fs.mkdirSync(oauthDir, { recursive: true });
    fs.writeFileSync(
      path.join(oauthDir, "antigravity-oauth-token"),
      JSON.stringify({ refresh_token: "test-refresh-token" }),
      "utf8"
    );
  }

  const now = Date.now() - 10_000;
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setTierDetectFetcher(originalFetch);

  while (createdAccountIds.length > 0) {
    const id = createdAccountIds.pop()!;
    store.deleteAccount(id);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function subscribeAccountsEvents(): { count: () => number; dispose: () => void } {
  const chunks: string[] = [];
  const controller = {
    enqueue(chunk: Uint8Array) {
      chunks.push(new TextDecoder().decode(chunk));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  eventBus.subscribe(controller);
  // 清空初始 snapshot，仅统计后续广播
  chunks.length = 0;
  return {
    count: () => chunks.filter((c) => c.startsWith("event: accounts\n")).length,
    dispose: () => eventBus.unsubscribe(controller),
  };
}

describe("AccountManager.detectAllAccountTiers auth_required sync", () => {
  it("marks missing OAuth token accounts as auth_required and emits accounts event", async () => {
    const acc = createTempAccount({ status: "ready", withOAuthToken: false });
    const sub = subscribeAccountsEvents();

    try {
      const res = await accountManager.detectAllAccountTiers();
      expect(res.total).toBeGreaterThanOrEqual(1);
      expect(res.updated).toBe(0);
      expect(res.failed).toBe(1);

      const detail = res.details.find((d) => d.id === acc.id);
      expect(detail).toEqual({
        id: acc.id,
        label: acc.label,
        email: acc.email,
        ok: false,
        tier: "standard",
        reason: "missing OAuth token",
      });

      const saved = store.getAccount(acc.id);
      expect(saved).not.toBeNull();
      expect(saved!.status).toBe("auth_required");
      expect(saved!.statusReason).toContain("Missing OAuth token");
      expect(saved!.updatedAt).toBeGreaterThan(acc.updatedAt);
      expect(sub.count()).toBe(1);
    } finally {
      sub.dispose();
    }
  });

  it("marks OAuth invalid_grant accounts as auth_required and emits accounts event", async () => {
    const acc = createTempAccount({ status: "ready", withOAuthToken: true });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    const sub = subscribeAccountsEvents();

    try {
      const res = await accountManager.detectAllAccountTiers();
      expect(res.updated).toBe(0);
      expect(res.failed).toBe(1);

      const detail = res.details.find((d) => d.id === acc.id);
      expect(detail?.ok).toBe(false);
      expect(detail?.reason).toContain("OAuth refresh failed (invalid_grant");

      const saved = store.getAccount(acc.id);
      expect(saved).not.toBeNull();
      expect(saved!.status).toBe("auth_required");
      expect(saved!.statusReason).toContain("invalid_grant");
      expect(saved!.updatedAt).toBeGreaterThan(acc.updatedAt);
      expect(sub.count()).toBe(1);
    } finally {
      sub.dispose();
    }
  });

  it("does not misclassify 5xx, tier detect unavailable, or network error as auth_required", async () => {
    const acc503 = createTempAccount({ status: "ready", withOAuthToken: true });
    const accTierNull = createTempAccount({ status: "ready", withOAuthToken: true });
    const accNetErr = createTempAccount({ status: "ready", withOAuthToken: true });

    let fetchCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bodyStr = init?.body ? String(init.body) : "";
      expect(bodyStr).toContain("refresh_token=test-refresh-token");
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (fetchCount === 2) {
        return new Response(JSON.stringify({ access_token: "ok-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("ECONNRESET network glitch");
    }) as unknown as typeof fetch;

    __setTierDetectFetcher((async () =>
      new Response(JSON.stringify({}), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch);

    const sub = subscribeAccountsEvents();

    try {
      const res = await accountManager.detectAllAccountTiers({ concurrency: 1 });
      expect(res.updated).toBe(0);
      expect(res.failed).toBe(3);
      expect(sub.count()).toBe(0);

      expect(store.getAccount(acc503.id)!.status).toBe("ready");
      expect(store.getAccount(accTierNull.id)!.status).toBe("ready");
      expect(store.getAccount(accNetErr.id)!.status).toBe("ready");

      expect(res.details.find((d) => d.id === acc503.id)?.reason).toBe(
        "OAuth refresh failed (temporarily_unavailable)"
      );
      expect(res.details.find((d) => d.id === accTierNull.id)?.reason).toBe(
        "tier detect unavailable"
      );
      expect(res.details.find((d) => d.id === accNetErr.id)?.reason).toBe(
        "ECONNRESET network glitch"
      );
    } finally {
      sub.dispose();
    }
  });
});
