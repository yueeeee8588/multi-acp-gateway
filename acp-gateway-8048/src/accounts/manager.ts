import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpConnection } from "../acp/connection";
import { buildAgyWorkerArgs, buildIsolatedAgyEnv, ensureIsolatedHomeStructure, getDataRoot, resolveAgyBinary } from "../acp/env";
import { getConfig, resolveEffectiveProxy } from "../config/settings";
import { resolveEffectiveProxy as resolveOutboundProxy } from "./system-proxy";
import { store } from "../db/store";
import { eventBus } from "../logs/events";
import { checkProxyReachable, detectExitIpDrift, probeAccountExit } from "./exit-probe";
import { authorizeSingleAccountOAuth } from "./chrome-scan";
import {
  createUsageReader,
  fetchAccountQuota,
  isLegacyDirectQuotaEnabled,
  mergeUsageSnapshotWithPreviousModels,
  type Quota403Restriction,
  type UsageReader,
} from "./quota";
import { normalizeModelAccessRule } from "./model-binding";
import type { AccountQuotaSnapshot, AccountRecord, AccountStatus, AccountTier, CooldownRecord, ModelAccessRule } from "../types";

export const GOOGLE_CLIENT_ID =
  process.env.AGY_GOOGLE_CLIENT_ID ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com";
export const GOOGLE_CLIENT_SECRET =
  process.env.AGY_GOOGLE_CLIENT_SECRET ||
  ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const LOAD_CODE_ASSIST_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const CODE_ASSIST_USER_AGENT = "antigravity/1.15.8 windows/amd64";

/** 探测入口可注入，便于离线单测；默认走官方 loadCodeAssist。 */
export type TierDetectFetcher = typeof fetch;
let tierDetectFetcher: TierDetectFetcher = fetch;

/** 仅用于测试替换网络层；生产不调用。 */
export function __setTierDetectFetcher(next: TierDetectFetcher): void {
  tierDetectFetcher = next;
}

export const ACP_PROBE_TIMEOUT_MS = 50_000;

export interface AcpProbeConnectionLike {
  initialize(): Promise<unknown>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export interface AcpProbeDeps {
  createConnection?: (opts: ConstructorParameters<typeof AcpConnection>[0]) => AcpProbeConnectionLike;
  timeoutMs?: number;
  probeExit?: typeof probeAccountExit;
}

let acpProbeDeps: AcpProbeDeps = {};

/** 仅用于测试注入 ACP 探活依赖；生产不调用。 */
export function __setAcpProbeDepsForTest(deps: AcpProbeDeps): void {
  acpProbeDeps = deps;
}

function formatQuotaRestrictionReason(restriction: Quota403Restriction): string {
  const prefix =
    restriction.kind === "validation_required"
      ? "Account verification required"
      : "Account restricted (ToS violation)";
  const base = `${prefix}: ${restriction.message}`;
  const withUrl =
    restriction.validationUrl && !base.includes(restriction.validationUrl)
      ? `${base} (${restriction.validationUrl})`
      : base;
  return withUrl.slice(0, 1000);
}

let testUsageReader: UsageReader | undefined;

/** 仅用于测试注入配额读取器；生产不调用。 */
export function __setUsageReaderForTest(reader?: UsageReader): void {
  testUsageReader = reader;
}

/**
 * 精确分流纯血 ACP 探活异常：
 * - 401/认证类错误 → auth_required
 * - 明确风控/封禁语义（403/validation_required/restricted 等）→ restricted
 * - 超时或瞬态网络异常 → 绝不误杀为 restricted，保持原状态并记录异常原因
 */
export function classifyAcpProbeError(
  err: unknown,
  currentStatus: AccountStatus
): { status: AccountStatus; reason: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const reason = msg.slice(0, 1000);

  if (
    /403|forbidden|restricted|validation_required|verify your account|account verification|violation of terms|service has been disabled|account has been disabled|suspended|banned|submit an appeal/.test(
      lower
    )
  ) {
    return { status: "restricted", reason };
  }
  if (
    /401|unauthorized|unauthenticated|invalid_grant|invalid_client|unauthorized_client|please login|not logged in|invalid credentials/.test(
      lower
    )
  ) {
    return { status: "auth_required", reason };
  }
  return { status: currentStatus, reason };
}

/**
 * 从 loadCodeAssist 响应中解析账号等级。
 * 优先 paidTier/paid_tier，其次兜底 currentTier/current_tier；
 * 命中 id 含 pro/ultra 视为 pro，明确存在但不含则 standard，无字段返回 null。
 */
export function parseCodeAssistTier(payload: Record<string, unknown>): AccountTier | null {
  if (!payload || typeof payload !== "object") return null;

  const readTierId = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
    return null;
  };

  let tierId: string | null = null;
  for (const key of ["paidTier", "paid_tier"] as const) {
    tierId = readTierId(payload[key]);
    if (tierId) break;
  }
  if (!tierId) {
    for (const key of ["currentTier", "current_tier"] as const) {
      tierId = readTierId(payload[key]);
      if (tierId) break;
    }
  }

  if (!tierId) return null;
  const lowered = tierId.toLowerCase();
  return lowered.includes("pro") || lowered.includes("ultra") ? "pro" : "standard";
}

/**
 * 真实调用 Google Cloud Code loadCodeAssist 探测账号等级。
 * 网络/HTTP 失败一律返回 null，由调用方决定是否保留原值。
 */
export async function detectAccountTier(
  accessToken: string,
  proxyUrl?: string
): Promise<AccountTier | null> {
  const token = accessToken?.trim();
  if (!token) return null;

  const effectiveProxy = resolveOutboundProxy(proxyUrl) ?? "";
  const init: RequestInit & { proxy?: string } = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": CODE_ASSIST_USER_AGENT,
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    signal: AbortSignal.timeout(8000),
  };
  if (effectiveProxy) init.proxy = effectiveProxy;

  try {
    const resp = await tierDetectFetcher(LOAD_CODE_ASSIST_URL, init);
    if (!resp.ok) return null;
    const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return null;
    return parseCodeAssistTier(json);
  } catch {
    return null;
  }
}

export interface ImportTokenItemResult {
  index: number;
  email: string;
  id: string;
  action: "imported" | "updated" | "failed";
  ok: boolean;
  error?: string;
}

export interface ImportRefreshTokensResult {
  imported: number;
  updated: number;
  failed: number;
  results: ImportTokenItemResult[];
}

export interface DetectTierDetail {
  id: string;
  label: string;
  email: string;
  ok: boolean;
  tier: AccountTier | null;
  reason?: string;
}

export interface DetectAllTiersResult {
  total: number;
  updated: number;
  pro: number;
  standard: number;
  failed: number;
  details: DetectTierDetail[];
}

const MAX_QUOTA_CONCURRENCY = 4;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 30_000;

// The cooldown row has no write timestamp and an upsert can leave every field unchanged.
interface CooldownProbe {
  before: CooldownRecord | undefined;
  rewritten: boolean;
}
const activeCooldownProbes = new Map<string, CooldownProbe>();
const upsertCooldown = store.upsertCooldown.bind(store);
store.upsertCooldown = (cooldown) => {
  upsertCooldown(cooldown);
  if (cooldown.family === "*" && cooldown.scopeType === "global") {
    const probe = activeCooldownProbes.get(cooldown.accountId);
    if (probe) probe.rewritten = true;
  }
};

function findGlobalCooldown(accountId: string, now?: number): CooldownRecord | undefined {
  return store.listCooldowns(now).find((entry) =>
    entry.accountId === accountId && entry.family === "*" && entry.scopeType === "global");
}

const quotaWaiters: Array<() => void> = [];
let activeQuotaJobs = 0;

function readOAuthCredentials(homeDir: string) {
  if (!homeDir.trim()) return null;
  const tokenFile = path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFile, "utf8")) as Record<string, unknown>;
    const token = parsed.token && typeof parsed.token === "object"
      ? (parsed.token as Record<string, unknown>)
      : parsed;
    const expiry = token.expiry ?? token.expiry_date ?? token.expires_at;
    const expiryNumber = typeof expiry === "number" ? expiry : typeof expiry === "string" ? Date.parse(expiry) : NaN;
    const expiresAt = typeof expiry === "number" && expiry < 1e12 ? expiryNumber * 1000 : expiryNumber;
    return {
      accessToken: typeof token.access_token === "string" ? token.access_token.trim() : "",
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token.trim() : "",
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    };
  } catch {
    return null;
  }
}

function readOAuthRefreshToken(homeDir: string): string | null {
  return readOAuthCredentials(homeDir)?.refreshToken || null;
}

class OAuthRefreshError extends Error {
  constructor(message: string, readonly kind: "permanent" | "transient" | "other", options?: ErrorOptions) {
    super(message, options);
  }
}

async function exchangeOAuthRefreshToken(refreshToken: string, proxy?: string) {
  const init: RequestInit & { proxy?: string } = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  };
  if (proxy) init.proxy = proxy;

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, init);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new OAuthRefreshError(message, "transient", { cause });
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const accessToken = typeof data?.access_token === "string" ? data.access_token.trim() : "";
  if (!response.ok || !accessToken) {
    const code = typeof data?.error === "string" ? data.error.trim() : "";
    const description = typeof data?.error_description === "string" ? data.error_description.trim() : "";
    const detail = [code, description].filter(Boolean).join(": ") || `HTTP ${response.status}`;
    const permanent = response.status === 401 || response.status === 403 ||
      (response.status === 400 && code === "invalid_grant");
    const transient = response.status === 408 || response.status === 429 || response.status >= 500;
    const kind = permanent ? "permanent" : transient ? "transient" : "other";
    throw new OAuthRefreshError(`OAuth refresh failed (${detail})`, kind);
  }

  return {
    accessToken,
    refreshToken: typeof data?.refresh_token === "string" ? data.refresh_token.trim() || refreshToken : refreshToken,
    expiresIn: typeof data?.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 3600,
  };
}

function writeIsolatedAgyOAuthToken(
  isolatedHomeDir: string,
  params: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }
): void {
  const appDataDir = path.join(isolatedHomeDir, ".gemini", "antigravity-cli");
  const cacheDir = path.join(appDataDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const expiresIn = Math.max(0, Math.trunc(params.expiresIn));
  const expiryIso = new Date(Date.now() + expiresIn * 1000).toISOString();
  const tokenPayload = JSON.stringify({
    token: {
      access_token: params.accessToken,
      token_type: "Bearer",
      refresh_token: params.refreshToken,
      expiry: expiryIso,
      expires_in: expiresIn,
    },
    auth_method: "consumer",
  });

  const tokenFile = path.join(appDataDir, "antigravity-oauth-token");
  const tokenTmp = `${tokenFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tokenTmp, tokenPayload, { mode: 0o600 });
  fs.renameSync(tokenTmp, tokenFile);

  const acpStateFile = path.join(cacheDir, "acp-auth-state.json");
  const acpStateTmp = `${acpStateFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(acpStateTmp, JSON.stringify({ methodId: "oauth-personal" }), {
    mode: 0o600,
  });
  fs.renameSync(acpStateTmp, acpStateFile);
}

function parseRefreshTokens(rawText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const pushToken = (candidate: string) => {
    const cleaned = candidate.split("|")[0]?.trim() || "";
    if (cleaned.startsWith("1//") && cleaned.length > 16 && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  };

  const trimmed = rawText.trim();
  if (!trimmed) return out;

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") pushToken(item);
          else if (item && typeof item === "object" && "refresh_token" in item) {
            const rt = (item as Record<string, unknown>).refresh_token;
            if (typeof rt === "string") pushToken(rt);
          }
        }
        if (out.length > 0) return out;
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.refresh_token === "string") pushToken(obj.refresh_token);
        if (Array.isArray(obj.tokens)) {
          for (const item of obj.tokens) {
            if (typeof item === "string") pushToken(item);
          }
        }
        if (out.length > 0) return out;
      }
    } catch {
      // 回退到按行解析
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    for (const part of line.split(/[,\s]+/)) {
      if (part) pushToken(part);
    }
  }
  return out;
}

export interface CreateAccountInput {
  id?: string;
  label: string;
  email?: string;
  source?: string;
  homeDir?: string;
  proxyUrl?: string;
  status?: AccountStatus;
  tier?: AccountTier;
  concurrencyLimit?: number;
}

export interface UpdateAccountPatch {
  label?: string;
  email?: string;
  proxyUrl?: string;
  status?: AccountStatus;
  statusReason?: string;
  tier?: AccountTier;
  modelAccessRule?: ModelAccessRule;
  concurrencyLimit?: number;
}

function getAccountsBaseDir(): string {
  const dir = path.join(getDataRoot(), "accounts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function copyDirSafe(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSafe(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".log")) continue;
      try {
        fs.copyFileSync(srcPath, dstPath);
      } catch {
        // 忽略被占用或无权限的临时/日志文件
      }
    }
  }
}

function loadAgyAccountIndexMap(): Map<string, string> {
  const map = new Map<string, string>();
  const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(userHome, "AppData", "Local");
  const indexPaths = [
    path.join(localAppData, "agy-acp", "account-index.json"),
    path.join(userHome, ".local", "share", "agy-acp", "account-index.json"),
  ];
  for (const idxPath of indexPaths) {
    try {
      if (!fs.existsSync(idxPath)) continue;
      const raw = JSON.parse(fs.readFileSync(idxPath, "utf-8")) as Record<string, unknown>;
      for (const [email, uuid] of Object.entries(raw)) {
        if (typeof uuid === "string" && uuid.trim() && email.includes("@")) {
          map.set(uuid.trim().toLowerCase(), email.trim());
        }
      }
    } catch {
      // ignore malformed index
    }
  }
  return map;
}

function isUuidLike(value: string): boolean {
  const trimmed = value.trim().replace(/^magpie_/, "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}

function readEmailFromAgyDir(dirPath: string): string {
  const candidates = [
    path.join(dirPath, "user.json"),
    path.join(dirPath, "account.json"),
    path.join(dirPath, "auth.json"),
    path.join(dirPath, ".gemini", "antigravity-cli", "user.json"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      if (typeof raw.email === "string" && raw.email.trim()) {
        return raw.email.trim();
      }
    } catch {}
  }
  const indexMap = loadAgyAccountIndexMap();
  const baseName = path.basename(dirPath).replace(/^magpie_/, "").toLowerCase();
  return indexMap.get(baseName) || "";
}

async function readEmailFromOAuthToken(dirPath: string, proxyUrl?: string): Promise<string> {
  const tokenCandidates = [
    path.join(dirPath, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(dirPath, "antigravity-oauth-token"),
  ];
  let accessToken = "";
  let refreshToken = "";
  for (const file of tokenCandidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      const tokenObj = (raw.token && typeof raw.token === "object" ? raw.token : raw) as Record<string, unknown>;
      if (typeof tokenObj.access_token === "string" && tokenObj.access_token.trim()) {
        accessToken = tokenObj.access_token.trim();
      }
      if (typeof tokenObj.refresh_token === "string" && tokenObj.refresh_token.trim()) {
        refreshToken = tokenObj.refresh_token.trim();
      }
      if (accessToken || refreshToken) break;
    } catch {}
  }

  if (!accessToken && !refreshToken) return "";

  const effectiveProxy = resolveOutboundProxy(proxyUrl) ?? "";
  const fetchUserInfo = async (token: string): Promise<string> => {
    const init: RequestInit & { proxy?: string } = {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    };
    if (effectiveProxy) init.proxy = effectiveProxy;
    const resp = await fetch(GOOGLE_USERINFO_URL, init);
    if (!resp.ok) return "";
    const data = (await resp.json()) as { email?: string };
    return typeof data.email === "string" && data.email.trim() ? data.email.trim() : "";
  };

  if (accessToken) {
    try {
      const email = await fetchUserInfo(accessToken);
      if (email) return email;
    } catch {}
  }

  if (refreshToken) {
    try {
      const body = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      const init: RequestInit & { proxy?: string } = {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      };
      if (effectiveProxy) init.proxy = effectiveProxy;
      const tokenResp = await fetch(GOOGLE_TOKEN_URL, init);
      if (tokenResp.ok) {
        const tokenData = (await tokenResp.json()) as { access_token?: string };
        if (tokenData.access_token) {
          const email = await fetchUserInfo(tokenData.access_token);
          if (email) return email;
        }
      }
    } catch {}
  }

  return "";
}

type OAuthTokens = Awaited<ReturnType<typeof exchangeOAuthRefreshToken>>;
interface AccountAuthQueue {
  tail: Promise<void>;
  renewal?: {
    homeDir: string;
    proxy?: string;
    refreshToken: string;
    result: Promise<OAuthTokens | null>;
  };
}

// The API and the background recovery job use different AccountManager instances.
const accountAuthQueues = new Map<string, AccountAuthQueue>();

async function withAccountAuthLock<T>(accountId: string, work: (queue: AccountAuthQueue) => Promise<T>): Promise<T> {
  const queue = accountAuthQueues.get(accountId) ?? { tail: Promise.resolve() };
  const previous = queue.tail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  queue.tail = turn;
  accountAuthQueues.set(accountId, queue);
  await previous;
  try {
    return await work(queue);
  } finally {
    if (queue.tail === turn) accountAuthQueues.delete(accountId);
    release();
  }
}

function renewAccountOAuth(
  queue: AccountAuthQueue,
  account: AccountRecord,
  refreshToken: string,
  proxy?: string,
): Promise<OAuthTokens | null> {
  const existing = queue.renewal;
  if (existing?.homeDir === account.homeDir && existing.proxy === proxy && existing.refreshToken === refreshToken) {
    return existing.result;
  }

  // Share the result with queued callers, including token rotation or a failed exchange.
  const renewal: NonNullable<AccountAuthQueue["renewal"]> = {
    homeDir: account.homeDir,
    proxy,
    refreshToken,
    result: exchangeOAuthRefreshToken(refreshToken, proxy).then((tokens) => {
      if (store.getAccount(account.id)?.homeDir !== account.homeDir) return null;
      writeIsolatedAgyOAuthToken(account.homeDir, tokens);
      renewal.refreshToken = tokens.refreshToken;
      return tokens;
    }),
  };
  queue.renewal = renewal;
  return renewal.result;
}

export class AccountManager {
  private readonly quotaJobs = new Map<string, Promise<AccountRecord | null>>();
  private bulkQuotaJob?: Promise<{ refreshed: number; failed: number; accounts: AccountRecord[] }>;
  private readonly defaultUsageReader: UsageReader = createUsageReader({
    readCredentials: readOAuthCredentials,
  });
  private usageReaderOverride?: UsageReader;

  /** 仅用于测试在实例级注入 UsageReader。 */
  setUsageReaderForTest(reader?: UsageReader): void {
    this.usageReaderOverride = reader;
  }

  listAccounts(): AccountRecord[] {
    return store.listAccounts();
  }

  getAccount(id: string): AccountRecord | null {
    return store.getAccount(id);
  }

  createAccount(input: CreateAccountInput): AccountRecord {
    const now = Date.now();
    const id = input.id?.trim() || `acc_${randomUUID().slice(0, 8)}`;
    const homeDir = input.homeDir?.trim() || path.join(getAccountsBaseDir(), id);
    ensureIsolatedHomeStructure(homeDir);

    const record: AccountRecord = {
      id,
      label: input.label.trim() || id,
      email: input.email?.trim() || "",
      source: input.source?.trim() || "manual",
      homeDir,
      proxyUrl: input.proxyUrl?.trim() || "",
      status: input.status ?? "auth_required",
      statusReason: input.status === "ready" ? "" : "Awaiting login",
      tier: input.tier === "pro" ? "pro" : "standard",
      exitIp: "",
      exitCountry: "",
      concurrencyLimit: input.concurrencyLimit ?? getConfig().perAccountConcurrency ?? 2,
      activeWorkers: 0,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    store.upsertAccount(record);
    this.emitAccounts();
    return record;
  }

  updateAccount(id: string, patch: UpdateAccountPatch): AccountRecord | null {
    const existing = store.getAccount(id);
    if (!existing) return null;

    const nextStatusReason =
      patch.statusReason !== undefined
        ? patch.statusReason
        : patch.status === "ready"
          ? ""
          : existing.statusReason;

    const next: AccountRecord = {
      ...existing,
      label: patch.label !== undefined ? patch.label : existing.label,
      email: patch.email !== undefined ? patch.email : existing.email,
      proxyUrl: patch.proxyUrl !== undefined ? patch.proxyUrl : existing.proxyUrl,
      status: patch.status !== undefined ? patch.status : existing.status,
      statusReason: nextStatusReason,
      modelAccessRule: normalizeModelAccessRule(
        patch.modelAccessRule === undefined ? existing.modelAccessRule : patch.modelAccessRule,
      ),
      tier: patch.tier !== undefined ? (patch.tier === "pro" ? "pro" : "standard") : existing.tier,
      concurrencyLimit:
        patch.concurrencyLimit !== undefined ? patch.concurrencyLimit : existing.concurrencyLimit,
      updatedAt: Date.now(),
    };

    store.upsertAccount(next);
    if (patch.status === "ready") {
      const deleted = store.deleteCooldown(id, "*", "global");
      if (deleted) {
        eventBus.emit("cooldowns", store.listCooldowns(Date.now()));
      }
    }
    this.emitAccounts();
    return next;
  }

  setAccountStatus(id: string, status: AccountStatus, reason = ""): AccountRecord | null {
    return this.updateAccount(id, { status, statusReason: reason });
  }

  deleteAccount(id: string): boolean {
    const deleted = store.deleteAccount(id);
    if (deleted) {
      this.emitAccounts();
    }
    return deleted;
  }

  /**
   * 自动扫描本机现有 agy 与 magpie-agy-acp 隔离账号目录并安全导入到 data/accounts/<id>
   */
  importLocalAccounts(): AccountRecord[] {
    const imported: AccountRecord[] = [];
    const existing = store.listAccounts();
    const existingSources = new Set(existing.map((a) => `${a.source}:${a.email || a.label}`));

    const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(userHome, "AppData", "Local");

    // 1. 扫描本机默认 agy 目录 (%USERPROFILE%\.gemini\antigravity-cli)
    const defaultAgyCli = path.join(userHome, ".gemini", "antigravity-cli");
    if (fs.existsSync(defaultAgyCli)) {
      const email = readEmailFromAgyDir(defaultAgyCli);
      const dedupKey = `local-agy:${email || "default"}`;
      if (!existingSources.has(dedupKey)) {
        const id = `agy_local_${randomUUID().slice(0, 6)}`;
        const homeDir = path.join(getAccountsBaseDir(), id);
        ensureIsolatedHomeStructure(homeDir);
        copyDirSafe(defaultAgyCli, path.join(homeDir, ".gemini", "antigravity-cli"));
        const hasToken = Boolean(readOAuthRefreshToken(homeDir));
        const acc = this.createAccount({
          id,
          label: email || "Local agy",
          email,
          source: "local-agy",
          homeDir,
          status: hasToken ? "ready" : "auth_required",
        });
        imported.push(acc);
        existingSources.add(dedupKey);
      }
    }

    // 2. 扫描 magpie-agy-acp 隔离账号目录
    const magpieRoots = [
      path.join(localAppData, "agy-acp", "accounts"),
      path.join(userHome, ".local", "share", "agy-acp", "accounts"),
      path.join(localAppData, "agy-acp"),
      path.join(userHome, ".local", "share", "agy-acp"),
    ];

    for (const root of magpieRoots) {
      if (!fs.existsSync(root)) continue;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const srcDir = path.join(root, entry.name);
        const agySubDir = path.join(srcDir, ".gemini", "antigravity-cli");
        if (!fs.existsSync(agySubDir)) continue;

        const email = readEmailFromAgyDir(srcDir);
        const dedupKey = `magpie-agy-acp:${email || entry.name}`;
        if (existingSources.has(dedupKey)) continue;

        const id = `magpie_${entry.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}`;
        const homeDir = path.join(getAccountsBaseDir(), id);
        ensureIsolatedHomeStructure(homeDir);
        copyDirSafe(agySubDir, path.join(homeDir, ".gemini", "antigravity-cli"));

        const hasToken = Boolean(readOAuthRefreshToken(homeDir));
        const acc = this.createAccount({
          id,
          label: email || entry.name,
          email,
          source: "magpie-agy-acp",
          homeDir,
          status: hasToken ? "ready" : "auth_required",
        });
        imported.push(acc);
        existingSources.add(dedupKey);
      }
    }

    if (imported.length > 0) {
      void this.syncMissingAccountEmails();
    }
    return imported;
  }

  async syncMissingAccountEmails(): Promise<number> {
    const indexMap = loadAgyAccountIndexMap();
    const accounts = store.listAccounts();
    let updated = 0;

    for (const acc of accounts) {
      const missingEmail = !acc.email.trim();
      const uuidLabel = isUuidLike(acc.label) || acc.label === acc.id || acc.label === "Local agy";
      if (!missingEmail && !uuidLabel) continue;

      let email = acc.email.trim();
      if (!email) {
        const candidateKeys = [
          acc.id.replace(/^magpie_/, "").toLowerCase(),
          acc.label.replace(/^magpie_/, "").toLowerCase(),
        ];
        for (const key of candidateKeys) {
          const hit = indexMap.get(key);
          if (hit) {
            email = hit;
            break;
          }
        }
      }
      if (!email) {
        email = readEmailFromAgyDir(acc.homeDir);
      }
      if (!email) {
        email = await readEmailFromOAuthToken(acc.homeDir, acc.proxyUrl);
      }

      if (email && (email !== acc.email || email !== acc.label)) {
        store.upsertAccount({
          ...acc,
          modelAccessRule: undefined,
          email,
          label: email,
          updatedAt: Date.now(),
        });
        updated++;
      }
    }

    if (updated > 0) {
      this.emitAccounts();
    }
    return updated;
  }

  /**
   * 批量导入 Google OAuth refresh_token，换取 access_token 与邮箱后写入隔离目录
   */
  async importTokens(
    tokens: string[],
    opts?: { proxyUrl?: string }
  ): Promise<ImportRefreshTokensResult> {
    const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
    return this.importRefreshTokens(cleaned.join("\n"), opts);
  }

  async importRefreshTokens(
    rawText: string,
    opts?: { proxyUrl?: string }
  ): Promise<ImportRefreshTokensResult> {
    const tokens = parseRefreshTokens(rawText);
    if (tokens.length === 0) {
      return { imported: 0, updated: 0, failed: 0, results: [] };
    }

    const proxy = resolveOutboundProxy(opts?.proxyUrl);

    let imported = 0;
    let updated = 0;
    let failed = 0;
    const results: ImportTokenItemResult[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const refreshToken = tokens[i]!;
      const index = i + 1;

      try {
        const tokenFetchInit: RequestInit & { proxy?: string } = {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        };
        if (proxy) tokenFetchInit.proxy = proxy;

        const tokenResp = await fetch(GOOGLE_TOKEN_URL, tokenFetchInit);
        const tokenJson = (await tokenResp.json().catch(() => ({}))) as Record<string, unknown>;
        if (!tokenResp.ok || typeof tokenJson.access_token !== "string") {
          const errDesc =
            typeof tokenJson.error_description === "string"
              ? tokenJson.error_description
              : typeof tokenJson.error === "string"
                ? tokenJson.error
                : `HTTP ${tokenResp.status}`;
          failed++;
          results.push({
            index,
            email: "",
            id: "",
            action: "failed",
            ok: false,
            error: `Token exchange failed: ${errDesc}`,
          });
          continue;
        }

        const accessToken = tokenJson.access_token;
        const expiresIn =
          typeof tokenJson.expires_in === "number" && Number.isFinite(tokenJson.expires_in)
            ? tokenJson.expires_in
            : 3600;

        // 顺带真实探测账号等级（失败不阻断导入，保留原值）
        const detectedTier = await detectAccountTier(accessToken, proxy);

        const userFetchInit: RequestInit & { proxy?: string } = {
          headers: { Authorization: `Bearer ${accessToken}` },
        };
        if (proxy) userFetchInit.proxy = proxy;

        let email = "";
        const userResp = await fetch(GOOGLE_USERINFO_URL, userFetchInit);
        if (userResp.ok) {
          const userJson = (await userResp.json().catch(() => ({}))) as Record<string, unknown>;
          if (typeof userJson.email === "string") {
            email = userJson.email.trim();
          }
        }

        const existing = email
          ? store
              .listAccounts()
              .find((a) => a.email && a.email.toLowerCase() === email.toLowerCase())
          : undefined;

        if (existing) {
          ensureIsolatedHomeStructure(existing.homeDir);
          writeIsolatedAgyOAuthToken(existing.homeDir, {
            accessToken,
            refreshToken,
            expiresIn,
          });
          const now = Date.now();
          store.upsertAccount({
            ...existing,
            modelAccessRule: undefined,
            ...(detectedTier ? { tier: detectedTier } : {}),
            status: "ready",
            statusReason: "",
            lastVerifiedAt: now,
            updatedAt: now,
          });
          if (store.deleteCooldown(existing.id, "*", "global")) {
            eventBus.emit("cooldowns", store.listCooldowns(now));
          }
          updated++;
          results.push({
            index,
            email: existing.email || email,
            id: existing.id,
            action: "updated",
            ok: true,
          });
        } else {
          const id = `rt_${randomUUID().slice(0, 8)}`;
          const homeDir = path.join(getAccountsBaseDir(), id);
          ensureIsolatedHomeStructure(homeDir);
          writeIsolatedAgyOAuthToken(homeDir, {
            accessToken,
            refreshToken,
            expiresIn,
          });
          const acc = this.createAccount({
            id,
            label: email || id,
            email,
            source: "refresh-token",
            homeDir,
            proxyUrl: opts?.proxyUrl?.trim() || "",
            status: "ready",
            tier: detectedTier ?? undefined,
          });
          store.upsertAccount({
            ...acc,
            lastVerifiedAt: Date.now(),
          });
          imported++;
          results.push({
            index,
            email: acc.email,
            id: acc.id,
            action: "imported",
            ok: true,
          });
        }
      } catch (err) {
        failed++;
        results.push({
          index,
          email: "",
          id: "",
          action: "failed",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.emitAccounts();
    return { imported, updated, failed, results };
  }

  /**
   * 拉起 Chrome 完成单账号 OAuth 授权，换取并写入 Token 后更新状态为 ready
   */
  async triggerCliLogin(accountId: string): Promise<{ ok: boolean; message: string }> {
    const acc = store.getAccount(accountId);
    if (!acc) {
      return { ok: false, message: `Account '${accountId}' not found` };
    }

    const cfg = getConfig();
    const proxyUrl = resolveEffectiveProxy(acc.proxyUrl, cfg);

    try {
      const { refreshToken } = await authorizeSingleAccountOAuth({
        email: acc.email,
        proxyUrl,
      });
      const tokens = await exchangeOAuthRefreshToken(refreshToken, proxyUrl);
      writeIsolatedAgyOAuthToken(acc.homeDir, tokens);

      const now = Date.now();
      store.upsertAccount({
        ...acc,
        modelAccessRule: undefined,
        status: "ready",
        statusReason: "",
        lastVerifiedAt: now,
        updatedAt: now,
      });
      const deleted = store.deleteCooldown(acc.id, "*", "global");
      if (deleted) {
        eventBus.emit("cooldowns", store.listCooldowns(now));
      }
      this.emitAccounts();
      return { ok: true, message: "Chrome OAuth login succeeded" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.setAccountStatus(accountId, "auth_required", reason);
      return { ok: false, message: reason };
    }
  }

  /**
   * 刷新探测账号出口 IP 及真实可用性（OAuth 刷新 + agy.exe 轻量 ping 核对）
   */
  refreshAccount(accountId: string): Promise<AccountRecord | null> {
    return withAccountAuthLock(accountId, async (queue) => {
      const probeStartedAt = Date.now();
      const cooldownProbe: CooldownProbe = { before: findGlobalCooldown(accountId, probeStartedAt), rewritten: false };
      activeCooldownProbes.set(accountId, cooldownProbe);
      try {
        return await this.refreshAccountNow(accountId, queue, probeStartedAt, cooldownProbe);
      } finally {
        activeCooldownProbes.delete(accountId);
      }
    });
  }

  private async refreshAccountNow(
    accountId: string,
    queue: AccountAuthQueue,
    probeStartedAt: number,
    cooldownProbe: CooldownProbe,
  ): Promise<AccountRecord | null> {
    const acc = store.getAccount(accountId);
    if (!acc) return null;

    const cfg = getConfig();
    const proxy = resolveEffectiveProxy(acc.proxyUrl, cfg) ?? resolveOutboundProxy();
    if (proxy && cfg.strictProxyBinding) {
      const reach = await checkProxyReachable(proxy);
      if (!reach.ok) {
        throw new Error(`Proxy unreachable (strictProxyBinding=true): ${reach.error ?? proxy}`);
      }
    }

    const probe = await (acpProbeDeps.probeExit ?? probeAccountExit)(proxy, 4000);
    const probeOk = probe.probeOk ?? Boolean(probe.exitIp?.trim());
    if (!probeOk) {
      console.warn(
        `[exit-probe] exit IP probe failed for account=${acc.id}: ${probe.error ?? "empty exit IP"}`,
      );
    }

    const drift = probeOk
      ? detectExitIpDrift(
          { exitIp: acc.exitIp, exitCountry: acc.exitCountry },
          { exitIp: probe.exitIp, exitCountry: probe.exitCountry },
        )
      : null;
    if (drift?.drifted) {
      console.warn(
        `[risk-control] exit IP drift detected for account=${acc.id}: ${drift.previousExitIp} -> ${drift.currentExitIp}`,
      );
    }

    const exitProbedAt = Date.now();
    const saveResult = (
      status: AccountStatus,
      statusReason: string,
      detectedTier?: AccountTier | null,
      quotaSnapshot?: AccountQuotaSnapshot | null,
      preserveExitBaseline = false,
      probeSucceeded = false,
    ): AccountRecord | null => {
      const latest = store.getAccount(accountId);
      if (!latest || latest.homeDir !== acc.homeDir) return null;

      const preservedDisabled = latest.status === "disabled";
      const effectiveStatus: AccountStatus = preservedDisabled ? "disabled" : status;
      const rawReason = preservedDisabled ? latest.statusReason : statusReason;
      const effectiveReason =
        !probeOk && effectiveStatus === "ready" && !rawReason
          ? `Exit IP probe failed (keeping cached IP): ${probe.error ?? "unknown"}`
          : rawReason;
      const shouldUpdateExit = probeOk && !preserveExitBaseline;

      const previousQuota = latest.quota;
      const keepPreviousQuota =
        Boolean(quotaSnapshot?.error) &&
        Boolean(previousQuota) &&
        Object.values(previousQuota!.pools).some(Boolean);
      const nextQuota =
        quotaSnapshot === undefined
          ? undefined
          : keepPreviousQuota
            ? { ...previousQuota!, error: quotaSnapshot!.error }
            : quotaSnapshot;

      const updated: AccountRecord = {
        ...latest,
        ...(detectedTier ? { tier: detectedTier } : {}),
        ...(nextQuota !== undefined ? { quota: nextQuota } : {}),
        exitIp: shouldUpdateExit ? probe.exitIp : latest.exitIp,
        exitCountry: shouldUpdateExit ? (probe.exitCountry || latest.exitCountry) : latest.exitCountry,
        status: effectiveStatus,
        statusReason: effectiveReason,
        lastVerifiedAt: shouldUpdateExit ? exitProbedAt : latest.lastVerifiedAt,
        updatedAt: Date.now(),
      };
      store.upsertAccount(updated);
      const before = cooldownProbe.before;
      if (probeSucceeded && effectiveStatus === "ready" && before && !cooldownProbe.rewritten) {
        const current = findGlobalCooldown(latest.id, probeStartedAt);
        if (current && current.untilMs === before.untilMs && current.reason === before.reason &&
            current.consecutiveFailures === before.consecutiveFailures && current.lastError === before.lastError &&
            store.deleteCooldown(latest.id, "*", "global")) {
          eventBus.emit("cooldowns", store.listCooldowns());
        }
      }
      this.emitAccounts();
      return updated;
    };

    if (acc.status === "disabled") {
      return saveResult("disabled", acc.statusReason);
    }

    if (drift?.drifted && cfg.blockOnExitIpDrift) {
      return saveResult("restricted", drift.reason!, undefined, undefined, true);
    }

    // 1. 检查 OAuth token 文件是否存在且含 refresh_token
    const refreshToken = readOAuthRefreshToken(acc.homeDir);
    if (!refreshToken) {
      return saveResult("auth_required", "Missing OAuth token");
    }

    // 2. 尝试用 refresh_token 刷新 access_token
    let detectedTier: AccountTier | null = null;
    let quotaSnapshot: AccountQuotaSnapshot | undefined;
    try {
      const tokens = await renewAccountOAuth(queue, acc, refreshToken, proxy);
      if (!tokens) return null;

      // 拿到新 access_token 后顺带真实探测账号等级（仅在显式开启遗留直连开关时才拉取内部配额接口）
      detectedTier = await detectAccountTier(tokens.accessToken, proxy);
      if (isLegacyDirectQuotaEnabled()) {
        try {
          const quotaRes = await fetchAccountQuota({
            accessToken: tokens.accessToken,
            proxyUrl: proxy,
            projectId: acc.quota?.projectId,
          });
          quotaSnapshot = quotaRes.snapshot;
          if (!detectedTier && quotaRes.detectedTier) {
            detectedTier = quotaRes.detectedTier;
          }
          if (quotaRes.restriction) {
            return saveResult(
              "restricted",
              formatQuotaRestrictionReason(quotaRes.restriction),
              detectedTier,
              quotaSnapshot
            );
          }
        } catch (quotaErr) {
          quotaSnapshot = {
            fetchedAt: Date.now(),
            ...(acc.quota?.projectId ? { projectId: acc.quota.projectId } : {}),
            pools: { gemini_flagship: null, gemini_flash: null, third_party: null },
            error: quotaErr instanceof Error ? quotaErr.message : String(quotaErr),
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof OAuthRefreshError && err.kind === "permanent") {
        return saveResult("auth_required", msg.slice(0, 200));
      }
      const latest = store.getAccount(accountId);
      if (!latest || latest.homeDir !== acc.homeDir) return null;
      const code = err instanceof OAuthRefreshError && err.kind === "transient"
        ? "OAUTH_REFRESH_TRANSIENT"
        : "OAUTH_REFRESH_ERROR";
      return { ...latest, statusReason: `${code}: ${msg}`.slice(0, 200) };
    }

    // 3. 使用 agy.exe (AcpConnection) 做真实连接与极短 prompt 核对
    let conn: AcpProbeConnectionLike | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const binaryPath = resolveAgyBinary(getConfig().agyPath);
      const cwd = getDataRoot();
      const args = buildAgyWorkerArgs({
        homeDir: acc.homeDir,
        workspaceDir: cwd,
      });
      const env = buildIsolatedAgyEnv({
        homeDir: acc.homeDir,
        proxyUrl: proxy,
        agyPath: binaryPath,
      });

      let rejectProbeUpdate: ((err: Error) => void) | null = null;
      const updateErrorPromise = new Promise<never>((_, reject) => {
        rejectProbeUpdate = reject;
      });
      updateErrorPromise.catch(() => {});

      const createConn =
        acpProbeDeps.createConnection ?? ((opts) => new AcpConnection(opts));
      conn = createConn({
        binaryPath,
        args,
        cwd,
        env,
        onUpdate: (params) => {
          const update = (params.update ?? params) as Record<string, unknown>;
          const sessionUpdate =
            typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
          if (sessionUpdate === "error") {
            const msg =
              typeof update.message === "string"
                ? update.message
                : JSON.stringify(update);
            rejectProbeUpdate?.(new Error(msg));
            return;
          }
          if (sessionUpdate === "agent_message_chunk") {
            const content = update.content as Record<string, unknown> | undefined;
            const text = typeof content?.text === "string" ? content.text : "";
            if (
              text &&
              /^\s*⚠\s+/.test(text) &&
              classifyAcpProbeError(text, "ready").status !== "ready"
            ) {
              rejectProbeUpdate?.(new Error(text));
            }
          }
        },
        onExit: () => {},
      });

      const timeoutMs = acpProbeDeps.timeoutMs ?? ACP_PROBE_TIMEOUT_MS;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error("agy.exe probe timeout (50s)")),
          timeoutMs
        );
      });

      await Promise.race([
        (async () => {
          await conn!.initialize();
          const session = await conn!.request<{ sessionId: string }>("session/new", {
            cwd,
            mcpServers: [],
          });
          await conn!
            .request("session/set_model", {
              sessionId: session.sessionId,
              modelId: "gemini-3.8-flash-low",
            })
            .catch(() => {});
          await conn!.request("session/prompt", {
            sessionId: session.sessionId,
            model: "gemini-3.8-flash-low",
            prompt: [{ type: "text", text: "ping" }],
          });
        })(),
        timeoutPromise,
        updateErrorPromise,
      ]);

      return saveResult("ready", "", detectedTier, quotaSnapshot, false, true);
    } catch (err) {
      const classified = classifyAcpProbeError(err, acc.status);
      return saveResult(classified.status, classified.reason, detectedTier, quotaSnapshot);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      conn?.close();
    }
  }

  /**
   * 为所有就绪/已有 OAuth token 的账号并发刷新 access_token 并真实探测等级。
   * 探测失败或网络异常时不覆盖原 tier，逐账号汇总结果；
   * 缺失本地 OAuth token 或 OAuth 明确鉴权失效时同步标为 auth_required。
   */
  async detectAllAccountTiers(opts?: { concurrency?: number }): Promise<DetectAllTiersResult> {
    const cfg = getConfig();
    const accounts = store.listAccounts();
    const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 4, 16));
    const details: DetectTierDetail[] = [];
    let updated = 0;
    let statusChanged = false;
    let pro = 0;
    let standard = 0;
    let failed = 0;
    let cursor = 0;

    const markAuthRequired = (acc: AccountRecord, statusReason: string): void => {
      const latest = store.getAccount(acc.id);
      if (!latest || latest.homeDir !== acc.homeDir || latest.status === "disabled") return;
      store.upsertAccount({
        ...latest,
        status: "auth_required",
        statusReason: statusReason.slice(0, 200),
        updatedAt: Date.now(),
      });
      statusChanged = true;
    };

    const runOne = (accountId: string): Promise<void> => withAccountAuthLock(accountId, async (queue) => {
      const acc = store.getAccount(accountId);
      if (!acc) return;
      if (acc.status === "disabled") {
        details.push({
          id: acc.id,
          label: acc.label,
          email: acc.email,
          ok: false,
          tier: acc.tier,
          reason: "disabled, skipped",
        });
        failed++;
        return;
      }

      const refreshToken = readOAuthRefreshToken(acc.homeDir);
      if (!refreshToken) {
        markAuthRequired(acc, "Missing OAuth token, please re-login");
        details.push({
          id: acc.id,
          label: acc.label,
          email: acc.email,
          ok: false,
          tier: acc.tier,
          reason: "missing OAuth token",
        });
        failed++;
        return;
      }

      const proxy = resolveEffectiveProxy(acc.proxyUrl, cfg) ?? resolveOutboundProxy();
      try {
        const tokens = await renewAccountOAuth(queue, acc, refreshToken, proxy);
        if (!tokens) return;
        const detectedTier = await detectAccountTier(tokens.accessToken, proxy);
        if (!detectedTier) {
          details.push({
            id: acc.id,
            label: acc.label,
            email: acc.email,
            ok: false,
            tier: acc.tier,
            reason: "tier detect unavailable",
          });
          failed++;
          return;
        }

        const latest = store.getAccount(acc.id);
        if (!latest || latest.homeDir !== acc.homeDir) return;
        store.upsertAccount({ ...latest, tier: detectedTier, updatedAt: Date.now() });
        updated++;
        if (detectedTier === "pro") pro++;
        else standard++;
        details.push({
          id: acc.id,
          label: acc.label,
          email: acc.email,
          ok: true,
          tier: detectedTier,
        });
      } catch (err) {
        if (err instanceof OAuthRefreshError && err.kind === "permanent") {
          markAuthRequired(acc, `${err.message}; please re-login`);
        }
        details.push({
          id: acc.id,
          label: acc.label,
          email: acc.email,
          ok: false,
          tier: acc.tier,
          reason: err instanceof Error ? err.message : String(err),
        });
        failed++;
      }
    });

    const workerCount = Math.min(concurrency, accounts.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < accounts.length) {
          const acc = accounts[cursor++];
          if (!acc) break;
          await runOne(acc.id);
        }
      })
    );

    if (updated > 0 || statusChanged) this.emitAccounts();
    return { total: accounts.length, updated, pro, standard, failed, details };
  }

  /** 单点和批量刷新共用并发上限，同一账号复用进行中的请求。 */
  refreshAccountQuota(accountId: string): Promise<AccountRecord | null> {
    const existing = this.quotaJobs.get(accountId);
    if (existing) return existing;
    const job = this.withQuotaSlot(
      (holdSlotUntil) => withAccountAuthLock(accountId, (queue) =>
        this.refreshAccountQuotaNow(accountId, queue, holdSlotUntil)),
      () => { this.quotaJobs.delete(accountId); },
    );
    this.quotaJobs.set(accountId, job);
    return job;
  }

  private async withQuotaSlot<T>(
    work: (holdSlotUntil: (completion: Promise<unknown>) => void) => Promise<T>,
    onRelease: () => void,
  ): Promise<T> {
    if (activeQuotaJobs >= MAX_QUOTA_CONCURRENCY) {
      await new Promise<void>((resolve) => quotaWaiters.push(resolve));
    } else {
      activeQuotaJobs++;
    }
    const release = () => {
      onRelease();
      const next = quotaWaiters.shift();
      if (next) next(); // 直接移交并发槽位，避免新任务插队。
      else activeQuotaJobs--;
    };
    let backgroundCompletion: Promise<unknown> | undefined;
    try {
      return await work((completion) => {
        backgroundCompletion = completion.catch((err) => {
          console.error("[quota] Background usage check failed:", err);
        });
      });
    } finally {
      if (backgroundCompletion) void backgroundCompletion.then(release);
      else release();
    }
  }

  private async refreshAccountQuotaNow(
    accountId: string,
    queue: AccountAuthQueue,
    holdSlotUntil: (completion: Promise<unknown>) => void,
  ): Promise<AccountRecord | null> {
    const acc = store.getAccount(accountId);
    if (!acc) return null;

    const cfg = getConfig();
    const proxy = resolveEffectiveProxy(acc.proxyUrl, cfg) ?? resolveOutboundProxy();
    const emptyPools = {
      gemini_flagship: null,
      gemini_flash: null,
      third_party: null,
    };

    const persistQuota = (
      snapshot: AccountQuotaSnapshot,
      detectedTier?: AccountTier | null,
      restriction?: Quota403Restriction
    ): AccountRecord | null => {
      const latest = store.getAccount(accountId);
      if (!latest || latest.homeDir !== acc.homeDir) return null;
      const previous = latest.quota;
      const keepPrevious = !!snapshot.error && previous && Object.values(previous.pools).some(Boolean);
      const restrictionUpdate =
        restriction && latest.status !== "disabled"
          ? {
              status: "restricted" as const,
              statusReason: formatQuotaRestrictionReason(restriction),
            }
          : {};
      const updated: AccountRecord = {
        ...latest,
        ...(detectedTier ? { tier: detectedTier } : {}),
        ...restrictionUpdate,
        quota: keepPrevious ? { ...previous, error: snapshot.error } : snapshot,
        updatedAt: Date.now(),
      };
      store.upsertAccount(updated);
      if (!this.bulkQuotaJob) this.emitAccounts();
      return updated;
    };

    const projectId = acc.quota?.projectId;
    const failure = (message: string) => persistQuota({
      fetchedAt: Date.now(),
      ...(projectId ? { projectId } : {}),
      pools: emptyPools,
      error: message.slice(0, 200),
    });
    const credentials = readOAuthCredentials(acc.homeDir);

    if (!isLegacyDirectQuotaEnabled()) {
      const reader = testUsageReader ?? this.usageReaderOverride ?? this.defaultUsageReader;
      const runUsage = (creds: ReturnType<typeof readOAuthCredentials>) =>
        reader.readUsage({
          accountId: acc.id,
          homeDir: acc.homeDir,
          proxyUrl: proxy,
          projectId,
          strictProxyBinding: cfg.strictProxyBinding,
          agyPath: cfg.agyPath,
          credentials: creds,
        });
      let usageResult = await runUsage(credentials);
      if (usageResult.status === "DUE_FOR_RENEWAL" && credentials?.refreshToken) {
        try {
          const tokens = await renewAccountOAuth(queue, acc, credentials.refreshToken, proxy);
          if (!tokens) return null;
          const renewed = readOAuthCredentials(acc.homeDir) ?? {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || credentials.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
          };
          usageResult = await runUsage(renewed);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return failure(`OAuth renewal failed before usage check: ${message}`);
        }
      }
      if (usageResult.status === "ok" && usageResult.snapshot) {
        const latestBeforeSave = store.getAccount(accountId);
        const merged = mergeUsageSnapshotWithPreviousModels(latestBeforeSave?.quota, usageResult.snapshot);
        return persistQuota(merged);
      }
      if (usageResult.status === "STILL_READING") {
        if (usageResult.backgroundCompletion) holdSlotUntil(usageResult.backgroundCompletion);
        return failure(usageResult.message ?? "STILL_READING: usage check continuing in background");
      }
      if (usageResult.status === "DUE_FOR_RENEWAL") {
        return failure(
          usageResult.message ?? "DUE_FOR_RENEWAL: access token expired or expiring within 2 minutes"
        );
      }
      return failure(usageResult.error ?? "Usage check failed");
    }

    if (!credentials) return failure("Missing OAuth token");

    const { refreshToken, expiresAt } = credentials;
    const canUseAccessToken = credentials.accessToken && (
      expiresAt === null ? !refreshToken : expiresAt > Date.now() + (refreshToken ? ACCESS_TOKEN_EXPIRY_BUFFER_MS : 0)
    );
    const fetchQuota = (accessToken: string) => fetchAccountQuota({ accessToken, proxyUrl: proxy, projectId });

    let result: Awaited<ReturnType<typeof fetchQuota>>;
    try {
      if (canUseAccessToken) {
        result = await fetchQuota(credentials.accessToken);
        if (!result.accessTokenRejected || !refreshToken) {
          return persistQuota(result.snapshot, result.detectedTier, result.restriction);
        }
      }
      if (!refreshToken) return failure("Missing or expired OAuth access token");

      const tokens = await renewAccountOAuth(queue, acc, refreshToken, proxy);
      if (!tokens) return null;
      result = await fetchQuota(tokens.accessToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(message);
    }
    return persistQuota(result.snapshot, result.detectedTier, result.restriction);
  }

  /**
   * 并发刷新所有未禁用账号的三号池配额。
   */
  refreshAllQuotas(opts?: { concurrency?: number }) {
    if (this.bulkQuotaJob) return this.bulkQuotaJob;
    const job = Promise.resolve()
      .then(() => this.refreshAllQuotasNow(opts?.concurrency))
      .finally(() => { this.bulkQuotaJob = undefined; });
    this.bulkQuotaJob = job;
    return job;
  }

  private async refreshAllQuotasNow(requestedConcurrency = MAX_QUOTA_CONCURRENCY) {
    const targets = store.listAccounts().filter((account) => account.status !== "disabled");
    const concurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(Math.trunc(requestedConcurrency), MAX_QUOTA_CONCURRENCY))
      : MAX_QUOTA_CONCURRENCY;
    let refreshed = 0;
    let failed = 0;
    let cursor = 0;

    const workerCount = Math.min(concurrency, targets.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < targets.length) {
          const acc = targets[cursor++];
          try {
            const updated = await this.refreshAccountQuota(acc.id);
            if (updated?.quota && !updated.quota.error) refreshed++;
            else failed++;
          } catch {
            failed++;
          }
        }
      })
    );

    const accounts = store.listAccounts();
    eventBus.emit("accounts", accounts);
    return { refreshed, failed, accounts };
  }

  private emitAccounts(): void {
    eventBus.emit("accounts", store.listAccounts());
  }
}

export const accountManager = new AccountManager();
