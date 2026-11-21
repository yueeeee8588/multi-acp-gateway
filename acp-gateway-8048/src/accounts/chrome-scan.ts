import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/settings";
import { store } from "../db/store";
import {
  AccountManager,
  accountManager as defaultAccountManager,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_TOKEN_URL,
} from "./manager";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const CHROME_OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");
const DEFAULT_OAUTH_TIMEOUT_MS = 120_000;

export interface ChromeProfileInfo {
  profileDir: string;
  name: string;
  email: string;
  gaiaName: string;
  alreadyAdded: boolean;
}

export interface ChromeScanResult {
  chromeAvailable: boolean;
  chromePath: string | null;
  profiles: ChromeProfileInfo[];
}

export interface ChromeOAuthProfileRequest {
  profileDir: string;
  email?: string;
}

export interface ChromeOAuthErrorItem {
  profileDir: string;
  email?: string;
  error: string;
}

export interface ChromeOAuthResult {
  ok: true;
  imported: number;
  skipped: number;
  errors: ChromeOAuthErrorItem[];
}

/**
 * 探测本机 Chrome 可执行文件路径。
 */
export function detectChromePath(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (p: string) => boolean = fs.existsSync
): string | null {
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v));

  const seen = new Set<string>();
  for (const root of roots) {
    const candidate = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 获取本机 Chrome Local State 文件路径。
 */
export function getChromeLocalStatePath(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  return path.join(localAppData, "Google", "Chrome", "User Data", "Local State");
}

/**
 * 纯函数：解析 Chrome Local State JSON，提取带邮箱的 Profile 并标记是否已入库。
 */
export function parseChromeLocalState(
  jsonText: string,
  existingEmails: Iterable<string> = []
): ChromeProfileInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];
  const profileObj = (parsed as Record<string, unknown>).profile;
  if (!profileObj || typeof profileObj !== "object") return [];
  const infoCache = (profileObj as Record<string, unknown>).info_cache;
  if (!infoCache || typeof infoCache !== "object" || Array.isArray(infoCache)) {
    return [];
  }

  const existingSet = new Set<string>();
  for (const email of existingEmails) {
    if (typeof email === "string" && email.trim()) {
      existingSet.add(email.trim().toLowerCase());
    }
  }

  const profiles: ChromeProfileInfo[] = [];
  for (const [profileDir, rawInfo] of Object.entries(
    infoCache as Record<string, unknown>
  )) {
    if (!rawInfo || typeof rawInfo !== "object") continue;
    const info = rawInfo as Record<string, unknown>;
    const email = typeof info.user_name === "string" ? info.user_name.trim() : "";
    if (!email) continue;

    const name = typeof info.name === "string" ? info.name.trim() : "";
    const gaiaName =
      typeof info.gaia_name === "string" ? info.gaia_name.trim() : "";

    profiles.push({
      profileDir,
      name,
      email,
      gaiaName,
      alreadyAdded: existingSet.has(email.toLowerCase()),
    });
  }

  return profiles;
}

/**
 * 扫描本机 Chrome 与已登录的 Profile 列表。
 */
export function scanChromeProfiles(): ChromeScanResult {
  const chromePath = detectChromePath();
  const chromeAvailable = chromePath !== null;
  const localStatePath = getChromeLocalStatePath();

  if (!localStatePath || !fs.existsSync(localStatePath)) {
    return { chromeAvailable, chromePath, profiles: [] };
  }

  let jsonText = "";
  try {
    jsonText = fs.readFileSync(localStatePath, "utf8");
  } catch {
    return { chromeAvailable, chromePath, profiles: [] };
  }

  const existingEmails = store
    .listAccounts()
    .map((acc) => acc.email)
    .filter((email): email is string => Boolean(email));

  const profiles = parseChromeLocalState(jsonText, existingEmails);
  return { chromeAvailable, chromePath, profiles };
}

function resolveProxyUrl(explicitProxy?: string): string | undefined {
  const cfg = getConfig();
  return (
    explicitProxy?.trim() ||
    cfg.defaultProxy?.trim() ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    undefined
  );
}

function renderCallbackHtml(title: string, message: string): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #111827; color: #f9fafb; }
    .card { padding: 24px 32px; border-radius: 12px; background: #1f2937; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  </style>
</head>
<body>
  <div class="card">
    <h2>${title}</h2>
    <p>${message}</p>
  </div>
  <script>setTimeout(function () { window.close(); }, 300);</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function waitForProfileAuthCode(
  chromePath: string,
  profile: ChromeOAuthProfileRequest,
  timeoutMs: number
): Promise<{ code: string; redirectUri: string }> {
  const state = randomBytes(16).toString("hex");
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveAuth!: (value: { code: string; redirectUri: string }) => void;
  let rejectAuth!: (reason?: unknown) => void;

  const authPromise = new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    }
  );

  let redirectUri = "";
  const callbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname !== "/oauth2callback") {
        return new Response("Not Found", { status: 404 });
      }

      const returnedState = reqUrl.searchParams.get("state");
      if (returnedState !== state) {
        return renderCallbackHtml("授权校验失败", "State 不匹配，请关闭此窗口重试。");
      }

      const oauthError = reqUrl.searchParams.get("error");
      if (oauthError) {
        const desc = reqUrl.searchParams.get("error_description") || oauthError;
        if (!settled) {
          settled = true;
          rejectAuth(new Error(`OAuth denied: ${desc}`));
        }
        return renderCallbackHtml("授权未完成", `Google 返回错误：${desc}`);
      }

      const code = reqUrl.searchParams.get("code")?.trim();
      if (!code) {
        if (!settled) {
          settled = true;
          rejectAuth(new Error("Missing authorization code in callback"));
        }
        return renderCallbackHtml("授权失败", "回调缺少 code 参数，请关闭此窗口。");
      }

      if (!settled) {
        settled = true;
        resolveAuth({ code, redirectUri });
      }
      return renderCallbackHtml("授权成功", "已获取授权凭证，窗口即将自动关闭。");
    },
  });

  try {
    redirectUri = `http://127.0.0.1:${callbackServer.port}/oauth2callback`;

    const authParams = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: CHROME_OAUTH_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    if (profile.email?.trim()) {
      authParams.set("login_hint", profile.email.trim());
    }

    const authUrl = `${GOOGLE_AUTH_URL}?${authParams.toString()}`;

    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectAuth(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    Bun.spawn([chromePath, `--profile-directory=${profile.profileDir}`, authUrl], {
      stdout: "ignore",
      stderr: "ignore",
    });

    return await authPromise;
  } finally {
    if (timer) clearTimeout(timer);
    callbackServer.stop(true);
  }
}

async function exchangeCodeForRefreshToken(
  code: string,
  redirectUri: string,
  proxyUrl?: string
): Promise<string> {
  const fetchInit: RequestInit & { proxy?: string } = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  };
  if (proxyUrl) {
    fetchInit.proxy = proxyUrl;
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, fetchInit);
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

  if (!resp.ok) {
    const errMsg =
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${resp.status}`;
    throw new Error(`Code exchange failed: ${errMsg}`);
  }

  const refreshToken =
    typeof json.refresh_token === "string" ? json.refresh_token.trim() : "";
  if (!refreshToken) {
    throw new Error("Token response missing refresh_token");
  }
  return refreshToken;
}

/**
 * 串行拉起指定 Chrome Profile 完成 OAuth 授权并入库。
 */
export async function authorizeChromeProfiles(
  profiles: ChromeOAuthProfileRequest[],
  opts?: {
    accountManager?: Pick<AccountManager, "importTokens">;
    timeoutMs?: number;
    proxyUrl?: string;
  }
): Promise<ChromeOAuthResult> {
  const chromePath = detectChromePath();
  if (!chromePath) {
    throw new Error("Chrome executable not found");
  }

  const manager = opts?.accountManager ?? defaultAccountManager;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  const proxyUrl = resolveProxyUrl(opts?.proxyUrl);

  let imported = 0;
  let skipped = 0;
  const errors: ChromeOAuthErrorItem[] = [];

  for (const profile of profiles) {
    const profileDir = profile.profileDir?.trim();
    if (!profileDir) {
      errors.push({
        profileDir: "",
        email: profile.email,
        error: "profileDir is required",
      });
      continue;
    }

    try {
      const { code, redirectUri } = await waitForProfileAuthCode(
        chromePath,
        { profileDir, email: profile.email },
        timeoutMs
      );
      const refreshToken = await exchangeCodeForRefreshToken(
        code,
        redirectUri,
        proxyUrl
      );
      const importResult = await manager.importTokens([refreshToken], {
        proxyUrl,
      });

      if (importResult.imported > 0) {
        imported += importResult.imported;
      } else if (importResult.updated > 0) {
        skipped += importResult.updated;
      } else {
        const firstErr =
          importResult.results.find((r) => !r.ok)?.error ||
          "Account import failed";
        errors.push({ profileDir, email: profile.email, error: firstErr });
      }
    } catch (err) {
      errors.push({
        profileDir,
        email: profile.email,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, imported, skipped, errors };
}

export type OpenUrlInAccountChromeResult =
  | {
      ok: true;
      launched: false;
      reason: "chrome_not_found";
    }
  | {
      ok: true;
      launched: false;
      reason: "profile_not_found";
      email: string;
    }
  | {
      ok: true;
      launched: true;
      profileDir: string;
      profileName: string;
      email: string;
      url: string;
    };

export interface OpenUrlInAccountChromeDeps {
  scan?: typeof scanChromeProfiles;
  spawn?: (
    cmd: string[],
    options: { stdout: "ignore"; stderr: "ignore"; stdin: "ignore" }
  ) => unknown;
}

/**
 * 按账号邮箱匹配本机 Chrome Profile，并以该 Profile 启动 Chrome 打开目标 URL。
 */
export function openUrlInAccountChrome(
  email: string,
  targetUrl: string,
  deps?: OpenUrlInAccountChromeDeps
): OpenUrlInAccountChromeResult {
  const safeUrl = typeof targetUrl === "string" ? targetUrl.trim() : "";
  if (!safeUrl) {
    throw new Error("URL is required");
  }
  if (/[\r\n\0]/.test(safeUrl)) {
    throw new Error("URL contains invalid control characters");
  }
  if (!/^https?:\/\//i.test(safeUrl)) {
    throw new Error("URL must start with http:// or https://");
  }

  const scan = deps?.scan ?? scanChromeProfiles;
  const { chromeAvailable, chromePath, profiles } = scan();
  if (!chromeAvailable || !chromePath) {
    return { ok: true, launched: false, reason: "chrome_not_found" as const };
  }

  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedEmail) {
    return { ok: true, launched: false, reason: "profile_not_found" as const, email };
  }

  const matched = profiles.find(
    (p) => typeof p.email === "string" && p.email.trim().toLowerCase() === normalizedEmail
  );
  if (!matched) {
    return { ok: true, launched: false, reason: "profile_not_found" as const, email };
  }

  const spawnFn = deps?.spawn ?? ((cmd, options) => Bun.spawn(cmd, options));
  spawnFn([chromePath, `--profile-directory=${matched.profileDir}`, safeUrl], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });

  return {
    ok: true,
    launched: true,
    profileDir: matched.profileDir,
    profileName: matched.name || matched.gaiaName || matched.profileDir,
    email: matched.email,
    url: safeUrl,
  };
}

