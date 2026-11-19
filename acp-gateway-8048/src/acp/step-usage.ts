// Per-model-call usage from agy's local conversation store.
// Adapted from DylanLIiii/opencode-antigravity-bridge (step-usage.mjs) &
// magpie-community/plugins packages/agy-cli at b829a5541ecc0790b05a63308447bf87e952efbe.
// MIT; Copyright (c) 2026 DylanLIiii, gitxm, yce.
//
// ACP reports usage once, accumulated over a whole session/prompt. Prefer
// `gen_metadata`, written when generation ends, before client tools return.
// Older stores record each completed model call in table `steps`, with
// step_type 15 and status 3 (done), the counts in Protobuf field 9 of
// `metadata` (2 uncached input, 3 output, 4 cache write, 5 cache read,
// 9 thinking). Summed over a prompt they equal the ACP total exactly.
// Any failure here returns null and the caller keeps its estimate.

import { Database, constants } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODEL_STEP = 15;
const STEP_DONE = 3;

export interface StepUsageCounts {
  input: number;
  output: number;
  write: number;
  read: number;
  thinking: number;
}

export interface StepUsageEntry extends StepUsageCounts {
  idx: number;
  context?: number;
}

export type ModelUsageCursor =
  | { source: "gen_metadata"; idx: number }
  | { source: "steps"; idx: number }
  | { source: null; idx: number; generationIdx: number };

export interface ModelUsageResult {
  source: "gen_metadata" | "steps";
  steps: StepUsageEntry[];
  pending?: boolean;
}

interface SqliteReader {
  all: (sql: string, ...args: unknown[]) => Array<Record<string, unknown>>;
  close: () => void;
}

export function isStepUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGY_8048_STEP_USAGE !== "0";
}

export function conversationsDir(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.AGY_8048_CONVERSATIONS_DIR?.trim();
  if (override) return override;
  const baseHome = homeDir?.trim() || os.homedir();
  if (!baseHome) return null;
  return path.join(baseHome, ".gemini", "antigravity-cli", "conversations");
}

export function sessionDbPath(
  sessionId: string | null | undefined,
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) return null;
  const dir = conversationsDir(homeDir, env);
  if (!dir) return null;
  return path.join(dir, `${sessionId}.db`);
}

function openReadOnlySqlite(target: string): SqliteReader {
  // Bun's bundled SQLite on Linux/Windows disables URI filenames unless SQLITE_OPEN_URI is passed.
  const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
  const db = new Database(target, flags);
  return {
    all: (sql: string, ...args: unknown[]) => {
      const stmt = db.prepare(sql);
      try {
        return stmt.all(...(args as never[])) as Array<Record<string, unknown>>;
      } finally {
        stmt.finalize();
      }
    },
    close: () => db.close(),
  };
}

function varint(buf: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    const byte = buf[at + i];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
    scale *= 128;
  }
  return null;
}

// Calls fn(field, wire, value | bytes) for each field; false on malformed input.
function walk(
  buf: Uint8Array,
  fn: (field: number, wire: number, value: number | Uint8Array) => void,
): boolean {
  let at = 0;
  while (at < buf.length) {
    const tag = varint(buf, at);
    if (!tag || tag.value < 8) return false;
    at = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const item = varint(buf, at);
      if (!item) return false;
      at = item.next;
      fn(field, wire, item.value);
    } else if (wire === 2) {
      const len = varint(buf, at);
      if (!len || len.next + len.value > buf.length) return false;
      fn(field, wire, buf.subarray(len.next, len.next + len.value));
      at = len.next + len.value;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > buf.length) return false;
    } else {
      return false;
    }
  }
  return true;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

function toUint8Array(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

export function decodeUsage(buf: Uint8Array): StepUsageCounts | null {
  const usage: StepUsageCounts = { input: 0, output: 0, write: 0, read: 0, thinking: 0 };
  const ok = walk(buf, (field, wire, n) => {
    if (wire !== 0) return;
    if (field === 2) usage.input = count(n);
    else if (field === 3) usage.output = count(n);
    else if (field === 4) usage.write = count(n);
    else if (field === 5) usage.read = count(n);
    else if (field === 9) usage.thinking = count(n);
  });
  return ok ? usage : null;
}

export function decodeStepUsage(metadata: unknown): StepUsageCounts | null {
  const buf = toUint8Array(metadata);
  if (!buf) return null;
  let stats: StepUsageCounts | null = null;
  const ok = walk(buf, (field, wire, value) => {
    if (field !== 9 || wire !== 2 || !(value instanceof Uint8Array)) return;
    stats = decodeUsage(value);
  });
  return ok ? stats : null;
}

// gen_metadata.data contains the same usage message at field 1 -> 4.
// Its pre-send local context estimate is separate, at 1 -> 9 -> 10 -> 1.
// A context estimate alone is not a completed, billed model call.
export function decodeGenerationUsage(
  data: unknown,
): (StepUsageCounts & { context?: number }) | null {
  const buf = toUint8Array(data);
  if (!buf) return null;
  let stats: StepUsageCounts | null = null;
  let context: number | null = null;
  let valid = true;
  const ok = walk(buf, (field, wire, chat) => {
    if (field !== 1 || wire !== 2 || !(chat instanceof Uint8Array)) return;
    valid =
      walk(chat, (sub, subWire, value) => {
        if (subWire !== 2 || !(value instanceof Uint8Array)) return;
        if (sub === 4) {
          stats = decodeUsage(value);
          if (!stats) valid = false;
        } else if (sub === 9) {
          if (
            !walk(value, (key, kind, start) => {
              if (key !== 10 || kind !== 2 || !(start instanceof Uint8Array)) return;
              if (
                !walk(start, (k, w, n) => {
                  if (k === 1 && w === 0) context = count(n);
                })
              ) {
                valid = false;
              }
            })
          ) {
            valid = false;
          }
        }
      }) && valid;
  });
  if (!ok || !valid || !stats) return null;
  const result: StepUsageCounts & { context?: number } = { ...(stats as StepUsageCounts) };
  if (context !== null) result.context = context;
  return result;
}

function runReadOnly<T>(target: string, fn: (db: SqliteReader) => T): T {
  let db: SqliteReader | undefined;
  try {
    db = openReadOnlySqlite(target);
    return fn(db);
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function tableQuery(
  db: SqliteReader,
  sql: string,
  ...args: unknown[]
): Array<Record<string, unknown>> | null {
  try {
    return db.all(sql, ...args);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error ?? "");
    if (/no such table|no such column/i.test(msg)) return null;
    throw error;
  }
}

function isCheckpointedWal(file: string): boolean {
  if (
    fs.existsSync(`${file}-wal`) ||
    fs.existsSync(`${file}-shm`) ||
    fs.existsSync(`${file}-journal`)
  ) {
    return false;
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const header = new Uint8Array(20);
    if (fs.readSync(fd, header, 0, 20, 0) < 20) return false;
    return header[18] === 2 && header[19] === 2;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function resolveStorePath(file: string | null | undefined): string | null {
  if (typeof file !== "string" || !file || file.includes("\0")) return null;
  return path.resolve(file);
}

// SQLite rejects non-localhost URI authorities (`file://server/share/...`) unless
// compiled with SQLITE_ALLOW_URI_AUTHORITY, strips `localhost` from `\\localhost\...`,
// and pathToFileURL rejects `\\?\...` extended paths. Prefixing Windows `\\...` paths
// directly after `file:` (with `%`, `?`, `#`, space percent-encoded) avoids any
// `//authority` segment so sqlite3ParseUri hands the exact `\\...` path to winOpen.
function immutableUri(resolved: string): string {
  if (process.platform === "win32" && resolved.startsWith("\\\\")) {
    const encoded = resolved.replace(
      /[%?# ]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );
    return `file:${encoded}?immutable=1`;
  }
  return `${pathToFileURL(resolved).href}?immutable=1`;
}

// When a WAL-flagged store (header bytes 18..19 = 2, 2) has neither -wal nor
// -shm on disk, no writer holds it open, yet SQLITE_OPEN_READONLY fails with
// SQLITE_CANTOPEN under Apple's libsqlite3 on macOS and creates -wal/-shm
// sidecars under upstream SQLite. Opening with ?immutable=1 keeps that closed
// WAL read strictly side-effect-free; if -wal appears concurrently, re-read
// once against the resolved live file path (never a relative `file:...` string).
function withStore<T>(
  file: string | null | undefined,
  fn: (db: SqliteReader) => T | null,
): T | null {
  const resolved = resolveStorePath(file);
  if (!resolved || !fs.existsSync(resolved)) return null;
  if (isCheckpointedWal(resolved)) {
    try {
      const result = runReadOnly(immutableUri(resolved), fn);
      if (!fs.existsSync(`${resolved}-wal`)) return result;
    } catch {
      if (!fs.existsSync(`${resolved}-wal`)) return null;
    }
  }
  try {
    return runReadOnly(resolved, fn);
  } catch {
    return null;
  }
}

function maxCompletedStep(db: SqliteReader): number | null {
  const rows = tableQuery(
    db,
    `SELECT COALESCE(MAX(idx), -1) AS idx FROM steps WHERE step_type = ${MODEL_STEP} AND status = ${STEP_DONE}`,
  );
  const idx = Number(rows?.[0]?.idx);
  return Number.isSafeInteger(idx) ? idx : null;
}

function stepsAfter(db: SqliteReader, afterIdx: number): StepUsageEntry[] | null {
  const rows = tableQuery(
    db,
    `SELECT idx, metadata FROM steps WHERE step_type = ${MODEL_STEP} AND status = ${STEP_DONE} AND idx > ? ORDER BY idx`,
    afterIdx,
  );
  if (!rows) return null;
  const steps: StepUsageEntry[] = [];
  for (const row of rows) {
    const idx = Number(row.idx);
    const usage = decodeStepUsage(row.metadata);
    if (!Number.isSafeInteger(idx) || !usage) continue;
    steps.push({ idx, ...usage });
  }
  return steps;
}

// Highest completed model-call index, -1 for an empty or missing store, null
// when the store exists but cannot be read.
export function lastModelStep(file: string | null | undefined): number | null {
  const resolved = resolveStorePath(file);
  if (!resolved) return null;
  if (!fs.existsSync(resolved)) return -1;
  return withStore(resolved, (db) => maxCompletedStep(db));
}

// Local sibling safety checks need the highest row including pending rows.
export function latestModelStep(file: string | null | undefined): number | null {
  if (!file) return null;
  if (!fs.existsSync(file)) return -1;
  return withStore(file, (db) => {
    const rows = tableQuery(
      db,
      `SELECT COALESCE(MAX(idx), -1) AS idx FROM steps WHERE step_type = ${MODEL_STEP}`,
    );
    const idx = Number(rows?.[0]?.idx);
    return Number.isSafeInteger(idx) ? idx : null;
  });
}

export function latestGenerationIdx(file: string | null | undefined): number | null {
  if (!file) return null;
  if (!fs.existsSync(file)) return -1;
  return withStore(file, (db) => {
    const rows = tableQuery(db, "SELECT COALESCE(MAX(idx), -1) AS idx FROM gen_metadata");
    const idx = Number(rows?.[0]?.idx);
    return Number.isSafeInteger(idx) ? idx : null;
  });
}

// Completed model calls after `afterIdx`, oldest first: [{ idx, input, output, write, read, thinking }].
export function modelStepsAfter(
  file: string | null | undefined,
  afterIdx: number,
): StepUsageEntry[] | null {
  return withStore(file, (db) => stepsAfter(db, afterIdx));
}

// Pin a turn to one table. Reading both tables for a turn would bill the same
// generation twice. A new store is discovered after its first generation.
export function modelUsageCursor(file: string | null | undefined): ModelUsageCursor | null {
  const resolved = resolveStorePath(file);
  if (!resolved) return null;
  if (!fs.existsSync(resolved)) return { source: null, idx: -1, generationIdx: -1 };
  return withStore(resolved, (db) => {
    const genRows = tableQuery(db, "SELECT COALESCE(MAX(idx), -1) AS idx FROM gen_metadata");
    const generationIdx = Number(genRows?.[0]?.idx);
    const step = maxCompletedStep(db);
    if (Number.isSafeInteger(generationIdx)) {
      return step === null
        ? { source: "gen_metadata", idx: generationIdx }
        : { source: null, idx: step, generationIdx };
    }
    return step === null ? null : { source: "steps", idx: step };
  });
}

export function modelUsageAfter(
  file: string | null | undefined,
  cursor: ModelUsageCursor | null | undefined,
): ModelUsageResult | null {
  if (!cursor) return null;
  return withStore(file, (db) => {
    if (cursor.source !== "steps") {
      const after = cursor.source === "gen_metadata" ? cursor.idx : cursor.generationIdx;
      const rows = tableQuery(
        db,
        "SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx",
        after,
      );
      if (rows) {
        const steps: StepUsageEntry[] = [];
        let pending = false;
        for (const row of rows) {
          const idx = Number(row.idx);
          const usage = decodeGenerationUsage(row.data);
          if (!Number.isSafeInteger(idx)) return null;
          // Failed generations and pre-send estimates carry no billing counters.
          if (
            !usage ||
            !(usage.input + usage.read + usage.write + usage.output + usage.thinking)
          ) {
            pending = true;
            continue;
          }
          pending = false;
          steps.push({ idx, ...usage });
        }
        if (steps.length || pending || cursor.source === "gen_metadata") {
          return {
            source: "gen_metadata",
            steps,
            ...(pending ? { pending: true } : {}),
          };
        }
      }
      if (cursor.source === "gen_metadata") return null;
    }
    const steps = stepsAfter(db, cursor.idx);
    return steps === null ? null : { source: "steps", steps };
  });
}

export function sumStepUsage(steps: StepUsageCounts[]): StepUsageCounts {
  const total: StepUsageCounts = { input: 0, output: 0, write: 0, read: 0, thinking: 0 };
  for (const s of steps) {
    total.input += s.input;
    total.output += s.output;
    total.write += s.write;
    total.read += s.read;
    total.thinking += s.thinking;
  }
  return total;
}
