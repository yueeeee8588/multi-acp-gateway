import { createHash } from "node:crypto";
import {
  AgySessionWorker,
  type AcpSessionSnapshot,
  closeAgyTransport,
  defaultTransportFactory,
  type AcpTransport,
  type AcpTransportFactory,
  type PrewarmedTransportOptions,
} from "./worker";
import { buildAgyWorkerArgs, buildIsolatedAgyEnv, createAgyWorkerLogPath, getDataRoot, removeAgyWorkerLog, resolveAgyBinary } from "./env";
import { ensureMinimalAgentDefinition } from "./minimal-agent";
import { LoopbackMcpServer } from "./loopback-mcp";
import { store } from "../db/store";
import { getConfig, resolveEffectiveProxy } from "../config/settings";
import { checkProxyReachable } from "../accounts/exit-probe";
import { accountScheduler } from "../accounts/scheduler";
import type { AccountRecord, GeminiContent, GeminiGenerateRequest } from "../types";

export interface AcpWorkerPoolOptions {
  mcpServer: LoopbackMcpServer;
  agyPath?: string;
  softErrorCutoffMs?: number | (() => number);
  idleTtlMs?: number;
  cleanupIntervalMs?: number;
  transportFactory?: AcpTransportFactory;
  workspaceDir?: string;
  prewarmPerAccount?: number;
  maxPrewarmTotal?: number;
  maxConcurrentStarts?: number;
  onWorkerSpawn?: (accountId: string) => void;
  tryAcquireWorkerSpawn?: (accountId: string) => boolean;
}

export interface AcpWorkerAcquireOptions {
  /** Opt in only for independent single-turn requests. */
  stateless?: boolean;
}

export type WorkerLease = { worker: AgySessionWorker; release: () => void };

// Read-only bridge to the current worker's TS-private state. Unknown state is not recyclable.
interface RecyclableWorker {
  /** True only after session/close and a reset that preserves the process for session/new. */
  recycleSession?: () => Promise<boolean>;
  awaitingTools?: ReadonlyMap<string, unknown>;
  unemittedToolCalls?: readonly unknown[];
  broker?: { readonly pendingCount: number } | null;
  inFlightPromptPromise?: Promise<unknown> | null;
}

interface SessionPersistence {
  stickyKey: string;
  enabled: boolean;
  currentMirroredLegacyKey: string | null;
}

interface PoolEntry {
  accountId: string;
  model: string;
  homeDir: string;
  proxyUrl?: string;
  stateless: boolean;
  isOverflow?: boolean;
  persistence?: SessionPersistence;
  worker: AgySessionWorker;
  inUse: boolean;
}

interface StatelessDonor {
  key: string;
  entry: PoolEntry;
  recycle: () => Promise<boolean>;
}

interface PrewarmEntry {
  accountId: string;
  homeDir: string;
  boundProxyUrl?: string;
  transport: AcpTransport;
  logFile: string;
  initCaps: unknown;
  createdAt: number;
  adopted: boolean;
  bindHandlers: NonNullable<PrewarmedTransportOptions["bindHandlers"]>;
}

export function computeSessionPrefixHash(contents: GeminiContent[]): string {
  const prefix = contents.slice(0, 2).map((c) => ({
    role: c.role ?? "user",
    parts: (c.parts ?? []).map((p) => ({
      text: p.text ?? "",
      hasImage: Boolean(p.inlineData),
    })),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ prefix }))
    .digest("hex")
    .slice(0, 16);
}

function computeLegacySessionPrefixHash(model: string, contents: GeminiContent[]): string {
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
const MIN_STATEFUL_DONOR_IDLE_MS = 5 * 60_000;
const RECYCLE_TIMEOUT_MS = 2_000;

export class AcpWorkerPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly activeCounts = new Map<string, number>();
  private readonly prewarmed = new Map<string, PrewarmEntry[]>();
  private readonly prewarmInFlight = new Map<string, number>();
  private readonly mcpServer: LoopbackMcpServer;
  private readonly agyPath?: string;
  private readonly softErrorCutoffMs: AcpWorkerPoolOptions["softErrorCutoffMs"];
  private readonly idleTtlMs: number;
  private readonly transportFactory?: AcpTransportFactory;
  private readonly workspaceDir?: string;
  private readonly prewarmPerAccount: number;
  private readonly maxPrewarmTotal: number;
  private readonly maxConcurrentStarts: number;
  private readonly tryAcquireWorkerSpawn: (accountId: string) => boolean;
  private activeStarts = 0;
  private nextOverflowSlot = 0;
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
    this.tryAcquireWorkerSpawn =
      opts.tryAcquireWorkerSpawn ??
      (opts.onWorkerSpawn
        ? (accountId) => {
            opts.onWorkerSpawn!(accountId);
            return true;
          }
        : (accountId) => accountScheduler.tryConsumeWorkerSpawn(accountId));

    store.pruneAcpSessions();

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
    sessionKey: string | undefined,
    options: AcpWorkerAcquireOptions,
  ): WorkerLease | Promise<WorkerLease>;
  acquireWorker(
    account: AccountRecord,
    model: string,
    request: GeminiGenerateRequest,
    sessionKey?: string,
    options?: undefined,
  ): WorkerLease;
  acquireWorker(
    account: AccountRecord,
    model: string,
    request: GeminiGenerateRequest,
    sessionKey?: string,
    options?: AcpWorkerAcquireOptions,
  ): WorkerLease | Promise<WorkerLease> {
    if (!options) return this.acquireLease(account, model, request, sessionKey, false);
    return this.acquireWithOptions(account, model, request, sessionKey, options);
  }

  private async acquireWithOptions(
    account: AccountRecord, model: string, request: GeminiGenerateRequest,
    sessionKey: string | undefined, options: AcpWorkerAcquireOptions,
  ): Promise<WorkerLease> {
    const turn = request.contents?.[0];
    const stateless = options.stateless === true && request.contents?.length === 1 && !!turn &&
      (turn.role ?? "user") === "user" && (turn.parts?.length ?? 0) > 0 &&
      turn.parts.every((part) => !part.functionCall && !part.functionResponse);
    return this.acquireLease(account, model, request, sessionKey, stateless);
  }

  private acquireLease(
    account: AccountRecord, model: string, request: GeminiGenerateRequest,
    sessionKey: string | undefined, stateless: false,
  ): WorkerLease;
  private acquireLease(
    account: AccountRecord, model: string, request: GeminiGenerateRequest,
    sessionKey: string | undefined, stateless: boolean,
  ): WorkerLease | Promise<WorkerLease>;
  private acquireLease(
    account: AccountRecord, model: string, request: GeminiGenerateRequest,
    sessionKey: string | undefined, stateless: boolean,
  ): WorkerLease | Promise<WorkerLease> {
    if (this.shuttingDown) throw new Error("ACP worker pool is shutting down");

    const trimmedSessionKey = sessionKey && sessionKey.trim() ? sessionKey.trim() : "";
    const resolvedSessionKey = trimmedSessionKey || computeSessionPrefixHash(request.contents ?? []);
    const legacySessionKey = trimmedSessionKey || computeLegacySessionPrefixHash(model, request.contents ?? []);
    const stickyKey = `${account.id}:${resolvedSessionKey}`;
    const legacyStickyKey = `${account.id}:${model}:${legacySessionKey}`;
    // Separate one-shot leases from conversation entries (including on a sticky-key collision).
    const primaryKey = JSON.stringify([stateless, stickyKey]);
    const legacyPrimaryKey = JSON.stringify([stateless, legacyStickyKey]);

    let matchedEntryKey = primaryKey;
    let entry = this.entries.get(primaryKey);
    if (!entry && !stateless) {
      const legacyEntry = this.entries.get(legacyPrimaryKey);
      if (legacyEntry) {
        entry = legacyEntry;
        matchedEntryKey = legacyPrimaryKey;
      }
    }
    if (entry && !entry.inUse && (!stateless || this.isQuiescent(entry.worker)) &&
      entry.worker.canReuse(request, undefined, account, model)) {
      entry.worker.setRequestedModel(model);
      if (matchedEntryKey !== primaryKey) {
        this.entries.delete(matchedEntryKey);
      }
      entry.model = model;
      return this.leaseEntry(primaryKey, entry);
    }

    if (!stateless) {
      const existingPrimary = this.entries.get(primaryKey);
      if (!existingPrimary?.inUse) {
        for (const candidateKey of [
          JSON.stringify([true, stickyKey]),
          JSON.stringify([true, legacyStickyKey]),
        ]) {
          const candidate = this.entries.get(candidateKey);
          if (
            candidate &&
            !candidate.inUse &&
            this.isQuiescent(candidate.worker) &&
            candidate.worker.canReuse(request, undefined, account, model)
          ) {
            if (existingPrimary) {
              if (existingPrimary.persistence) existingPrimary.persistence.enabled = false;
              this.entries.delete(primaryKey);
              this.retireWorker(existingPrimary.worker);
            }
            this.entries.delete(candidateKey);
            candidate.stateless = false;
            candidate.model = model;
            const persistence: SessionPersistence = { stickyKey, enabled: true, currentMirroredLegacyKey: null };
            candidate.persistence = persistence;
            candidate.worker.bindSessionPersistence(stickyKey, (snapshot) => {
              this.persistSession(persistence, account.id, model, legacySessionKey, snapshot);
            });
            candidate.worker.setRequestedModel(model);
            return this.leaseEntry(primaryKey, candidate);
          }
        }
      }
    }

    if (entry && matchedEntryKey !== primaryKey && !entry.inUse) {
      if (entry.persistence) entry.persistence.enabled = false;
      this.entries.delete(matchedEntryKey);
      this.retireWorker(entry.worker);
    }

    const expectedProxy = resolveEffectiveProxy(account.proxyUrl);
    const prewarmed = this.takePrewarmedTransport(account.id, account.homeDir, expectedProxy);
    if (stateless && !prewarmed && process.env.AGY_BRIDGE_STATELESS_REUSE !== "0") {
      const donor = this.findStatelessDonor(account, model, expectedProxy);
      if (donor) {
        const homeDir = account.homeDir;
        return this.recycleDonor(donor, (recycled) => {
          const currentProxy = resolveEffectiveProxy(account.proxyUrl);
          if (recycled && (account.homeDir !== homeDir || currentProxy !== expectedProxy ||
            process.env.AGY_BRIDGE_STATELESS_REUSE === "0")) {
            this.retireWorker(recycled);
            recycled = undefined;
          }
          // A failed recycle takes the cold path even if prewarm finished during the attempt.
          return this.installLease(
            account, model, stickyKey, legacyStickyKey, legacySessionKey,
            primaryKey, true, currentProxy, null, recycled,
          );
        });
      }
    }
    return this.installLease(
      account, model, stickyKey, legacyStickyKey, legacySessionKey,
      primaryKey, stateless, expectedProxy, prewarmed,
    );
  }

  private installLease(
    account: AccountRecord, model: string, stickyKey: string,
    legacyStickyKey: string, legacySessionKey: string, primaryKey: string,
    stateless: boolean, expectedProxy: string | undefined, prewarmed: PrewarmEntry | null,
    recycled?: AgySessionWorker,
  ): WorkerLease {
    const old = this.entries.get(primaryKey);
    // Stateless callers may have a same-key worker awaiting tool results. Do not
    // replace that entry, even when it cannot satisfy an independent request.
    const useOverflow = Boolean(
      old && (old.inUse || (stateless && old.worker.isAlive && !this.isQuiescent(old.worker))),
    );
    const entryKey = useOverflow ? JSON.stringify([primaryKey, ++this.nextOverflowSlot]) : primaryKey;
    if (old && !useOverflow) {
      if (old.persistence) old.persistence.enabled = false;
      this.entries.delete(primaryKey);
      this.retireWorker(old.worker);
    }
    const isPrimarySlot = !stateless && !useOverflow;
    const persistence: SessionPersistence | undefined = isPrimarySlot
      ? { stickyKey, enabled: true, currentMirroredLegacyKey: null }
      : undefined;
    const persistedSession = persistence
      ? (store.getAcpSession(stickyKey) ?? store.getAcpSession(legacyStickyKey) ?? undefined)
      : undefined;
    if (persistence && persistedSession?.stickyKey === legacyStickyKey) {
      persistence.currentMirroredLegacyKey = legacyStickyKey;
    }

    const worker = recycled ?? new AgySessionWorker({
      account,
      model,
      agyPath: this.agyPath,
      softErrorCutoffMs: typeof this.softErrorCutoffMs === "function"
        ? this.softErrorCutoffMs()
        : this.softErrorCutoffMs,
      mcpServer: this.mcpServer,
      workspaceDir: this.workspaceDir,
      transportFactory: this.transportFactory,
      stickyKey: stateless ? undefined : stickyKey,
      persistedSession,
      tryAcquireWorkerSpawn: this.tryAcquireWorkerSpawn,
      prewarmedTransport: prewarmed
        ? {
            transport: prewarmed.transport,
            envHomeDir: prewarmed.homeDir,
            boundProxyUrl: prewarmed.boundProxyUrl,
            logFile: prewarmed.logFile,
            initCaps: prewarmed.initCaps,
            bindHandlers: prewarmed.bindHandlers,
          }
        : undefined,
      onSessionStateChange: persistence
        ? (snapshot) => this.persistSession(persistence, account.id, model, legacySessionKey, snapshot)
        : undefined,
    });

    const lease = this.leaseEntry(entryKey, {
      accountId: account.id,
      model,
      homeDir: account.homeDir,
      proxyUrl: expectedProxy,
      stateless,
      isOverflow: useOverflow,
      persistence,
      worker,
      inUse: true,
    });
    if (this.prewarmPerAccount > 0 && !this.shuttingDown && account.status === "ready") {
      void this.prewarmAccount(account);
    }
    return lease;
  }

  private persistSession(
    persistence: SessionPersistence, accountId: string, model: string, legacySessionKey: string,
    snapshot: AcpSessionSnapshot | null,
  ): void {
    const { stickyKey } = persistence;
    const legacyStickyKey = `${accountId}:${model}:${legacySessionKey}`;
    if (!persistence.enabled) return;
    if (snapshot) {
      const activeModel = snapshot.model ?? model;
      const record = {
        stickyKey,
        sessionId: snapshot.sessionId,
        accountId,
        model: activeModel,
        systemHash: snapshot.systemHash,
        toolsHash: snapshot.toolsHash,
        sensitiveFilterFingerprint: snapshot.sensitiveFilterFingerprint ?? "",
        committedHashes: snapshot.committedHashes,
        committedNormalized: snapshot.committedNormalized ?? [],
        committedSummaries: snapshot.committedSummaries ?? [],
        midTurn: snapshot.midTurn ?? false,
        committedCount: snapshot.committedCount ?? snapshot.committedHashes.length,
        midTurnMeta: snapshot.midTurnMeta ?? null,
        updatedAt: snapshot.updatedAt,
      };
      store.upsertAcpSession(record);
      const compatLegacyKey = `${accountId}:${activeModel}:${legacySessionKey}`;
      store.upsertAcpSession({
        ...record,
        stickyKey: compatLegacyKey,
      });
      persistence.currentMirroredLegacyKey = compatLegacyKey;
    } else {
      store.deleteAcpSession(stickyKey);
      store.deleteAcpSession(legacyStickyKey);
      if (
        persistence.currentMirroredLegacyKey &&
        persistence.currentMirroredLegacyKey !== legacyStickyKey
      ) {
        store.deleteAcpSession(persistence.currentMirroredLegacyKey);
      }
      persistence.currentMirroredLegacyKey = null;
    }
  }

  private leaseEntry(key: string, entry: PoolEntry): WorkerLease {
    entry.inUse = true;
    this.entries.set(key, entry);
    this.syncActiveCount(entry.accountId);
    let released = false;
    return {
      worker: entry.worker,
      release: () => {
        if (released || this.entries.get(key) !== entry) return;
        released = true;
        entry.inUse = false;
        entry.worker.lastUsedAt = Date.now();
        if (entry.isOverflow && (this.isQuiescent(entry.worker) || !entry.worker.isAlive)) {
          this.entries.delete(key);
          this.syncActiveCount(entry.accountId);
          this.retireWorker(entry.worker);
          return;
        }
        this.syncActiveCount(entry.accountId);
      },
    };
  }

  private isQuiescent(worker: AgySessionWorker): boolean {
    const state = worker as unknown as RecyclableWorker;
    return !worker.isBusy && state.awaitingTools?.size === 0 &&
      state.unemittedToolCalls?.length === 0 && state.inFlightPromptPromise === null &&
      (state.broker === null || state.broker?.pendingCount === 0);
  }

  private findStatelessDonor(account: AccountRecord, model: string, proxyUrl?: string): StatelessDonor | undefined {
    const now = Date.now();
    const statefulIdleMs = Math.max(this.idleTtlMs, MIN_STATEFUL_DONOR_IDLE_MS);
    let best: StatelessDonor | undefined;
    for (const [key, entry] of this.entries) {
      const worker = entry.worker;
      const state = worker as unknown as RecyclableWorker;
      if (
        entry.accountId !== account.id || entry.model !== model || entry.homeDir !== account.homeDir ||
        entry.proxyUrl !== proxyUrl || worker.getBoundProxyUrl() !== proxyUrl ||
        entry.inUse || !worker.isAlive ||
        (!entry.stateless && !(now - worker.lastUsedAt > statefulIdleMs)) ||
        typeof state.recycleSession !== "function" || !this.isQuiescent(worker)
      ) continue;
      if (!best || (entry.stateless !== best.entry.stateless
        ? entry.stateless
        : worker.lastUsedAt < best.entry.worker.lastUsedAt)) {
        best = { key, entry, recycle: state.recycleSession.bind(worker) };
      }
    }
    return best;
  }

  private async recycleDonor(
    { key, entry, recycle }: StatelessDonor,
    install: (worker?: AgySessionWorker) => WorkerLease,
  ): Promise<WorkerLease> {
    // Reserve synchronously; sticky acquisitions, cleanup and other borrowers cannot take it.
    entry.inUse = true;
    this.syncActiveCount(entry.accountId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recycled = false;
    let timedOut = false;
    try {
      if (entry.persistence) {
        entry.persistence.enabled = false;
        store.deleteAcpSession(entry.persistence.stickyKey);
        if (entry.persistence.currentMirroredLegacyKey) {
          store.deleteAcpSession(entry.persistence.currentMirroredLegacyKey);
          entry.persistence.currentMirroredLegacyKey = null;
        }
      }
      recycled = (await Promise.race([
        recycle(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve(false);
          }, RECYCLE_TIMEOUT_MS);
        }),
      ])) === true;
      if (!recycled) {
        console.warn(
          `[acp-pool] donor recycle ${timedOut ? `timed out after ${RECYCLE_TIMEOUT_MS}ms` : "returned false"} for account=${entry.accountId} model=${entry.model} key=${key}; retiring worker`
        );
      }
    } catch (err) {
      // A partially reset worker can't safely go back into circulation.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[acp-pool] donor recycle threw for account=${entry.accountId} model=${entry.model} key=${key}; retiring worker: ${msg}`
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (this.entries.get(key) !== entry) {
      this.syncActiveCount(entry.accountId);
      if (recycled) this.retireWorker(entry.worker);
      if (this.shuttingDown) {
        throw new Error("ACP recycle interrupted by pool eviction");
      }
      return install(undefined);
    }
    this.entries.delete(key);
    this.syncActiveCount(entry.accountId);
    if (!recycled) this.retireWorker(entry.worker);
    // Install in the same turn as removing the reservation, so eviction can never miss both.
    return install(recycled ? entry.worker : undefined);
  }

  private retireWorker(worker: AgySessionWorker): void {
    // Do not make fallback wait for a broken worker to acknowledge shutdown.
    void Promise.resolve()
      .then(() => worker.resetAndClose())
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[acp-pool] retired worker resetAndClose failed: ${msg}`);
      });
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
          void closeAgyTransport(entry.transport, entry.logFile).catch(() => {});
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

  private takePrewarmedTransport(
    accountId: string,
    homeDir: string,
    expectedProxy?: string,
  ): PrewarmEntry | null {
    const list = this.prewarmed.get(accountId);
    if (!list || list.length === 0) return null;

    while (list.length > 0) {
      const candidate = list.shift()!;
      if (list.length === 0) {
        this.prewarmed.delete(accountId);
      }
      if (
        candidate.homeDir === homeDir &&
        candidate.boundProxyUrl === expectedProxy &&
        candidate.transport.isAlive()
      ) {
        candidate.adopted = true;
        return candidate;
      }
      void closeAgyTransport(candidate.transport, candidate.logFile).catch(() => {});
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
    let logFile: string | undefined;
    try {
      return await this.withStartLimit(async () => {
        if (this.shuttingDown) return false;

        const cfg = getConfig();
        const effectiveProxy = resolveEffectiveProxy(account.proxyUrl, cfg);
        if (effectiveProxy && cfg.strictProxyBinding) {
          const reach = await checkProxyReachable(effectiveProxy);
          if (!reach.ok) {
            return false;
          }
        }

        const factory = this.transportFactory ?? defaultTransportFactory;
        const workspaceDir = this.workspaceDir ?? getDataRoot();
        ensureMinimalAgentDefinition(workspaceDir);
        const binaryPath = resolveAgyBinary(this.agyPath);
        const env = buildIsolatedAgyEnv({
          homeDir: account.homeDir,
          proxyUrl: effectiveProxy,
          agyPath: binaryPath,
        });
        const workerLogFile = createAgyWorkerLogPath(account.homeDir);
        logFile = workerLogFile;
        const args = buildAgyWorkerArgs({
          homeDir: account.homeDir,
          workspaceDir,
          logFile: workerLogFile,
        });

        let boundHandlers: {
          onUpdate?: (params: Record<string, unknown>) => void;
          onExit?: (code: number | null, stderr: string) => void;
        } = {};
        let entryRef: PrewarmEntry | null = null;

        if (!this.tryAcquireWorkerSpawn(account.id)) {
          return false;
        }
        transport = factory({
          binaryPath,
          args,
          cwd: workspaceDir,
          env,
          onUpdate: (params) => boundHandlers.onUpdate?.(params),
          onExit: (code, stderr) => {
            void removeAgyWorkerLog(workerLogFile);
            if (entryRef && !entryRef.adopted) {
              this.removePrewarmEntry(account.id, entryRef);
            }
            boundHandlers.onExit?.(code, stderr);
          },
        });

        const initCaps = await transport.initialize();
        if (this.shuttingDown || !transport.isAlive()) {
          await closeAgyTransport(transport, workerLogFile).catch(() => {});
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
          await closeAgyTransport(transport, workerLogFile).catch(() => {});
          transport = null;
          return false;
        }

        const entry: PrewarmEntry = {
          accountId: account.id,
          homeDir: account.homeDir,
          boundProxyUrl: effectiveProxy,
          transport,
          logFile: workerLogFile,
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
        await closeAgyTransport(transport, logFile).catch(() => {});
      } else {
        await removeAgyWorkerLog(logFile);
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
        if (entry.persistence) entry.persistence.enabled = false;
        toClose.push(entry);
      }
    }
    const prewarmList = this.prewarmed.get(accountId) ?? [];
    this.prewarmed.delete(accountId);
    await Promise.allSettled([
      ...toClose.map((e) => e.worker.resetAndClose()),
      ...prewarmList.map((p) => closeAgyTransport(p.transport, p.logFile)),
    ]);
    this.syncActiveCount(accountId);
  }

  async cleanupIdleWorkers(nowMs = Date.now()): Promise<number> {
    this.pruneDeadPrewarmed();
    const expired: PoolEntry[] = [];
    for (const [key, entry] of this.entries.entries()) {
      if (!entry.inUse && nowMs - entry.worker.lastUsedAt > this.idleTtlMs) {
        this.entries.delete(key);
        if (entry.persistence) entry.persistence.enabled = false;
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
    for (const entry of all) if (entry.persistence) entry.persistence.enabled = false;
    this.entries.clear();
    this.activeCounts.clear();

    const allPrewarmed: PrewarmEntry[] = [];
    for (const list of this.prewarmed.values()) {
      allPrewarmed.push(...list);
    }
    this.prewarmed.clear();

    await Promise.allSettled([
      ...all.map((e) => e.worker.resetAndClose()),
      ...allPrewarmed.map((p) => closeAgyTransport(p.transport, p.logFile)),
    ]);
  }
}
