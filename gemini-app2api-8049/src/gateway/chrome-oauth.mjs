import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fault } from "./state.mjs";

const DEFAULT_OAUTH_TIMEOUT_MS = 120_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);

function stripSurroundingQuotes(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function queryWindowsAppPath(exeName, env = process.env, opts = {}) {
  const isWin = (opts.platform ?? process.platform) === "win32";
  const spawnSyncImpl = opts.spawnSync ?? spawnSync;
  if (!isWin && !opts.spawnSync && !opts.platform) return null;

  const systemRoot =
    (typeof env.SystemRoot === "string" && env.SystemRoot.trim()) ||
    (typeof env.WINDIR === "string" && env.WINDIR.trim()) ||
    "C:\\Windows";
  const regPath = path.win32.join(systemRoot, "System32", "reg.exe");
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
  for (const key of keys) {
    const res = spawnSyncImpl(regPath, ["query", key, "/ve"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res?.error || res?.signal || res?.status !== 0) continue;
    const match = (res.stdout ?? "").match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im);
    if (!match) continue;
    const candidate = stripSurroundingQuotes(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

export function detectChromePath(
  env = process.env,
  existsSync = fs.existsSync,
  opts = {},
) {
  const customPath = stripSurroundingQuotes(env?.CHROME_PATH);
  if (customPath && existsSync(customPath)) {
    return customPath;
  }

  const roots = [
    env?.ProgramFiles,
    env?.["ProgramFiles(x86)"],
    env?.LOCALAPPDATA,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  const seen = new Set();
  for (const root of roots) {
    const candidate = path.win32.join(
      root,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const regChrome = queryWindowsAppPath("chrome.exe", env, opts);
  if (regChrome && existsSync(regChrome)) {
    return regChrome;
  }

  for (const root of roots) {
    const candidate = path.win32.join(
      root,
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    );
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const regEdge = queryWindowsAppPath("msedge.exe", env, opts);
  if (regEdge && existsSync(regEdge)) {
    return regEdge;
  }

  return null;
}

export function getChromeLocalStatePath(env = process.env, opts = {}) {
  const localAppData =
    typeof env?.LOCALAPPDATA === "string" ? env.LOCALAPPDATA.trim() : "";
  if (!localAppData) return null;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const chromeLocalState = path.win32.join(
    localAppData,
    "Google",
    "Chrome",
    "User Data",
    "Local State",
  );
  const edgeLocalState = path.win32.join(
    localAppData,
    "Microsoft",
    "Edge",
    "User Data",
    "Local State",
  );
  if (
    typeof opts.browserPath === "string" &&
    /msedge\.exe$/i.test(opts.browserPath.trim())
  ) {
    return edgeLocalState;
  }
  if (existsSync(chromeLocalState)) return chromeLocalState;
  if (existsSync(edgeLocalState)) return edgeLocalState;
  return chromeLocalState;
}

export function parseChromeLocalState(jsonText, existingEmails = []) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const profileObj = parsed.profile;
  if (!profileObj || typeof profileObj !== "object") return [];
  const infoCache = profileObj.info_cache;
  if (!infoCache || typeof infoCache !== "object" || Array.isArray(infoCache)) {
    return [];
  }

  const existingSet = new Set();
  for (const email of existingEmails) {
    if (typeof email === "string" && email.trim()) {
      existingSet.add(email.trim().toLowerCase());
    }
  }

  const profiles = [];
  for (const [profileDir, rawInfo] of Object.entries(infoCache)) {
    if (!rawInfo || typeof rawInfo !== "object") continue;
    const email =
      typeof rawInfo.user_name === "string" ? rawInfo.user_name.trim() : "";
    if (!email) continue;
    const name =
      typeof rawInfo.name === "string" ? rawInfo.name.trim() : "";
    profiles.push({
      profileDir,
      name,
      email,
      alreadyAdded: existingSet.has(email.toLowerCase()),
    });
  }

  profiles.sort((a, b) => {
    if (a.profileDir === "Default" && b.profileDir !== "Default") return -1;
    if (b.profileDir === "Default" && a.profileDir !== "Default") return 1;
    return a.profileDir.localeCompare(b.profileDir);
  });

  return profiles;
}

export function scanChromeProfiles(accounts, opts = {}) {
  const env = opts.env ?? process.env;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const readFileSync = opts.readFileSync ?? fs.readFileSync;

  const chromePath = detectChromePath(env, existsSync, opts);
  const chromeFound = Boolean(chromePath);
  const localStatePath = getChromeLocalStatePath(env, {
    existsSync,
    browserPath: chromePath,
  });

  const existingEmails = [];
  const list = typeof accounts?.list === "function" ? accounts.list() : [];
  for (const a of list) {
    if (typeof a?.email === "string" && a.email.trim()) existingEmails.push(a.email.trim());
    if (typeof a?.label === "string" && a.label.trim()) existingEmails.push(a.label.trim());
  }

  let profiles = [];
  if (localStatePath && existsSync(localStatePath)) {
    try {
      const raw = readFileSync(localStatePath, "utf-8");
      profiles = parseChromeLocalState(raw, existingEmails);
    } catch {
      profiles = [];
    }
  }

  return {
    chromeFound,
    chromePath,
    profiles,
  };
}

async function waitForFlowTerminal(accounts, flowId, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const current = accounts.flow(flowId);
    if (TERMINAL_STATUSES.has(current.status)) {
      return { timedOut: false, flow: current };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      try {
        accounts.cancelFlow(flowId);
      } catch {
        // Ignore if already settled
      }
      return { timedOut: true, flow: accounts.flow(flowId) };
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      timer.unref?.();
    });
  }
}

export async function runChromeOAuthBatch(
  accounts,
  { profiles, acceptTerms = true } = {},
  opts = {},
) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw fault("INVALID_PROFILES", 400);
  }
  if (acceptTerms !== undefined && typeof acceptTerms !== "boolean") {
    throw fault("INVALID_TOS_CONSENT", 400);
  }

  const env = opts.env ?? process.env;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const spawnImpl = opts.spawn ?? spawn;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_OAUTH_TIMEOUT_MS;
  const pollIntervalMs =
    Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
      ? opts.pollIntervalMs
      : 200;

  const chromePath =
    typeof opts.detectChromePath === "function"
      ? opts.detectChromePath()
      : detectChromePath(env, existsSync, opts);
  if (!chromePath) {
    throw fault("CHROME_NOT_FOUND", 404);
  }

  let added = 0;
  let updated = 0;
  const skipped = 0;
  let failed = 0;
  const results = [];

  for (const profile of profiles) {
    const profileDir =
      typeof profile?.profileDir === "string" ? profile.profileDir.trim() : "";
    const email =
      typeof profile?.email === "string" && profile.email.trim()
        ? profile.email.trim()
        : undefined;

    if (!profileDir) {
      failed++;
      results.push({
        profileDir: "",
        ...(email ? { email } : {}),
        status: "failed",
        error: "profileDir is required",
      });
      continue;
    }

    const existingIdsBefore = new Set(
      (accounts.store?.data?.accounts ?? []).map((a) => a.id),
    );

    try {
      const started = await accounts.beginLogin({
        label: email || profileDir,
        acceptTerms: acceptTerms ?? true,
        ...(email ? { loginHint: email } : {}),
      });

      const child = spawnImpl(
        chromePath,
        [`--profile-directory=${profileDir}`, started.authorizationUrl],
        { detached: true, stdio: "ignore" },
      );
      child?.unref?.();

      const { timedOut, flow } = await waitForFlowTerminal(
        accounts,
        started.flowId,
        timeoutMs,
        pollIntervalMs,
      );

      if (timedOut) {
        failed++;
        results.push({
          profileDir,
          ...(email ? { email } : {}),
          status: "failed",
          error: "OAuth login timed out",
        });
      } else if (flow.status === "completed") {
        const wasExisting = flow.accountId
          ? existingIdsBefore.has(flow.accountId)
          : false;
        if (wasExisting) updated++;
        else added++;
        results.push({
          profileDir,
          ...(email ? { email } : {}),
          status: wasExisting ? "updated" : "added",
          ...(flow.accountId ? { accountId: flow.accountId } : {}),
        });
      } else {
        failed++;
        results.push({
          profileDir,
          ...(email ? { email } : {}),
          status: "failed",
          error: flow.errorCode || `OAuth flow ${flow.status}`,
        });
      }
    } catch (error) {
      failed++;
      results.push({
        profileDir,
        ...(email ? { email } : {}),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    total: profiles.length,
    added,
    updated,
    skipped,
    failed,
    results,
  };
}
