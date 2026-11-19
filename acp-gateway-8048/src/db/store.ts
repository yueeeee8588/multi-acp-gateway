import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AccountQuotaSnapshot,
  AccountRecord,
  AccountStatus,
  CooldownRecord,
  RequestAttempt,
  RequestLog,
  RequestLogState,
} from '../types';

interface AccountRow {
  id: string;
  label: string;
  email: string;
  source: string;
  home_dir: string;
  proxy_url: string;
  status: string;
  status_reason: string;
  tier: string;
  exit_ip: string;
  exit_country: string;
  concurrency_limit: number;
  active_workers: number;
  last_verified_at: number | null;
  quota_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CooldownRow {
  account_id: string;
  family: string;
  scope_type: string;
  reason: string;
  until_ms: number;
  consecutive_failures: number;
  last_error: string;
}

interface RequestLogRow {
  id: string;
  model: string;
  family: string;
  endpoint: string;
  stream: number;
  state: string;
  http_status: number | null;
  started_at: number;
  duration_ms: number | null;
  switch_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit: number | null;
  cached_tokens: number | null;
  attempts_json: string;
}

interface ConfigKvRow {
  key: string;
  value_json: string;
  updated_at: number;
}

interface StickyAffinityRow {
  sticky_key: string;
  account_id: string;
  last_used_at: number;
  cached_tokens: number;
  cache_written_at: number;
}

export interface StickyAffinityRecord {
  stickyKey: string;
  accountId: string;
  lastUsedAt: number;
  cachedTokens: number;
  cacheWrittenAt: number;
}

export const DEFAULT_ACP_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

interface AcpSessionRow {
  sticky_key: string;
  session_id: string;
  account_id: string;
  model: string;
  system_hash: string;
  tools_hash: string;
  committed_hashes_json: string;
  updated_at: number;
}

export interface AcpSessionRecord {
  stickyKey: string;
  sessionId: string;
  accountId: string;
  model: string;
  systemHash: string;
  toolsHash: string;
  committedHashes: string[];
  updatedAt: number;
}

function rowToAcpSession(row: AcpSessionRow): AcpSessionRecord | null {
  let committedHashes: string[];
  try {
    const parsed = JSON.parse(row.committed_hashes_json);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      console.warn(
        `[store] corrupted acp_sessions.committed_hashes_json for sticky_key=${row.sticky_key}; deleting row`
      );
      return null;
    }
    committedHashes = parsed;
  } catch (err) {
    console.warn(
      `[store] failed to parse acp_sessions.committed_hashes_json for sticky_key=${row.sticky_key}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  return {
    stickyKey: row.sticky_key,
    sessionId: row.session_id,
    accountId: row.account_id,
    model: row.model,
    systemHash: row.system_hash,
    toolsHash: row.tools_hash,
    committedHashes,
    updatedAt: row.updated_at,
  };
}

function rowToStickyAffinity(row: StickyAffinityRow): StickyAffinityRecord {
  return {
    stickyKey: row.sticky_key,
    accountId: row.account_id,
    lastUsedAt: row.last_used_at,
    cachedTokens: row.cached_tokens,
    cacheWrittenAt: row.cache_written_at,
  };
}

function parseAccountQuota(row: AccountRow): AccountQuotaSnapshot | null {
  if (!row.quota_json) return null;
  try {
    const snapshot = JSON.parse(row.quota_json) as AccountQuotaSnapshot | null;
    if (snapshot === null) return null;
    if (!Number.isFinite(snapshot.fetchedAt) || !snapshot.pools
      || (snapshot.projectId !== undefined && typeof snapshot.projectId !== 'string')
      || (snapshot.error !== undefined && typeof snapshot.error !== 'string')) {
      throw new Error('Invalid quota snapshot');
    }
    for (const key of ['gemini_flagship', 'gemini_flash', 'third_party'] as const) {
      const pool = snapshot.pools[key];
      if (pool === null) continue;
      if (!pool || pool.pool !== key || typeof pool.label !== 'string'
        || !Number.isFinite(pool.percentage) || !Number.isFinite(pool.remainingFraction)
        || (pool.resetTime !== null && typeof pool.resetTime !== 'string')
        || (pool.bottleneckModel !== null && typeof pool.bottleneckModel !== 'string')
        || (pool.window5h !== null && !Number.isFinite(pool.window5h))
        || (pool.windowWeekly !== null && !Number.isFinite(pool.windowWeekly))
        || !Array.isArray(pool.models)) {
        throw new Error('Invalid quota pool');
      }
      for (const model of pool.models) {
        if (!model || typeof model.id !== 'string' || typeof model.displayName !== 'string'
          || !Number.isFinite(model.percentage)) {
          throw new Error('Invalid model quota');
        }
      }
    }
    return snapshot;
  } catch {
    console.warn(`[store] invalid accounts.quota_json for id=${row.id}`);
    return null;
  }
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    source: row.source,
    homeDir: row.home_dir,
    proxyUrl: row.proxy_url,
    status: row.status as AccountStatus,
    statusReason: row.status_reason,
    tier: row.tier === 'pro' ? 'pro' : 'standard',
    exitIp: row.exit_ip,
    exitCountry: row.exit_country,
    concurrencyLimit: row.concurrency_limit,
    activeWorkers: row.active_workers,
    lastVerifiedAt: row.last_verified_at,
    quota: parseAccountQuota(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCooldown(row: CooldownRow): CooldownRecord {
  return {
    accountId: row.account_id,
    family: row.family,
    scopeType: row.scope_type,
    reason: row.reason,
    untilMs: row.until_ms,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

function rowToRequestLog(row: RequestLogRow): RequestLog {
  let attempts: RequestAttempt[] = [];
  try {
    attempts = JSON.parse(row.attempts_json) as RequestAttempt[];
  } catch {
    attempts = [];
  }
  return {
    id: row.id,
    model: row.model,
    family: row.family,
    endpoint: row.endpoint,
    stream: row.stream === 1,
    state: row.state as RequestLogState,
    httpStatus: row.http_status ?? undefined,
    startedAt: row.started_at,
    durationMs: row.duration_ms ?? undefined,
    switchCount: row.switch_count,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    cacheHit: row.cache_hit === null || row.cache_hit === undefined ? undefined : row.cache_hit === 1,
    cachedTokens: row.cached_tokens ?? undefined,
    attempts,
  };
}

const DEFAULT_DB_PATH = 'data/gateway.db';

/**
 * 判断当前进程是否跑在 `bun test` 下。
 * 依次覆盖：NODE_ENV=test、Bun.argv 含 `test`、以及直接执行 `.test.ts` 文件。
 */
function isTestRun(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  const argv =
    typeof Bun !== 'undefined' && Array.isArray(Bun.argv) ? Bun.argv : process.argv;
  return argv.some((a) => a === 'test' || a.endsWith('.test.ts'));
}

/**
 * 解析数据库文件路径。优先级：
 *   1. 构造时显式传入的路径；
 *   2. 环境变量 `AGY_DB_PATH`；
 *   3. 测试运行（bun test）→ `:memory:`，彻底隔离，绝不污染生产库；
 *   4. 默认 `data/gateway.db`。
 */
export function resolveGatewayDbPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.AGY_DB_PATH) return process.env.AGY_DB_PATH;
  if (isTestRun()) return ':memory:';
  return DEFAULT_DB_PATH;
}

export class GatewayStore {
  public readonly db: Database;

  constructor(dbPath?: string) {
    const resolved = resolveGatewayDbPath(dbPath);
    if (resolved !== ':memory:') {
      mkdirSync(dirname(resolved), { recursive: true });
    }
    this.db = new Database(resolved, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        home_dir TEXT NOT NULL DEFAULT '',
        proxy_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        status_reason TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL DEFAULT 'standard',
        exit_ip TEXT NOT NULL DEFAULT '',
        exit_country TEXT NOT NULL DEFAULT '',
        concurrency_limit INTEGER NOT NULL DEFAULT 2,
        active_workers INTEGER NOT NULL DEFAULT 0,
        last_verified_at INTEGER,
        quota_json TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cooldowns (
        account_id TEXT NOT NULL,
        family TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        until_ms INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 1,
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (account_id, family, scope_type)
      );

      CREATE INDEX IF NOT EXISTS idx_cooldowns_until ON cooldowns (until_ms);

      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        family TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        http_status INTEGER,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER,
        switch_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_hit INTEGER,
        cached_tokens INTEGER,
        attempts_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_request_logs_started ON request_logs (started_at DESC);

      CREATE TABLE IF NOT EXISTS config_kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sticky_affinity (
        sticky_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cache_written_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sticky_affinity_last_used ON sticky_affinity (last_used_at DESC);

      CREATE TABLE IF NOT EXISTS acp_sessions (
        sticky_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        model TEXT NOT NULL,
        system_hash TEXT NOT NULL,
        tools_hash TEXT NOT NULL,
        committed_hashes_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_acp_sessions_updated_at ON acp_sessions (updated_at);
    `);

    // 老库平滑升级：若缺少 tier / quota_json 列则补上
    const columns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(accounts)')
      .all();
    if (!columns.some((c) => c.name === 'tier')) {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN tier TEXT NOT NULL DEFAULT 'standard';`);
    }
    if (!columns.some((c) => c.name === 'quota_json')) {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN quota_json TEXT DEFAULT NULL;`);
    }

    const requestLogColumns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(request_logs)')
      .all();
    if (!requestLogColumns.some((c) => c.name === 'cache_hit')) {
      this.db.exec(`ALTER TABLE request_logs ADD COLUMN cache_hit INTEGER;`);
    }
    if (!requestLogColumns.some((c) => c.name === 'cached_tokens')) {
      this.db.exec(`ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER;`);
    }
  }

  // --------------------------------------------------------------------------
  // Accounts CRUD
  // --------------------------------------------------------------------------

  listAccounts(): AccountRecord[] {
    const rows = this.db
      .query<AccountRow, []>('SELECT * FROM accounts ORDER BY created_at ASC')
      .all();
    return rows.map(rowToAccount);
  }

  getAccount(id: string): AccountRecord | null {
    const row = this.db
      .query<AccountRow, [string]>('SELECT * FROM accounts WHERE id = ?')
      .get(id);
    return row ? rowToAccount(row) : null;
  }

  upsertAccount(account: AccountRecord): void {
    const quotaJson = account.quota ? JSON.stringify(account.quota) : null;
    this.db
      .query(
        `INSERT INTO accounts (
          id, label, email, source, home_dir, proxy_url, status, status_reason,
          tier, exit_ip, exit_country, concurrency_limit, active_workers,
          last_verified_at, quota_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          email = excluded.email,
          source = excluded.source,
          home_dir = excluded.home_dir,
          proxy_url = excluded.proxy_url,
          status = excluded.status,
          status_reason = excluded.status_reason,
          tier = excluded.tier,
          exit_ip = excluded.exit_ip,
          exit_country = excluded.exit_country,
          concurrency_limit = excluded.concurrency_limit,
          active_workers = excluded.active_workers,
          last_verified_at = excluded.last_verified_at,
          quota_json = excluded.quota_json,
          updated_at = excluded.updated_at`
      )
      .run(
        account.id,
        account.label,
        account.email,
        account.source,
        account.homeDir,
        account.proxyUrl,
        account.status,
        account.statusReason,
        account.tier,
        account.exitIp,
        account.exitCountry,
        account.concurrencyLimit,
        account.activeWorkers,
        account.lastVerifiedAt,
        quotaJson,
        account.createdAt,
        account.updatedAt
      );
  }

  deleteAccount(id: string): boolean {
    const res = this.db.query('DELETE FROM accounts WHERE id = ?').run(id);
    return res.changes > 0;
  }

  // --------------------------------------------------------------------------
  // Cooldowns CRUD
  // --------------------------------------------------------------------------

  listCooldowns(nowMs = Date.now()): CooldownRecord[] {
    const rows = this.db
      .query<CooldownRow, [number]>(
        'SELECT * FROM cooldowns WHERE until_ms > ? ORDER BY until_ms ASC'
      )
      .all(nowMs);
    return rows.map(rowToCooldown);
  }

  upsertCooldown(cd: CooldownRecord): void {
    this.db
      .query(
        `INSERT INTO cooldowns (
          account_id, family, scope_type, reason, until_ms, consecutive_failures, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, family, scope_type) DO UPDATE SET
          reason = excluded.reason,
          until_ms = excluded.until_ms,
          consecutive_failures = excluded.consecutive_failures,
          last_error = excluded.last_error`
      )
      .run(
        cd.accountId,
        cd.family,
        cd.scopeType,
        cd.reason,
        cd.untilMs,
        cd.consecutiveFailures,
        cd.lastError
      );
  }

  deleteCooldown(accountId: string, family: string, scopeType: string): boolean {
    const res = this.db
      .query('DELETE FROM cooldowns WHERE account_id = ? AND family = ? AND scope_type = ?')
      .run(accountId, family, scopeType);
    return res.changes > 0;
  }

  pruneExpiredCooldowns(nowMs = Date.now()): number {
    const res = this.db.query('DELETE FROM cooldowns WHERE until_ms <= ?').run(nowMs);
    return res.changes;
  }

  // --------------------------------------------------------------------------
  // Request Logs CRUD
  // --------------------------------------------------------------------------

  upsertRequestLog(log: RequestLog): void {
    this.db
      .query(
        `INSERT INTO request_logs (
          id, model, family, endpoint, stream, state, http_status,
          started_at, duration_ms, switch_count, input_tokens, output_tokens, cache_hit, cached_tokens, attempts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          http_status = excluded.http_status,
          duration_ms = excluded.duration_ms,
          switch_count = excluded.switch_count,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_hit = excluded.cache_hit,
          cached_tokens = excluded.cached_tokens,
          attempts_json = excluded.attempts_json`
      )
      .run(
        log.id,
        log.model,
        log.family,
        log.endpoint,
        log.stream ? 1 : 0,
        log.state,
        log.httpStatus ?? null,
        log.startedAt,
        log.durationMs ?? null,
        log.switchCount,
        log.inputTokens ?? null,
        log.outputTokens ?? null,
        log.cacheHit === undefined ? null : log.cacheHit ? 1 : 0,
        log.cachedTokens ?? null,
        JSON.stringify(log.attempts)
      );
  }

  getRecentRequestLogs(limit = 100): RequestLog[] {
    const rows = this.db
      .query<RequestLogRow, [number]>(
        'SELECT * FROM request_logs ORDER BY started_at DESC LIMIT ?'
      )
      .all(limit);
    return rows.map(rowToRequestLog);
  }

  pruneOldRequestLogs(maxRetained: number): number {
    if (maxRetained <= 0) return 0;
    const res = this.db
      .query(
        `DELETE FROM request_logs
         WHERE id NOT IN (
           SELECT id FROM request_logs ORDER BY started_at DESC LIMIT ?
         )`
      )
      .run(maxRetained);
    return res.changes;
  }

  // --------------------------------------------------------------------------
  // Config KV CRUD
  // --------------------------------------------------------------------------

  getConfigValue<T>(key: string): T | null {
    const row = this.db
      .query<ConfigKvRow, [string]>('SELECT * FROM config_kv WHERE key = ?')
      .get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  setConfigValue<T>(key: string, value: T): void {
    this.db
      .query(
        `INSERT INTO config_kv (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  getAllConfigValues(): Record<string, unknown> {
    const rows = this.db.query<ConfigKvRow, []>('SELECT * FROM config_kv').all();
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value_json);
      } catch {
        // ignore malformed json
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Sticky Affinity CRUD
  // --------------------------------------------------------------------------

  loadStickyAffinities(
    maxAgeMs = 30 * 24 * 60 * 60 * 1000,
    limit = 4096,
    nowMs = Date.now()
  ): StickyAffinityRecord[] {
    const cutoff = nowMs - maxAgeMs;
    const rows = this.db
      .query<StickyAffinityRow, [number, number]>(
        `SELECT * FROM sticky_affinity
         WHERE last_used_at >= ?
         ORDER BY last_used_at DESC
         LIMIT ?`
      )
      .all(cutoff, limit);
    return rows.map(rowToStickyAffinity);
  }

  upsertStickyAffinity(record: StickyAffinityRecord): void {
    this.db
      .query(
        `INSERT INTO sticky_affinity (
          sticky_key, account_id, last_used_at, cached_tokens, cache_written_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sticky_key) DO UPDATE SET
          account_id = excluded.account_id,
          last_used_at = excluded.last_used_at,
          cached_tokens = excluded.cached_tokens,
          cache_written_at = excluded.cache_written_at`
      )
      .run(
        record.stickyKey,
        record.accountId,
        record.lastUsedAt,
        record.cachedTokens,
        record.cacheWrittenAt
      );
  }

  deleteStickyAffinity(stickyKey: string): boolean {
    const res = this.db
      .query('DELETE FROM sticky_affinity WHERE sticky_key = ?')
      .run(stickyKey);
    return res.changes > 0;
  }

  pruneStickyAffinities(
    maxAgeMs = 30 * 24 * 60 * 60 * 1000,
    maxRows = 4096,
    nowMs = Date.now()
  ): number {
    const cutoff = nowMs - maxAgeMs;
    const expired = this.db
      .query('DELETE FROM sticky_affinity WHERE last_used_at < ?')
      .run(cutoff);
    let excessChanges = 0;
    if (maxRows > 0) {
      const excess = this.db
        .query(
          `DELETE FROM sticky_affinity
           WHERE sticky_key NOT IN (
             SELECT sticky_key FROM sticky_affinity ORDER BY last_used_at DESC LIMIT ?
           )`
        )
        .run(maxRows);
      excessChanges = excess.changes;
    }
    return expired.changes + excessChanges;
  }

  // --------------------------------------------------------------------------
  // ACP Sessions CRUD (cross-restart session/resume persistence)
  // --------------------------------------------------------------------------

  getAcpSession(
    stickyKey: string,
    nowMs = Date.now(),
    ttlMs = DEFAULT_ACP_SESSION_TTL_MS
  ): AcpSessionRecord | null {
    const row = this.db
      .query<AcpSessionRow, [string]>('SELECT * FROM acp_sessions WHERE sticky_key = ?')
      .get(stickyKey);
    if (!row) return null;
    if (nowMs - row.updated_at > ttlMs) {
      this.deleteAcpSession(stickyKey);
      return null;
    }
    const record = rowToAcpSession(row);
    if (!record) {
      this.deleteAcpSession(stickyKey);
      return null;
    }
    return record;
  }

  upsertAcpSession(record: AcpSessionRecord): void {
    this.db
      .query(
        `INSERT INTO acp_sessions (
          sticky_key, session_id, account_id, model, system_hash, tools_hash, committed_hashes_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sticky_key) DO UPDATE SET
          session_id = excluded.session_id,
          account_id = excluded.account_id,
          model = excluded.model,
          system_hash = excluded.system_hash,
          tools_hash = excluded.tools_hash,
          committed_hashes_json = excluded.committed_hashes_json,
          updated_at = excluded.updated_at`
      )
      .run(
        record.stickyKey,
        record.sessionId,
        record.accountId,
        record.model,
        record.systemHash,
        record.toolsHash,
        JSON.stringify(record.committedHashes),
        record.updatedAt
      );
  }

  deleteAcpSession(stickyKey: string): boolean {
    const res = this.db
      .query('DELETE FROM acp_sessions WHERE sticky_key = ?')
      .run(stickyKey);
    return res.changes > 0;
  }

  pruneAcpSessions(ttlMs = DEFAULT_ACP_SESSION_TTL_MS, nowMs = Date.now()): number {
    const cutoff = nowMs - ttlMs;
    const res = this.db.query('DELETE FROM acp_sessions WHERE updated_at < ?').run(cutoff);
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}

export const store = new GatewayStore();
