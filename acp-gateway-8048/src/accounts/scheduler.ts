import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/settings";
import { store, type GatewayStore } from "../db/store";
import { eventBus } from "../logs/events";
import type { AccountRecord, CooldownRecord, RoutingStrategy } from "../types";

export const CACHE_WORTH_TOKENS = 1024;
export const HEAVY_COLD_PROMPT_TOKENS = 16000;
export const CACHE_COLD_MS = 5 * 60 * 1000;
export const STICKY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STICKY_ENTRIES = 4096;
const CACHE_SETTLING_TTL_MS = 60_000;
const MAX_CACHE_SETTLING_ENTRIES = 4096;
const WORKER_SPAWN_WINDOW_MS = 60_000;
const ACCOUNT_QUOTA_BACKOFF_DEFAULT_MS = 30_000;
const ACCOUNT_QUOTA_BACKOFF_MAX_MS = 60_000;

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" && reason ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** 读账号隔离目录里 OAuth access token 的到期时间；读不到返回 null（无法判断）。 */
function readAccessTokenExpiryMs(homeDir: string): number | null {
  if (!homeDir) return null;
  const candidates = [
    path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(homeDir, "antigravity-oauth-token"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: { expiry?: unknown } };
      const expiry = parsed?.token?.expiry;
      if (typeof expiry === "string") {
        const ms = Date.parse(expiry);
        if (Number.isFinite(ms)) return ms;
      }
    } catch {
      // 换下一个候选路径
    }
  }
  return null;
}

/** 判断是否为拥有 gemini_flagship 配额桶的非特价完整 Pro 账号。 */
export function isFullProAccount(account: AccountRecord): boolean {
  if (account.tier !== "pro") return false;
  const flagship = account.quota?.pools?.gemini_flagship;
  return flagship !== null && flagship !== undefined && typeof flagship === "object" && !Array.isArray(flagship);
}

export interface StickyEntry {
  accountId: string;
  lastUsedAt: number;
  cachedTokens: number;
  cacheWrittenAt: number;
}

export interface SuccessUsageOptions {
  inputTokens?: number;
  cachedTokens?: number;
}

export type ModelFamily =
  | "gemini-4-argon"
  | "gemini-4-hydrogen"
  | "gemini-4-carbon"
  | "gemini-3.8-flash"
  | "gemini-3-pro"
  | "gemini-3-flash"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "claude"
  | "gpt-oss-120b"
  | "other";

export function normalizeModelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gpt-oss-120b") || m.includes("gpt-oss")) return "gpt-oss-120b";
  if (m.includes("gemini-4-argon")) return "gemini-4-argon";
  if (m.includes("gemini-4-hydrogen")) return "gemini-4-hydrogen";
  if (m.includes("gemini-4-carbon")) return "gemini-4-carbon";
  if (m.includes("gemini-3.8-flash")) return "gemini-3.8-flash";
  if (m.includes("gemini-3") || m.includes("gemini3")) {
    return m.includes("flash") ? "gemini-3-flash" : "gemini-3-pro";
  }
  if (m.includes("gemini-2.5") || m.includes("gemini2.5")) {
    return m.includes("flash") ? "gemini-2.5-flash" : "gemini-2.5-pro";
  }
  return "other";
}

export class AllAccountsCooldownError extends Error {
  public readonly retryAfterSeconds: number;
  public readonly family: ModelFamily;

  constructor(family: ModelFamily, retryAfterSeconds: number) {
    super(
      `All accounts are in cooldown for family '${family}'. Retry after ${retryAfterSeconds}s.`,
    );
    this.name = "AllAccountsCooldownError";
    this.family = family;
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export class NoReadyAccountsError extends Error {
  constructor(message = "No ready accounts available in pool") {
    super(message);
    this.name = "NoReadyAccountsError";
  }
}

export class AccountQueueTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for an available account slot');
    this.name = 'AccountQueueTimeoutError';
  }
}

export interface FailureRecordOptions {
  reasonCode?: string;
  upstreamStatus?: number;
  retryAfterMs?: number;
  rawError?: string;
}

export interface AccountSchedulerOptions {
  dbStore?: GatewayStore;
  getActiveCount?: (accountId: string) => number;
  now?: () => number;
  random?: () => number;
}

export interface AccountLeaseResult {
  account: AccountRecord;
  release: () => void;
  onWorkerAcquired: () => void;
}

export class AccountScheduler {
  private readonly stickyBindings = new Map<string, StickyEntry>();
  private readonly heavyColdCompletedAt = new Map<string, number>();
  private readonly activeLeases = new Map<string, Map<symbol, "pending" | "acquired">>();
  private readonly waiters = new Set<() => void>();
  private readonly lastAccountDispatchAt = new Map<string, number>();
  private readonly lastExitIpDispatchAt = new Map<string, number>();
  private readonly workerSpawnTimestamps = new Map<string, number[]>();
  private readonly dbStore: GatewayStore;
  private readonly getActiveCount?: (accountId: string) => number;
  private readonly nowFn: () => number;
  private readonly randomFn: () => number;
  private roundRobinCursor = 0;

  constructor(
    dbStoreOrOptions: GatewayStore | AccountSchedulerOptions = store,
    options?: Omit<AccountSchedulerOptions, "dbStore"> & {
      now?: () => number;
      random?: () => number;
    },
  ) {
    if (
      dbStoreOrOptions &&
      typeof (dbStoreOrOptions as GatewayStore).listAccounts === "function"
    ) {
      this.dbStore = dbStoreOrOptions as GatewayStore;
      this.getActiveCount = options?.getActiveCount;
      this.nowFn = options?.now ?? (() => Date.now());
      this.randomFn = options?.random ?? (() => Math.random());
    } else {
      const opts = (dbStoreOrOptions ?? {}) as AccountSchedulerOptions;
      this.dbStore = opts.dbStore ?? store;
      this.getActiveCount = opts.getActiveCount ?? options?.getActiveCount;
      this.nowFn = opts.now ?? options?.now ?? (() => Date.now());
      this.randomFn = opts.random ?? options?.random ?? (() => Math.random());
    }
    this.loadStickyFromStore();
  }

  private getPendingLeaseCount(accountId: string): number {
    const leases = this.activeLeases.get(accountId);
    if (!leases || leases.size === 0) return 0;
    let count = 0;
    for (const phase of leases.values()) {
      if (phase === "pending") count++;
    }
    return count;
  }

  private getAccountActiveWorkers(account: AccountRecord): number {
    if (this.getActiveCount) {
      return this.getActiveCount(account.id) + this.getPendingLeaseCount(account.id);
    }
    return account.activeWorkers + this.getReservedCount(account.id);
  }

  getReservedCount(accountId: string): number {
    return this.activeLeases.get(accountId)?.size ?? 0;
  }

  private createLease(accountId: string): { release: () => void; onWorkerAcquired: () => void } {
    const token = Symbol("account-lease");
    let leases = this.activeLeases.get(accountId);
    if (!leases) {
      leases = new Map();
      this.activeLeases.set(accountId, leases);
    }
    leases.set(token, "pending");

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = this.activeLeases.get(accountId);
      if (current) {
        current.delete(token);
        if (current.size === 0) {
          this.activeLeases.delete(accountId);
        }
      }
      this.notifyWaiters();
    };

    const onWorkerAcquired = () => {
      if (released) return;
      const current = this.activeLeases.get(accountId);
      if (current && current.has(token)) {
        current.set(token, "acquired");
      }
    };

    return { release, onWorkerAcquired };
  }

  private notifyWaiters(): void {
    if (this.waiters.size === 0) return;
    const callbacks = Array.from(this.waiters);
    this.waiters.clear();
    for (const wake of callbacks) {
      wake();
    }
  }

  private waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(1, timeoutMs));
      this.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
      if (signal?.aborted) wake();
    });
  }

  private sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(createAbortError(signal?.reason));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private pruneHeavyColdEntries(now: number): void {
    for (const [key, completedAt] of this.heavyColdCompletedAt) {
      if (now - completedAt > CACHE_SETTLING_TTL_MS) {
        this.heavyColdCompletedAt.delete(key);
      }
    }
    while (this.heavyColdCompletedAt.size >= MAX_CACHE_SETTLING_ENTRIES) {
      const oldestKey = this.heavyColdCompletedAt.keys().next().value;
      if (oldestKey === undefined) break;
      this.heavyColdCompletedAt.delete(oldestKey);
    }
  }

  async awaitCacheSettling(
    accountId: string,
    sessionHash?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const delayMs = getConfig().cacheSettlingDelayMs;
    if (!sessionHash || typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) {
      return;
    }
    const key = `${accountId}:${sessionHash}`;
    const completedAt = this.heavyColdCompletedAt.get(key);
    if (completedAt === undefined) {
      return;
    }
    const remainingMs = completedAt + delayMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    await this.sleepWithAbort(remainingMs, signal);
    console.info(
      `[scheduler] cache settling waited ${remainingMs}ms (account=${accountId}, session=${sessionHash.slice(0, 12)})`,
    );
  }

  /**
   * 单号最小请求间隔 + 同出口 IP 错峰间隔 + 随机 Jitter：
   * 仅当 accountId 或 exitIp 在窗口内刚派发过请求时才等待，首次冷请求 0 延迟。
   */
  async awaitDispatchPacing(
    accountId: string,
    exitIp?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    signal?.throwIfAborted();
    const cfg = getConfig();
    const minAccInterval = Math.max(0, cfg.minAccountRequestIntervalMs ?? 0);
    const minIpInterval = Math.max(0, cfg.minExitIpRequestIntervalMs ?? 0);
    const maxJitter = Math.max(0, cfg.requestJitterMs ?? 0);
    const ip = exitIp?.trim() || undefined;

    const now = this.nowFn();
    const prevAcc = this.lastAccountDispatchAt.get(accountId);
    const prevIp = ip ? this.lastExitIpDispatchAt.get(ip) : undefined;

    const accWait =
      minAccInterval > 0 && prevAcc !== undefined
        ? Math.max(0, prevAcc + minAccInterval - now)
        : 0;
    const ipWait =
      ip && minIpInterval > 0 && prevIp !== undefined
        ? Math.max(0, prevIp + minIpInterval - now)
        : 0;

    const baseWait = Math.max(accWait, ipWait);
    const isHotAccount =
      minAccInterval > 0 && prevAcc !== undefined && prevAcc + minAccInterval > now;
    const isHotIp = Boolean(
      ip && minIpInterval > 0 && prevIp !== undefined && prevIp + minIpInterval > now,
    );
    const shouldJitter = maxJitter > 0 && (baseWait > 0 || isHotAccount || isHotIp);
    const jitter = shouldJitter ? Math.floor(this.randomFn() * (maxJitter + 1)) : 0;
    const totalWait = baseWait + jitter;
    const plannedAt = now + totalWait;

    this.lastAccountDispatchAt.set(accountId, plannedAt);
    if (ip) {
      this.lastExitIpDispatchAt.set(ip, plannedAt);
    }

    if (totalWait > 0) {
      try {
        await this.sleepWithAbort(totalWait, signal);
      } catch (err) {
        if (this.lastAccountDispatchAt.get(accountId) === plannedAt) {
          if (prevAcc === undefined) this.lastAccountDispatchAt.delete(accountId);
          else this.lastAccountDispatchAt.set(accountId, prevAcc);
        }
        if (ip && this.lastExitIpDispatchAt.get(ip) === plannedAt) {
          if (prevIp === undefined) this.lastExitIpDispatchAt.delete(ip);
          else this.lastExitIpDispatchAt.set(ip, prevIp);
        }
        throw err;
      }
      const actualAt = this.nowFn();
      if (actualAt > plannedAt) {
        this.lastAccountDispatchAt.set(accountId, actualAt);
        if (ip) {
          this.lastExitIpDispatchAt.set(ip, actualAt);
        }
      }
    }

    return totalWait;
  }

  private pruneWorkerSpawns(accountId: string, now: number): number[] {
    const existing = this.workerSpawnTimestamps.get(accountId);
    if (!existing || existing.length === 0) return [];
    const cutoff = now - WORKER_SPAWN_WINDOW_MS;
    const kept = existing.filter((ts) => ts > cutoff);
    if (kept.length === 0) {
      this.workerSpawnTimestamps.delete(accountId);
    } else if (kept.length !== existing.length) {
      this.workerSpawnTimestamps.set(accountId, kept);
    }
    return kept;
  }

  /** 记录单号 Worker 拉起时间戳（60s 滑动窗口）。 */
  recordWorkerSpawn(accountId: string, now = this.nowFn()): void {
    const kept = this.pruneWorkerSpawns(accountId, now);
    kept.push(now);
    this.workerSpawnTimestamps.set(accountId, kept);
  }

  /** 原子判限并记账：若未超出 60s 滑动窗口上限则写入时间戳并返回 true，否则直接拒绝返回 false。 */
  tryConsumeWorkerSpawn(accountId: string, now = this.nowFn()): boolean {
    const kept = this.pruneWorkerSpawns(accountId, now);
    const limit = getConfig().maxWorkerSpawnsPerMinute ?? 0;
    if (limit > 0 && kept.length >= limit) {
      return false;
    }
    kept.push(now);
    this.workerSpawnTimestamps.set(accountId, kept);
    return true;
  }

  /** 判断单号是否触发 60s Worker 拉起频率护栏；maxWorkerSpawnsPerMinute === 0 时关闭。 */
  isWorkerSpawnRateLimited(accountId: string, now = this.nowFn()): boolean {
    const limit = getConfig().maxWorkerSpawnsPerMinute ?? 0;
    if (limit <= 0) return false;
    const kept = this.pruneWorkerSpawns(accountId, now);
    return kept.length >= limit;
  }

  private buildExitIpConcurrencyMap(accounts: AccountRecord[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const a of accounts) {
      const ip = a.exitIp?.trim();
      if (!ip) continue;
      const active = this.getAccountActiveWorkers(a);
      if (active > 0) {
        map.set(ip, (map.get(ip) ?? 0) + active);
      }
    }
    return map;
  }

  private hasExitIpSlot(
    account: AccountRecord,
    maxPerExitIp: number,
    exitIpConcurrency: Map<string, number>,
  ): boolean {
    if (maxPerExitIp <= 0) return true;
    const ip = account.exitIp?.trim();
    if (!ip) return true;
    return (exitIpConcurrency.get(ip) ?? 0) < maxPerExitIp;
  }

  /**
   * 槽位释放时立即唤醒所有等待中的 acquireAccount 协程重新抢占
   */
  releaseSlot(_accountId?: string): void {
    this.notifyWaiters();
  }

  /**
   * 清除指定账号的冷却记录并立即唤醒等待者
   */
  clearCooldown(
    accountId: string,
    model: string,
    scopeType: "family" | "global" = "family",
  ): boolean {
    const now = Date.now();
    const family = scopeType === "global" ? "*" : normalizeModelFamily(model);
    const deleted = this.dbStore.deleteCooldown(accountId, family, scopeType);
    if (deleted) {
      eventBus.emit("cooldowns", this.dbStore.listCooldowns(now));
      this.notifyWaiters();
    }
    return deleted;
  }

  private loadStickyFromStore(): void {
    const records = this.dbStore.loadStickyAffinities(STICKY_MAX_AGE_MS, MAX_STICKY_ENTRIES);
    // Insert oldest-first so Map iteration order is LRU -> MRU
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      this.stickyBindings.set(r.stickyKey, {
        accountId: r.accountId,
        lastUsedAt: r.lastUsedAt,
        cachedTokens: r.cachedTokens,
        cacheWrittenAt: r.cacheWrittenAt,
      });
    }
  }

  private setStickyEntry(sessionKey: string, entry: StickyEntry): void {
    if (!this.stickyBindings.has(sessionKey) && this.stickyBindings.size >= MAX_STICKY_ENTRIES) {
      const oldestKey = this.stickyBindings.keys().next().value;
      if (oldestKey !== undefined) {
        this.stickyBindings.delete(oldestKey);
        this.dbStore.deleteStickyAffinity(oldestKey);
      }
    }
    this.stickyBindings.delete(sessionKey);
    this.stickyBindings.set(sessionKey, entry);
    this.dbStore.upsertStickyAffinity({
      stickyKey: sessionKey,
      accountId: entry.accountId,
      lastUsedAt: entry.lastUsedAt,
      cachedTokens: entry.cachedTokens,
      cacheWrittenAt: entry.cacheWrittenAt,
    });
  }

  private touchSticky(sessionKey: string, accountId: string, now: number): void {
    const existing = this.stickyBindings.get(sessionKey);
    const entry: StickyEntry =
      existing && existing.accountId === accountId
        ? { ...existing, lastUsedAt: now }
        : { accountId, lastUsedAt: now, cachedTokens: 0, cacheWrittenAt: 0 };
    this.setStickyEntry(sessionKey, entry);
  }

  private isCacheProtected(entry: StickyEntry | undefined, now: number): boolean {
    if (!entry) return false;
    if (entry.cachedTokens > 0) return true;
    return entry.cacheWrittenAt > 0 && now - entry.cacheWrittenAt <= CACHE_COLD_MS;
  }

  getStickyEntry(sessionKey: string): StickyEntry | undefined {
    return this.stickyBindings.get(sessionKey);
  }

  abandonSession(sessionKey: string, _model?: string): void {
    if (sessionKey) {
      this.stickyBindings.delete(sessionKey);
      this.dbStore.deleteStickyAffinity(sessionKey);
    }
  }

  /**
   * 失败冷却策略：
   * - 配额/限流（429 / RESOURCE_EXHAUSTED / QUOTA_EXHAUSTED）走 cooldownStepsMinutes 递进长冷却；
   * - 非配额瞬时错误（TIMEOUT / 500 / 502 / 503 / 504 / SOFT_ERROR）仅做 10 秒短避让，不叠加长冷却阶梯；
   * - 仅当旧罚单仍在冷却期内才累加 consecutiveFailures，过期则重置为 1，避免旧罚单永久连坐；
   * - 仍在冷却期内的旧罚单不被更短的避让覆盖。
   */
  recordFailure(
    accountId: string,
    model: string,
    opts: FailureRecordOptions = {},
  ): number | undefined {
    const now = Date.now();
    const family = normalizeModelFamily(model);
    const retryAfterMs = opts.retryAfterMs;
    const hasRetryHint = typeof retryAfterMs === 'number' &&
      Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 &&
      Number.isSafeInteger(now + retryAfterMs);

    if (opts.reasonCode === "AUTH_REQUIRED" || opts.upstreamStatus === 401) {
      const acc = this.dbStore.getAccount(accountId);
      // 出口网络抖动时，agy CLI 拿不到认证态也会报同一个 Authentication required；
      // 这时账号自身的 access token 其实可能没过期。先看 token 到期时间，避免把好号整批踢下线。
      const tokenExpiryMs = acc ? readAccessTokenExpiryMs(acc.homeDir) : null;
      const tokenStillValid = tokenExpiryMs !== null && tokenExpiryMs > now + 60_000;

      if (acc && !tokenStillValid) {
        this.dbStore.upsertAccount({
          ...acc,
          status: "auth_required",
          statusReason: opts.rawError || "Authentication required",
          updatedAt: now,
        });
        eventBus.emit("accounts", this.dbStore.listAccounts());
        return;
      }

      // token 仍在有效期内：只做 5 分钟短避让，账号留在 ready 池内，网络恢复后自动回归。
      this.dbStore.upsertCooldown({
        accountId,
        family,
        scopeType: "family",
        reason: "AUTH_TRANSIENT",
        untilMs: now + 5 * 60_000,
        consecutiveFailures: 1,
        lastError: opts.rawError || "Authentication required (access token still valid)",
      });
      eventBus.emit("cooldowns", this.dbStore.listCooldowns(now));
      return;
    }

    if (opts.reasonCode === "VALIDATION_REQUIRED") {
      const acc = this.dbStore.getAccount(accountId);
      if (acc) {
        this.dbStore.upsertAccount({
          ...acc,
          status: "restricted",
          statusReason: opts.rawError || "Account verification required (10m cooldown)",
          updatedAt: now,
        });
        eventBus.emit("accounts", this.dbStore.listAccounts());
      }
      const cooldownMs = hasRetryHint ? retryAfterMs : 10 * 60_000;
      this.dbStore.upsertCooldown({
        accountId,
        family,
        scopeType: "family",
        reason: "VALIDATION_REQUIRED",
        untilMs: now + cooldownMs,
        consecutiveFailures: 1,
        lastError: opts.rawError || "Account verification required",
      });
      eventBus.emit("cooldowns", this.dbStore.listCooldowns(now));
      return;
    }

    if (opts.reasonCode === "RESTRICTED" || opts.upstreamStatus === 403) {
      const cfg = getConfig();
      const cooldownMs = cfg.policyBlockCooldownMs ?? 21_600_000;
      const untilMs = now + cooldownMs;
      const acc = this.dbStore.getAccount(accountId);
      if (acc) {
        this.dbStore.upsertAccount({
          ...acc,
          status: "restricted",
          statusReason: opts.rawError || "Account restricted / verification required",
          updatedAt: now,
        });
        eventBus.emit("accounts", this.dbStore.listAccounts());
      }
      this.dbStore.upsertCooldown({
        accountId,
        family: "*",
        scopeType: "global",
        reason: opts.reasonCode || "RESTRICTED",
        untilMs,
        consecutiveFailures: 1,
        lastError: opts.rawError || "Account restricted / verification required",
      });
      eventBus.emit("cooldowns", this.dbStore.listCooldowns(now));
      return untilMs;
    }

    const cfg = getConfig();
    const steps = cfg.cooldownStepsMinutes.length > 0 ? cfg.cooldownStepsMinutes : [1, 5, 15, 30, 60];

    // 区分「配额/限流」与「非配额瞬时错误」，避免把健康账号误杀进长冷却。
    const isQuotaError =
      opts.upstreamStatus === 429 ||
      opts.reasonCode === "RESOURCE_EXHAUSTED" ||
      opts.reasonCode === "QUOTA_EXHAUSTED";

    const existingList = this.dbStore.listCooldowns(0);
    const existing = existingList.find(
      (c) => c.accountId === accountId && c.family === family && c.scopeType === "family",
    );
    // 仅当旧罚单仍在冷却期内才累加；已过期则从头计数，避免旧罚单永久连坐。
    const stillCooling = Boolean(existing && existing.untilMs > now);

    let nextFailures: number;
    let computedDurationMs: number;
    if (isQuotaError) {
      nextFailures = stillCooling ? existing!.consecutiveFailures + 1 : 1;
      const stepIndex = Math.min(nextFailures - 1, steps.length - 1);
      computedDurationMs = hasRetryHint ? retryAfterMs : steps[stepIndex]! * 60_000;
    } else {
      // 非配额瞬时错误：默认避让 10 秒，consecutiveFailures 保持为 1。
      nextFailures = 1;
      computedDurationMs = hasRetryHint ? retryAfterMs : 10_000;
    }

    const candidateUntilMs = now + computedDurationMs;
    const finalUntilMs =
      stillCooling && existing!.untilMs > candidateUntilMs ? existing!.untilMs : candidateUntilMs;

    const record: CooldownRecord = {
      accountId,
      family,
      scopeType: "family",
      reason: opts.reasonCode || (opts.upstreamStatus === 429 ? "QUOTA_EXHAUSTED" : "SOFT_ERROR"),
      untilMs: finalUntilMs,
      consecutiveFailures: nextFailures,
      lastError: opts.rawError || "",
    };

    this.dbStore.upsertCooldown(record);
    if (isQuotaError && cfg.quotaCooldownScope === "account") {
      const accountBackoffMs = Math.min(
        hasRetryHint ? retryAfterMs! : ACCOUNT_QUOTA_BACKOFF_DEFAULT_MS,
        ACCOUNT_QUOTA_BACKOFF_MAX_MS,
      );
      if (accountBackoffMs > 0) {
        const existingGlobal = existingList.find(
          (c) => c.accountId === accountId && c.family === "*" && c.scopeType === "global",
        );
        const globalCandidateUntilMs = now + accountBackoffMs;
        const globalFinalUntilMs =
          existingGlobal && existingGlobal.untilMs > globalCandidateUntilMs
            ? existingGlobal.untilMs
            : globalCandidateUntilMs;
        this.dbStore.upsertCooldown({
          accountId,
          family: "*",
          scopeType: "global",
          reason: record.reason,
          untilMs: globalFinalUntilMs,
          consecutiveFailures: 1,
          lastError: record.lastError,
        });
      }
    }
    eventBus.emit("cooldowns", this.dbStore.listCooldowns(now));
    return isQuotaError ? finalUntilMs : undefined;
  }

  /**
   * 单次请求成功后重置连续失败计数，并记录缓存粘性热度（含首轮 cacheWorth 保护）
   */
  recordSuccess(
    accountId: string,
    model: string,
    sessionKey?: string,
    usage?: SuccessUsageOptions,
  ): void {
    const now = Date.now();
    const family = normalizeModelFamily(model);
    const deleted = this.dbStore.deleteCooldown(accountId, family, "family");
    if (deleted) {
      eventBus.emit("cooldowns", this.dbStore.listCooldowns(now));
    }

    if (sessionKey) {
      const existing = this.stickyBindings.get(sessionKey);
      const entry: StickyEntry =
        existing && existing.accountId === accountId
          ? { ...existing, lastUsedAt: now }
          : { accountId, lastUsedAt: now, cachedTokens: 0, cacheWrittenAt: 0 };

      const cached =
        typeof usage?.cachedTokens === "number" && Number.isFinite(usage.cachedTokens)
          ? Math.max(0, usage.cachedTokens)
          : 0;
      const input =
        typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens)
          ? Math.max(0, usage.inputTokens)
          : 0;

      if (cached > 0) {
        entry.cachedTokens = cached;
        entry.cacheWrittenAt = now;
      } else if (input >= CACHE_WORTH_TOKENS) {
        entry.cacheWrittenAt = now;
      }

      this.setStickyEntry(sessionKey, entry);

      const hasInputUsage = typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens);
      if (hasInputUsage) {
        const uncachedTokens = Math.max(0, input - cached);
        if (uncachedTokens >= HEAVY_COLD_PROMPT_TOKENS) {
          this.pruneHeavyColdEntries(now);
          const settlingKey = `${accountId}:${sessionKey}`;
          this.heavyColdCompletedAt.delete(settlingKey);
          this.heavyColdCompletedAt.set(settlingKey, now);
        }
      }
    }

    this.notifyWaiters();
  }

  async acquireAccount(
    model: string,
    sessionKey?: string,
    excludeAccountIds: Set<string> = new Set(),
    signal?: AbortSignal,
    options?: { reserveSlot?: boolean },
  ): Promise<AccountRecord> {
    const res = await this.acquireAccountInternal(
      model,
      sessionKey,
      excludeAccountIds,
      signal,
      options?.reserveSlot ?? false,
    );
    return res.account;
  }

  async acquireAccountLease(
    model: string,
    sessionKey?: string,
    excludeAccountIds: Set<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<AccountLeaseResult> {
    return this.acquireAccountInternal(model, sessionKey, excludeAccountIds, signal, true);
  }

  /**
   * 纯思考/空响应同号兜底专用：
   * - 必须校验账号仍为 ready；
   * - 绝不清除数据库冷却，且仅允许绕过 family 级 SOFT_ERROR 软避让，绝不绕过 429/401/403/503/global 等其他冷却；
   * - 必须走并发容量检查与排队等待，并签发请求独占、幂等的 lease closure。
   */
  async acquireFallbackAccountLease(
    accountId: string,
    model: string,
    sessionKey?: string,
    signal?: AbortSignal,
  ): Promise<AccountLeaseResult> {
    const cfg = getConfig();
    const family = normalizeModelFamily(model);
    const queueTimeout = cfg.queueWaitTimeoutMs || 60_000;
    const deadline = Date.now() + queueTimeout;

    while (true) {
      signal?.throwIfAborted();
      const now = Date.now();
      const allAccounts = this.dbStore.listAccounts();
      const account = allAccounts.find((a) => a.id === accountId && a.status === "ready");
      if (!account) {
        throw new NoReadyAccountsError(`Fallback account '${accountId}' is not ready`);
      }

      const activeCooldowns = this.dbStore.listCooldowns(now);
      let blockingUntilMs = 0;
      for (const cd of activeCooldowns) {
        if (cd.accountId !== accountId) continue;
        if (cd.family !== family && cd.family !== "*") continue;
        // 仅允许绕过本轮纯思考空响应产生的 family 级 SOFT_ERROR 软避让，绝不绕过其他任何冷却
        if (cd.family === family && cd.scopeType === "family" && cd.reason === "SOFT_ERROR") {
          continue;
        }
        if (cd.untilMs > blockingUntilMs) {
          blockingUntilMs = cd.untilMs;
        }
      }
      if (blockingUntilMs > now) {
        const retryAfterSeconds = Math.max(1, Math.ceil((blockingUntilMs - now) / 1000));
        throw new AllAccountsCooldownError(family, retryAfterSeconds);
      }

      const spawnNow = this.nowFn();
      if (this.isWorkerSpawnRateLimited(account.id, spawnNow)) {
        const timestamps = this.workerSpawnTimestamps.get(account.id) ?? [];
        const oldest = timestamps[0] ?? spawnNow;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((oldest + WORKER_SPAWN_WINDOW_MS - spawnNow) / 1000),
        );
        throw new AllAccountsCooldownError(family, retryAfterSeconds);
      }

      const exitIpConcurrency = this.buildExitIpConcurrencyMap(allAccounts);
      if (
        this.getAccountActiveWorkers(account) < account.concurrencyLimit &&
        this.hasExitIpSlot(account, cfg.maxConcurrencyPerExitIp ?? 0, exitIpConcurrency)
      ) {
        const lease = this.createLease(account.id);
        try {
          await this.awaitCacheSettling(account.id, sessionKey, signal);
          await this.awaitDispatchPacing(account.id, account.exitIp, signal);
        } catch (err) {
          lease.release();
          throw err;
        }
        return { account, ...lease };
      }

      const remainingDeadlineMs = deadline - Date.now();
      if (remainingDeadlineMs <= 0) {
        throw new AccountQueueTimeoutError();
      }
      await this.waitForChange(Math.min(100, remainingDeadlineMs), signal);
    }
  }

  private async acquireAccountInternal(
    model: string,
    sessionKey: string | undefined,
    excludeAccountIds: Set<string>,
    signal: AbortSignal | undefined,
    shouldReserve: boolean,
  ): Promise<AccountLeaseResult> {
    const cfg = getConfig();
    const family = normalizeModelFamily(model);
    const queueTimeout = cfg.queueWaitTimeoutMs || 60_000;
    const deadline = Date.now() + queueTimeout;
    const cacheWaitCapMs = Math.min(queueTimeout, 15_000);
    const cacheWaitDeadline = Date.now() + cacheWaitCapMs;

    while (true) {
      signal?.throwIfAborted();
      const now = Date.now();
      const spawnNow = this.nowFn();
      const allAccounts = this.dbStore.listAccounts();
      const readyAccounts = allAccounts.filter(
        (a) => a.status === "ready" && !excludeAccountIds.has(a.id),
      );

      if (readyAccounts.length === 0) {
        throw new NoReadyAccountsError();
      }

      const exitIpConcurrency = this.buildExitIpConcurrencyMap(allAccounts);
      const maxPerExitIp = cfg.maxConcurrencyPerExitIp ?? 0;

      const activeCooldowns = this.dbStore.listCooldowns(now);
      const cooldownMap = new Map<string, CooldownRecord>();
      for (const cd of activeCooldowns) {
        if (cd.family !== family && cd.family !== "*") continue;
        const current = cooldownMap.get(cd.accountId);
        if (!current || cd.untilMs > current.untilMs) {
          cooldownMap.set(cd.accountId, cd);
        }
      }

      const boundEntry = sessionKey ? this.stickyBindings.get(sessionKey) : undefined;
      const cacheProtected = this.isCacheProtected(boundEntry, now);

      if ((cfg.routingStrategy === "cache-first" || cacheProtected) && sessionKey) {
        const boundId = boundEntry?.accountId;
        const boundAccount =
          boundId && !excludeAccountIds.has(boundId)
            ? readyAccounts.find((a) => a.id === boundId)
            : undefined;

        if (boundAccount) {
          const boundCd = cooldownMap.get(boundAccount.id);
          const boundHasSlot =
            this.getAccountActiveWorkers(boundAccount) < boundAccount.concurrencyLimit &&
            this.hasExitIpSlot(boundAccount, maxPerExitIp, exitIpConcurrency);
          const boundRateLimited = this.isWorkerSpawnRateLimited(boundAccount.id, spawnNow);
          if (!boundCd && boundHasSlot && !boundRateLimited) {
            this.touchSticky(sessionKey, boundAccount.id, now);
            const lease = shouldReserve
              ? this.createLease(boundAccount.id)
              : { release: () => {}, onWorkerAcquired: () => {} };
            try {
              await this.awaitCacheSettling(boundAccount.id, sessionKey, signal);
              if (shouldReserve) {
                await this.awaitDispatchPacing(boundAccount.id, boundAccount.exitIp, signal);
              }
            } catch (err) {
              lease.release();
              throw err;
            }
            return { account: boundAccount, ...lease };
          }
          if (!boundRateLimited) {
            const remainingCdMs = boundCd ? boundCd.untilMs - now : 0;
            const canWaitCooldown = !boundCd || remainingCdMs <= cacheWaitCapMs;
            if (canWaitCooldown && now < cacheWaitDeadline) {
              const waitMs = Math.min(
                100,
                cacheWaitDeadline - now,
                boundCd ? remainingCdMs : Infinity,
              );
              await this.waitForChange(waitMs, signal);
              continue;
            }
          }
        }
      }

      const uncooled = readyAccounts.filter((a) => !cooldownMap.has(a.id));
      if (uncooled.length === 0) {
        let minUntil = Infinity;
        for (const a of readyAccounts) {
          const cd = cooldownMap.get(a.id);
          if (cd && cd.untilMs < minUntil) {
            minUntil = cd.untilMs;
          }
        }
        const retryAfterSeconds = Math.max(1, Math.ceil((minUntil - now) / 1000));
        throw new AllAccountsCooldownError(family, retryAfterSeconds);
      }

      const available = uncooled.filter(
        (a) =>
          this.getAccountActiveWorkers(a) < a.concurrencyLimit &&
          this.hasExitIpSlot(a, maxPerExitIp, exitIpConcurrency) &&
          !this.isWorkerSpawnRateLimited(a.id, spawnNow),
      );
      if (available.length > 0) {
        // 优先调度非特价完整 Pro 账号（含 gemini_flagship 桶），其次其他 Pro 账号，
        // 最后回退到全量可用账号（普通账号）。
        const fullProAvailable = available.filter(isFullProAccount);
        const proAvailable = available.filter((a) => a.tier === 'pro');
        const pool =
          fullProAvailable.length > 0
            ? fullProAvailable
            : proAvailable.length > 0
              ? proAvailable
              : available;
        const chosen = this.selectAccount(pool, cfg.routingStrategy, sessionKey, now);
        const lease = shouldReserve
          ? this.createLease(chosen.id)
          : { release: () => {}, onWorkerAcquired: () => {} };
        try {
          await this.awaitCacheSettling(chosen.id, sessionKey, signal);
          if (shouldReserve) {
            await this.awaitDispatchPacing(chosen.id, chosen.exitIp, signal);
          }
        } catch (err) {
          lease.release();
          throw err;
        }
        return { account: chosen, ...lease };
      }

      const remainingDeadlineMs = deadline - Date.now();
      if (remainingDeadlineMs <= 0) {
        throw new AccountQueueTimeoutError();
      }

      await this.waitForChange(Math.min(100, remainingDeadlineMs), signal);
    }
  }

  private selectAccount(
    available: AccountRecord[],
    strategy: RoutingStrategy,
    sessionKey?: string,
    now = Date.now(),
  ): AccountRecord {
    if (strategy === "fill-first") {
      return [...available].sort(
        (a, b) => this.getAccountActiveWorkers(a) - this.getAccountActiveWorkers(b),
      )[0]!;
    }

    if (strategy === "performance-first") {
      const chosen = available[this.roundRobinCursor % available.length]!;
      this.roundRobinCursor = (this.roundRobinCursor + 1) % 1_000_000;
      return chosen;
    }

    if (sessionKey) {
      const boundEntry = this.stickyBindings.get(sessionKey);
      if (boundEntry) {
        const found = available.find((a) => a.id === boundEntry.accountId);
        if (found) {
          this.touchSticky(sessionKey, found.id, now);
          return found;
        }
      }
      const hash = createHash("sha256").update(sessionKey).digest().readUInt32BE(0);
      const chosen = available[hash % available.length]!;
      this.touchSticky(sessionKey, chosen.id, now);
      return chosen;
    }

    const chosen = available[this.roundRobinCursor % available.length]!;
    this.roundRobinCursor = (this.roundRobinCursor + 1) % 1_000_000;
    return chosen;
  }
}

export const accountScheduler = new AccountScheduler();
