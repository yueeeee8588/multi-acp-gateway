import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/gateway/state.mjs";
import { Accounts, parseRefreshTokens } from "../src/gateway/accounts.mjs";
import {
  detectChromePath,
  getChromeLocalStatePath,
  parseChromeLocalState,
  runChromeOAuthBatch,
} from "../src/gateway/chrome-oauth.mjs";
import { startLoopbackLogin } from "../native-wire/oauth-loopback.mjs";
import { createGateway } from "../src/gateway/app.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gemini-8049-import-"));
}

async function setupAdminGateway({
  login,
  refresh,
  identify,
  termsAccept,
  chromeOAuthOpts,
} = {}) {
  const dir = makeTempDir();
  const store = new StateStore({
    directory: dir,
    defaultProfile: {
      context: 2,
      enableFst: true,
      clientId: "123456-abcdef.apps.googleusercontent.com",
      clientSecret: "secret",
      scopes: ["openid", "email"],
    },
  });
  store.lock();
  const accounts = new Accounts(store, {
    login,
    refresh,
    identify,
    termsAccept,
    callbackPort: 0,
  });
  const provider = {
    sessions: new Map(),
    async runTurn() {
      throw new Error("unexpected");
    },
  };
  const app = createGateway({
    store,
    accounts,
    provider,
    openTurn: () => {
      throw new Error("unexpected");
    },
    chromeOAuthOpts,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const sessionRes = await fetch(`${origin}/admin/api/session`);
  assert.equal(sessionRes.status, 200);
  const cookie = sessionRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const { csrf } = await sessionRes.json();

  const adminGet = (p) =>
    fetch(`${origin}${p}`, {
      headers: { Cookie: cookie },
    });
  const adminPost = (p, body) =>
    fetch(`${origin}${p}`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  return { dir, store, accounts, app, origin, adminGet, adminPost };
}

test("parseRefreshTokens supports all JSON and plain-text formats with deduplication", () => {
  const t1 = "1//0g_token_one_1234567890";
  const t2 = "1//0g_token_two_1234567890";
  const t3 = "1//0g_token_three_123456789";

  assert.deepEqual(parseRefreshTokens(JSON.stringify([t1, t2, t1])), [
    { token: t1 },
    { token: t2 },
  ]);

  assert.deepEqual(
    parseRefreshTokens(
      JSON.stringify([
        { refreshToken: t1, label: "main" },
        { refresh_token: t2, label: "backup" },
      ]),
    ),
    [
      { token: t1, label: "main" },
      { token: t2, label: "backup" },
    ],
  );

  assert.deepEqual(
    parseRefreshTokens(
      JSON.stringify({ accounts: [{ refresh_token: t1, label: "a1" }] }),
    ),
    [{ token: t1, label: "a1" }],
  );

  assert.deepEqual(
    parseRefreshTokens(JSON.stringify({ tokens: [t1, t2] })),
    [{ token: t1 }, { token: t2 }],
  );

  assert.deepEqual(
    parseRefreshTokens(JSON.stringify({ refreshToken: t3, label: "single" })),
    [{ token: t3, label: "single" }],
  );

  const plain = `
    ${t1}|Work Account
    ${t2}, ${t3}
    1//short
    not_a_token
    ${t1}|Duplicate
  `;
  assert.deepEqual(parseRefreshTokens(plain), [
    { token: t1, label: "Work Account" },
    { token: t2 },
    { token: t3 },
  ]);
});

test("startLoopbackLogin appends login_hint when loginHint is provided", async () => {
  const login = await startLoopbackLogin({
    clientId: "123456-abcdef.apps.googleusercontent.com",
    clientSecret: "secret",
    scopes: ["https://www.googleapis.com/auth/flexible-api"],
    nativeLoopback: true,
    redirectHost: "localhost",
    listenHost: "127.0.0.1",
    port: 0,
    loginHint: "yue@example.com",
  });
  try {
    const u = new URL(login.authorizationUrl);
    assert.equal(u.searchParams.get("login_hint"), "yue@example.com");
  } finally {
    login.close("TEST_CLEANUP");
  }
});

test("POST /admin/api/accounts/login/:flowId/callback completes OAuth flow", async () => {
  let capturedConfig = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const ctx = await setupAdminGateway({
    login: async (config) => {
      capturedConfig = config;
      return {
        authorizationUrl: "https://accounts.google.com/o/oauth2/auth?state=s1",
        done,
        close: () => {},
        completeCallbackUrl: async (rawUrl) => {
          if (!rawUrl.includes("code=valid")) {
            throw Object.assign(new Error("Bad callback"), {
              code: "INVALID_CALLBACK_URL",
            });
          }
          const tokens = {
            accessToken: "ya29.access",
            refreshToken: "1//0g_new_refresh_token_123456",
            expiresInSeconds: 3600,
          };
          resolveDone(tokens);
          return tokens;
        },
      };
    },
    identify: async () => ({
      email: "callback-user@example.com",
      subject: "sub_cb_1",
    }),
  });

  try {
    const startRes = await ctx.adminPost("/admin/api/accounts/login", {
      label: "cb-test",
      acceptTerms: false,
      loginHint: "callback-user@example.com",
    });
    assert.equal(startRes.status, 201);
    const started = await startRes.json();
    assert.equal(capturedConfig.loginHint, "callback-user@example.com");

    const badRes = await ctx.adminPost(
      `/admin/api/accounts/login/${started.flowId}/callback`,
      { callbackUrl: "http://localhost:18765/?error=missing" },
    );
    assert.equal(badRes.status, 400);

    const okRes = await ctx.adminPost(
      `/admin/api/accounts/login/${started.flowId}/callback`,
      { url: "http://localhost:18765/?code=valid&state=s1" },
    );
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.flow.status, "completed");
    assert.ok(body.flow.accountId);
    assert.equal(ctx.store.data.accounts.length, 1);
    assert.equal(
      ctx.store.data.accounts[0].label,
      "callback-user@example.com",
    );
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("POST /admin/api/accounts/import-tokens and GET /admin/api/accounts/export", async () => {
  const tAdd = "1//0g_valid_add_token_123456789";
  const tUpdate = "1//0g_valid_upd_token_123456789";
  const tBad = "1//0g_bad_8048_token_1234567890";

  const ctx = await setupAdminGateway({
    refresh: async (_config, token) => {
      if (token === tBad) {
        throw Object.assign(new Error("OAuth exchange rejected (HTTP 400)"), {
          code: "invalid_grant",
        });
      }
      return {
        accessToken: token === tAdd ? "at_add" : "at_upd",
        refreshToken: token,
        expiresInSeconds: 3600,
      };
    },
    identify: async ({ accessToken }) => {
      if (accessToken === "at_add") {
        return { email: "new@example.com", subject: "sub_new" };
      }
      return { email: "existing@example.com", subject: "sub_existing" };
    },
    termsAccept: async () => ({
      status: "accepted",
      acceptedAt: new Date().toISOString(),
      version: 202601,
      legacyVersion: 202601,
    }),
  });

  try {
    ctx.store.data.accounts.push({
      id: "acc_existing_1",
      label: "existing@example.com",
      googleSubject: "sub_existing",
      enabled: true,
      status: "auth_error",
      refreshToken: "1//0g_old_token_12345678901234",
      lastError: { code: "NATIVE_PERMISSION_OR_AUTH", message: "old" },
      createdAt: 1700000000000,
    });
    ctx.store.save();

    const importRes = await ctx.adminPost("/admin/api/accounts/import-tokens", {
      tokens: `${tAdd}|New\n${tUpdate}\n${tBad}`,
      acceptTerms: true,
    });
    assert.equal(importRes.status, 200);
    const report = await importRes.json();
    assert.equal(report.total, 3);
    assert.equal(report.added, 1);
    assert.equal(report.updated, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.results[0].status, "added");
    assert.equal(report.results[1].status, "updated");
    assert.equal(report.results[2].status, "failed");
    assert.match(
      report.results[2].error,
      /仅支持 8049 \(Gemini App\) 同源 Refresh Token，不兼容 8048 \(Antigravity\) Token/,
    );

    const updatedAcc = ctx.store.data.accounts.find(
      (a) => a.id === "acc_existing_1",
    );
    assert.equal(updatedAcc.status, "ready");
    assert.equal(updatedAcc.refreshToken, tUpdate);
    assert.equal(updatedAcc.lastError, undefined);

    const arrayRes = await ctx.adminPost(
      "/admin/api/accounts/import-tokens",
      [tAdd],
    );
    assert.equal(arrayRes.status, 200);
    const arrayReport = await arrayRes.json();
    assert.equal(arrayReport.updated, 1);

    const exportRes = await ctx.adminGet("/admin/api/accounts/export");
    assert.equal(exportRes.status, 200);
    const exported = await exportRes.json();
    assert.equal(exported.format, "gemini-app2api-accounts-v1");
    assert.ok(exported.exportedAt);
    assert.equal(exported.accounts.length, 2);
    assert.deepEqual(Object.keys(exported.accounts[0]).sort(), [
      "enabled",
      "googleSubject",
      "id",
      "label",
      "refreshToken",
    ]);
  } finally {
    await ctx.app.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Chrome Local State parsing, detectChromePath, and serial chrome-oauth", async () => {
  const localState = JSON.stringify({
    profile: {
      info_cache: {
        "Profile 2": { user_name: "Two@Example.com", name: "Work" },
        Default: { user_name: "one@example.com", name: "Personal" },
        "Profile 3": { user_name: "", name: "NoEmail" },
      },
    },
  });

  const parsed = parseChromeLocalState(localState, ["two@example.com"]);
  assert.deepEqual(parsed, [
    {
      profileDir: "Default",
      name: "Personal",
      email: "one@example.com",
      alreadyAdded: false,
    },
    {
      profileDir: "Profile 2",
      name: "Work",
      email: "Two@Example.com",
      alreadyAdded: true,
    },
  ]);

  const fakeChrome =
    "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(
    detectChromePath(
      {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      (p) => p === fakeChrome,
    ),
    fakeChrome,
  );

  const dir = makeTempDir();
  const store = new StateStore({
    directory: dir,
    defaultProfile: {
      context: 2,
      enableFst: true,
      clientId: "123456-abcdef.apps.googleusercontent.com",
      clientSecret: "secret",
      scopes: ["openid", "email"],
    },
  });
  store.lock();

  let callCount = 0;
  const spawned = [];
  const accounts = new Accounts(store, {
    callbackPort: 0,
    login: async (config) => {
      callCount++;
      const idx = callCount;
      let rejectDone;
      const done = new Promise((resolve, reject) => {
        rejectDone = reject;
        if (idx === 1) {
          setTimeout(() => {
            resolve({
              accessToken: "at_1",
              refreshToken: "1//0g_chrome_token_1234567890",
              expiresInSeconds: 3600,
            });
          }, 20);
        }
      });
      return {
        authorizationUrl: `https://accounts.google.com/o/oauth2/auth?hint=${encodeURIComponent(config.loginHint || "")}`,
        done,
        close: (code) =>
          rejectDone(Object.assign(new Error("closed"), { code })),
      };
    },
    identify: async () => ({
      email: "one@example.com",
      subject: "sub_chrome_1",
    }),
  });

  try {
    const batch = await runChromeOAuthBatch(
      accounts,
      {
        profiles: [
          { profileDir: "Default", email: "one@example.com" },
          { profileDir: "Profile 2", email: "two@example.com" },
        ],
        acceptTerms: false,
      },
      {
        detectChromePath: () => fakeChrome,
        spawn: (cmd, args) => {
          spawned.push({ cmd, args });
          return { unref() {} };
        },
        timeoutMs: 80,
        pollIntervalMs: 15,
      },
    );

    assert.equal(batch.total, 2);
    assert.equal(batch.added, 1);
    assert.equal(batch.failed, 1);
    assert.equal(batch.results[0].status, "added");
    assert.equal(batch.results[1].status, "failed");
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].args[0], "--profile-directory=Default");
    assert.match(spawned[0].args[1], /hint=one%40example\.com/);
  } finally {
    await accounts.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChromePath supports CHROME_PATH, registry App Paths, and Edge fallback with Local State compatibility", () => {
  const customExe = "D:\\Portable\\Chrome\\chrome.exe";
  assert.equal(
    detectChromePath(
      { CHROME_PATH: `"${customExe}"`, ProgramFiles: "C:\\Program Files" },
      (p) => p === customExe,
    ),
    customExe,
  );

  const regChromeExe = "D:\\CustomInstall\\Chrome\\Application\\chrome.exe";
  assert.equal(
    detectChromePath(
      { ProgramFiles: "C:\\Program Files" },
      (p) => p === regChromeExe,
      {
        platform: "win32",
        spawnSync: (_cmd, args) => {
          if (String(args[1]).includes("App Paths\\chrome.exe")) {
            return {
              status: 0,
              stdout: `HKEY_LOCAL_MACHINE\\...\r\n    (Default)    REG_SZ    ${regChromeExe}\r\n`,
            };
          }
          return { status: 1, stdout: "" };
        },
      },
    ),
    regChromeExe,
  );

  const stdEdgeExe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.equal(
    detectChromePath(
      { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      (p) => p === stdEdgeExe,
      { platform: "win32", spawnSync: () => ({ status: 1, stdout: "" }) },
    ),
    stdEdgeExe,
  );

  const regEdgeExe = "D:\\EdgeCustom\\msedge.exe";
  assert.equal(
    detectChromePath(
      { ProgramFiles: "C:\\Program Files" },
      (p) => p === regEdgeExe,
      {
        platform: "win32",
        spawnSync: (_cmd, args) => {
          if (String(args[1]).includes("App Paths\\msedge.exe")) {
            return {
              status: 0,
              stdout: `HKEY_LOCAL_MACHINE\\...\r\n    (Default)    REG_SZ    "${regEdgeExe}"\r\n`,
            };
          }
          return { status: 1, stdout: "" };
        },
      },
    ),
    regEdgeExe,
  );

  const localAppData = "C:\\Users\\test\\AppData\\Local";
  const chromeState = "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data\\Local State";
  const edgeState = "C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\User Data\\Local State";
  assert.equal(
    getChromeLocalStatePath({ LOCALAPPDATA: localAppData }, { browserPath: stdEdgeExe, existsSync: () => true }),
    edgeState,
  );
  assert.equal(
    getChromeLocalStatePath({ LOCALAPPDATA: localAppData }, { existsSync: (p) => p === edgeState }),
    edgeState,
  );
  assert.equal(
    getChromeLocalStatePath({ LOCALAPPDATA: localAppData }, { existsSync: (p) => p === chromeState }),
    chromeState,
  );
});
