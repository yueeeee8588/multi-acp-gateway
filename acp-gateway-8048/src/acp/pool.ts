import { createHash } from "node:crypto";
import {
  AgySessionWorker,
  defaultTransportFactory,
  type AcpTransport,
  type AcpTransportFactory,
  type PrewarmedTransportOptions,
} from "./worker";
import { buildAgyWorkerArgs, buildIsolatedAgyEnv, getDataRoot, resolveAgyBinary } from "./env";
import { ensureMinimalAgentDefinition } from "./minimal-agent";
import { LoopbackMcpServer } from "./loopback-mcp";
import { store } from "../db/store";
import type { AccountRecord, GeminiContent, GeminiGenerateRequest } from "../types";

export interface AcpWorkerPoolOptions {
  mcpServer: LoopbackMcpServer;
  agyPath?: string;
  softErrorCutoffMs?: number;
  idleTtlMs?: number;
  cleanupIntervalMs?: number;
  transportFactory?: AcpTransportFactory;
  workspaceDir?: string;
  prewarmPerAccount?: number;
  maxPrewarmTotal?: number;
  maxConcurrentStarts?: number;
}

interface PoolEntry {
  key: string;
  accountId: string;
  sessionHash: string;
  worker: AgySessionWorker;
  inUse: boolean;
}

interface PrewarmEntry {
  accountId: string;
  homeDir: string;
  transport: AcpTransport;
  initCaps: unknown;
  createdAt: number;
  adopted: boolean;
  bindHandlers: NonNullable<PrewarmedTransportOptions["bindHandlers"]>;
}

export function computeSessionPrefixHash(model: string, contents: GeminiContent[]): string {
  const prefix = contents.slice(0, 2).map((c) => ({
    role: c.role ?? "user",
    parts: (c.parts ?? []).map((p) => ({
      text: p.text ?? "",
      hasImage: Boolean(p.inlineData),
    })),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ model, prefix }))
    .digest("hex")
    .slice(0, 16);
}

export const DEFAULT_WORKER_IDLE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_PREWARM_PER_ACCOUNT = 1;
export const DEFAULT_MAX_PREWARM_TOTAL = 9;
export const DEFAULT_MAX_CONCURRENT_STARTS = 3;

export class AcpWorkerPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly activeCounts = new Map<string, number>();
  private readonly prewarmed = new Map<string, PrewarmEntry[]>();
  private readonly prewarmInFlight = new Map<string, number>();
  private readonly mcpServer: LoopbackMcpServer;
  private readonly agyPath?: string;
  private readonly softErrorCutoffMs?: number;
  private readonly idleTtlMs: number;
  private readonly transportFactory?: AcpTransportFactory;
  private readonly workspaceDir?: string;
  private readonly prewarmPerAccount: number;
  private readonly maxPrewarmTotal: number;
  private readonly maxConcurrentStarts: number;
  private activeStarts = 0;
  private readonly startQueue: Array<() => void> = [];
  private shuttingDown = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AcpWorkerPoolOptions) {
    this.mcpServer = opts.mcpServer;
    this.agyPath = opts.agyPath;
    this.softErrorCutoffMs = opts.softErrorCutoffMs;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_WORKER_IDLE_TTL_MS;
    this.transportFactory = opts.transportFactory;
    this.workspaceDir = opts.workspaceDir;
    this.prewarmPerAccount = Math.max(0, opts.prewarmPerAccount ?? DEFAULT_PREWARM_PER_ACCOUNT);
    this.maxPrewarmTotal = Math.max(0, opts.maxPrewarmTotal ?? DEFAULT_MAX_PREWARM_TOTAL);
    this.maxConcurrentStarts = Math.max(1, opts.maxConcurrentStarts ?? DEFAULT_MAX_CONCURRENT_STARTS);

    const intervalMs = opts.cleanupIntervalMs ?? 30_000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleWorkers();
    }, intervalMs);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  getIdleTtlMs(): number {
    return this.idleTtlMs;
  }

  acquireWorker(
    account: AccountRecord,
    model: string,
    request: GeminiGenerateRequest,
    sessionKey?: string,
  ): { worker: AgySessionWorker; release: () => void } {
    const resolvedSessionKey =
      sessionKey && sessionKey.trim()
        ? sessionKey.trim()
        : computeSessionPrefixHash(model, request.contents ?? []);
    const stickyKey = `${account.id}:${model}:${resolvedSessionKey}`;

    let entry = this.entries.get(stickyKey);
    if (entry && !entry.inUse && entry.worker.canReuse(request)) {
      entry.inUse = true;
      this.syncActiveCount(account.id);
      return {
        worker: entry.worker,
        release: () => this.releaseEntry(stickyKey),
      };
    }

    // 如果已有同 key 但正在忙或不可复用，创建新 worker 替换旧空闲条目
    if (entry && !entry.inUse) {
      void entry.worker.resetAndClose();
      this.entries.delete(stickyKey);
    }

    const isPrimarySlot = !entry || !entry.inUse;
    const entryKey = isPrimarySlot
      ? stickyKey
      : `${stickyKey}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
    const persistedSession = isPrimarySlot ? store.getAcpSession(stickyKey) : undefined;
    const prewarmed = this.takePrewarmedTransport(account.id, account.homeDir);

    const worker = new AgySessionWorker({
      account,
      model,
      agyPath: this.agyPath,
      softErrorCutoffMs: this.softErrorCutoffMs,
      mcpServer: this.mcpServer,
      workspaceDir: this.workspaceDir,
      transportFactory: this.transportFactory,
      stickyKey,
      persistedSession,
      prewarmedTransport: prewarmed
        ? {
            transport: prewarmed.transport,
            envHomeDir: prewarmed.homeDir,
            initCaps: prewarmed.initCaps,
            bindHandlers: prewarmed.bindHandlers,
          }
        : undefined,
      onSessionStateChange: isPrimarySlot
        ? (snapshot) => {
            if (snapshot) {
              store.upsertAcpSession({
                stickyKey,
                sessionId: snapshot.sessionId,
                accountId: account.id,
                model,
                systemHash: snapshot.systemHash,
                toolsHash: snapshot.toolsHash,
                committedHashes: snapshot.committedHashes,
                updatedAt: snapshot.updatedAt,
              });
            } else {
              store.deleteAcpSession(stickyKey);
            }
          }
        : undefined,
    });

    entry = {
      key: entryKey,
      accountId: account.id,
      sessionHash: resolvedSessionKey,
      worker,
      inUse: true,
    };
    this.entries.set(entryKey, entry);
    this.syncActiveCount(account.id);

    if (this.prewarmPerAccount > 0 && !this.shuttingDown && account.status === "ready") {
      void this.prewarmAccount(account);
    }

    return {
      worker,
      release: () => this.releaseEntry(entryKey),
    };
  }

  private releaseEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.inUse = false;
    entry.worker.lastUsedAt = Date.now();
    this.syncActiveCount(entry.accountId);
  }

  getActiveCount(accountId: string): number {
    return this.activeCounts.get(accountId) ?? 0;
  }

  private syncActiveCount(accountId: string): void {
    let activeWorkers = 0;
    for (const entry of this.entries.values()) {
      if (entry.accountId === accountId && entry.inUse) {
        activeWorkers++;
      }
    }
    if (activeWorkers > 0) {
      this.activeCounts.set(accountId, activeWorkers);
    } else {
      this.activeCounts.delete(accountId);
    }
  }

  getPrewarmCount(accountId?: string): number {
    this.pruneDeadPrewarmed();
    if (accountId !== undefined) {
      return this.prewarmed.get(accountId)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.prewarmed.values()) {
      total += list.length;
    }
    return total;
  }

  private totalPrewarmedAndInFlight(): number {
    let total = 0;
    for (const list of this.prewarmed.values()) {
      total += list.length;
    }
    for (const n of this.prewarmInFlight.values()) {
      total += n;
    }
    return total;
  }

  private pruneDeadPrewarmed(): void {
    for (const [accountId, list] of this.prewarmed.entries()) {
      const alive: PrewarmEntry[] = [];
      for (const entry of list) {
        if (!entry.adopted && entry.transport.isAlive()) {
          alive.push(entry);
        } else if (!entry.adopted) {
          void entry.transport.close().catch(() => {});
        }
      }
      if (alive.length > 0) {
        this.prewarmed.set(accountId, alive);
      } else {
        this.prewarmed.delete(accountId);
      }
    }
  }

  private removePrewarmEntry(accountId: string, target: PrewarmEntry | null): void {
    if (!target) return;
    const list = this.prewarmed.get(accountId);
    if (!list) return;
    const next = list.filter((item) => item !== target);
    if (next.length > 0) {
      this.prewarmed.set(accountId, next);
    } else {
      this.prewarmed.delete(accountId);
    }
  }

  private takePrewarmedTransport(accountId: string, homeDir: string): PrewarmEntry | null {
    const list = this.prewarmed.get(accountId);
    if (!list || list.length === 0) return null;

    while (list.length > 0) {
      const candidate = list.shift()!;
      if (list.length === 0) {
        this.prewarmed.delete(accountId);
      }
      if (candidate.homeDir === homeDir && candidate.transport.isAlive()) {
        candidate.adopted = true;
        return candidate;
      }
      void candidate.transport.close().catch(() => {});
    }
    return null;
  }

  private async withStartLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeStarts >= this.maxConcurrentStarts) {
      await new Promise<void>((resolve) => {
        this.startQueue.push(resolve);
      });
    }
    this.activeStarts++;
    try {
      return await fn();
    } finally {
      this.activeStarts--;
      const next = this.startQueue.shift();
      if (next) next();
    }
  }

  async prewarmAccount(account: AccountRecord): Promise<boolean> {
    if (
      this.shuttingDown ||
      this.prewarmPerAccount <= 0 ||
      this.maxPrewarmTotal <= 0 ||
      account.status !== "ready"
    ) {
      return false;
    }

    this.pruneDeadPrewarmed();
    const existingForAccount = this.prewarmed.get(account.id)?.length ?? 0;
    const inFlightForAccount = this.prewarmInFlight.get(account.id) ?? 0;
    if (existingForAccount + inFlightForAccount >= this.prewarmPerAccount) {
      return false;
    }
    if (this.totalPrewarmedAndInFlight() >= this.maxPrewarmTotal) {
      return false;
    }

    this.prewarmInFlight.set(account.id, inFlightForAccount + 1);
    let transport: AcpTransport | null = null;
    try {
      return await this.withStartLimit(async () => {
        if (this.shuttingDown) return false;

        const factory = this.transportFactory ?? defaultTransportFactory;
        const workspaceDir = this.workspaceDir ?? getDataRoot();
        ensureMinimalAgentDefinition(workspaceDir);
        const binaryPath = resolveAgyBinary(this.agyPath);
        const env = buildIsolatedAgyEnv({
          homeDir: account.homeDir,
          proxyUrl: account.proxyUrl || undefined,
          agyPath: binaryPath,
        });
        const args = buildAgyWorkerArgs({
          homeDir: account.homeDir,
          workspaceDir,
        });

        let boundHandlers: {
          onUpdate?: (params: Record<string, unknown>) => void;
          onExit?: (code: number | null, stderr: string) => void;
        } = {};
        let entryRef: PrewarmEntry | null = null;

        transport = factory({
          binaryPath,
          args,
          cwd: workspaceDir,
          env,
          onUpdate: (params) => boundHandlers.onUpdate?.(params),
          onExit: (code, stderr) => {
            if (entryRef && !entryRef.adopted) {
              this.removePrewarmEntry(account.id, entryRef);
            }
            boundHandlers.onExit?.(code, stderr);
          },
        });

        const initCaps = await transport.initialize();
        if (this.shuttingDown || !transport.isAlive()) {
          await transport.close().catch(() => {});
          transport = null;
          return false;
        }

        this.pruneDeadPrewarmed();
        const currentForAccount = this.prewarmed.get(account.id)?.length ?? 0;
        let currentTotal = 0;
        for (const list of this.prewarmed.values()) {
          currentTotal += list.length;
        }
        if (currentForAccount >= this.prewarmPerAccount || currentTotal >= this.maxPrewarmTotal) {
          await transport.close().catch(() => {});
          transport = null;
          return false;
        }

        const entry: PrewarmEntry = {
          accountId: account.id,
          homeDir: account.homeDir,
          transport,
          initCaps,
          createdAt: Date.now(),
          adopted: false,
          bindHandlers: (handlers) => {
            boundHandlers = handlers;
          },
        };
        entryRef = entry;

        const list = this.prewarmed.get(account.id) ?? [];
        list.push(entry);
        this.prewarmed.set(account.id, list);
        transport = null; // Ownership transferred to prewarmed pool
        return true;
      });
    } catch {
      if (transport) {
        await (transport as AcpTransport).close().catch(() => {});
      }
      return false;
    } finally {
      const current = this.prewarmInFlight.get(account.id) ?? 0;
      if (current <= 1) {
        this.prewarmInFlight.delete(account.id);
      } else {
        this.prewarmInFlight.set(account.id, current - 1);
      }
    }
  }

  async ensurePrewarm(accounts: AccountRecord[]): Promise<void> {
    if (this.shuttingDown || this.prewarmPerAccount <= 0 || this.maxPrewarmTotal <= 0) {
      return;
    }
    const ready = accounts.filter((a) => a.status === "ready");
    await Promise.allSettled(ready.map((acc) => this.prewarmAccount(acc)));
  }

  async evictAccountWorkers(accountId: string): Promise<void> {
    const toClose: PoolEntry[] = [];
    for (const [key, entry] of this.entries.entries()) {
      if (entry.accountId === accountId) {
        this.entries.delete(key);
        toClose.push(entry);
      }
    }
    const prewarmList = this.prewarmed.get(accountId) ?? [];
    this.prewarmed.delete(accountId);
    await Promise.allSettled([
      ...toClose.map((e) => e.worker.resetAndClose()),
      ...prewarmList.map((p) => p.transport.close()),
    ]);
    this.syncActiveCount(accountId);
  }

  async cleanupIdleWorkers(nowMs = Date.now()): Promise<number> {
    this.pruneDeadPrewarmed();
    const expired: PoolEntry[] = [];
    for (const [key, entry] of this.entries.entries()) {
      if (!entry.inUse && nowMs - entry.worker.lastUsedAt > this.idleTtlMs) {
        this.entries.delete(key);
        expired.push(entry);
      }
    }
    await Promise.allSettled(expired.map((e) => e.worker.resetAndClose()));
    store.pruneAcpSessions(undefined, nowMs);
    return expired.length;
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const all = Array.from(this.entries.values());
    this.entries.clear();
    this.activeCounts.clear();

    const allPrewarmed: PrewarmEntry[] = [];
    for (const list of this.prewarmed.values()) {
      allPrewarmed.push(...list);
    }
    this.prewarmed.clear();

    await Promise.allSettled([
      ...all.map((e) => e.worker.resetAndClose()),
      ...allPrewarmed.map((p) => p.transport.close()),
    ]);
  }
}
