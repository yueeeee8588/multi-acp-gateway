import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopbackMcpServer } from "../src/acp/loopback-mcp";
import { AgySessionWorker, type AcpTransportFactory } from "../src/acp/worker";
import {
  decodeGenerationUsage,
  decodeStepUsage,
  decodeUsage,
  isStepUsageEnabled,
  modelUsageAfter,
  modelUsageCursor,
  sessionDbPath,
  sumStepUsage,
} from "../src/acp/step-usage";
import type { AccountRecord, GeminiGenerateRequest } from "../src/types";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function encodeVarintField(field: number, value: number): Uint8Array {
  return new Uint8Array([...encodeVarint((field << 3) | 0), ...encodeVarint(value)]);
}

function encodeBytesField(field: number, payload: Uint8Array): Uint8Array {
  const header = [...encodeVarint((field << 3) | 2), ...encodeVarint(payload.length)];
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function buildUsageBytes(u: {
  input?: number;
  output?: number;
  write?: number;
  read?: number;
  thinking?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (u.input !== undefined) parts.push(encodeVarintField(2, u.input));
  if (u.output !== undefined) parts.push(encodeVarintField(3, u.output));
  if (u.write !== undefined) parts.push(encodeVarintField(4, u.write));
  if (u.read !== undefined) parts.push(encodeVarintField(5, u.read));
  if (u.thinking !== undefined) parts.push(encodeVarintField(9, u.thinking));
  return concatBytes(...parts);
}

function buildStepMetadata(u: {
  input?: number;
  output?: number;
  write?: number;
  read?: number;
  thinking?: number;
}): Uint8Array {
  return encodeBytesField(9, buildUsageBytes(u));
}

function buildGenMetadataData(opts: {
  usage?: {
    input?: number;
    output?: number;
    write?: number;
    read?: number;
    thinking?: number;
  };
  context?: number;
}): Uint8Array {
  const chatParts: Uint8Array[] = [];
  if (opts.usage) {
    chatParts.push(encodeBytesField(4, buildUsageBytes(opts.usage)));
  }
  if (opts.context !== undefined) {
    const start = encodeVarintField(1, opts.context);
    const sub10 = encodeBytesField(10, start);
    chatParts.push(encodeBytesField(9, sub10));
  }
  return encodeBytesField(1, concatBytes(...chatParts));
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-usage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("step-usage path and env helpers", () => {
  test("resolves multi-account sessionDbPath from homeDir and supports override", () => {
    const home = path.join("C:", "agy-accounts", "acc1");
    expect(sessionDbPath("sess_123", home, {})).toBe(
      path.join(home, ".gemini", "antigravity-cli", "conversations", "sess_123.db"),
    );
    expect(
      sessionDbPath("sess_123", home, {
        AGY_8048_CONVERSATIONS_DIR: path.join("D:", "custom-conv"),
      }),
    ).toBe(path.join("D:", "custom-conv", "sess_123.db"));
    expect(sessionDbPath("../escape", home, {})).toBeNull();
    expect(sessionDbPath("", home, {})).toBeNull();
  });

  test("isStepUsageEnabled defaults to true and disables on '0'", () => {
    expect(isStepUsageEnabled({})).toBe(true);
    expect(isStepUsageEnabled({ AGY_8048_STEP_USAGE: "1" })).toBe(true);
    expect(isStepUsageEnabled({ AGY_8048_STEP_USAGE: "0" })).toBe(false);
  });
});

describe("step-usage protobuf decoders", () => {
  test("decodeUsage, decodeStepUsage, decodeGenerationUsage decode all fields", () => {
    const usageInput = { input: 120, output: 45, write: 10, read: 800, thinking: 30 };
    expect(decodeUsage(buildUsageBytes(usageInput))).toEqual(usageInput);
    expect(decodeStepUsage(buildStepMetadata(usageInput))).toEqual(usageInput);
    expect(
      decodeGenerationUsage(buildGenMetadataData({ usage: usageInput, context: 4096 })),
    ).toEqual({
      ...usageInput,
      context: 4096,
    });
  });

  test("decodeGenerationUsage returns null when only pre-send context estimate is present", () => {
    expect(decodeGenerationUsage(buildGenMetadataData({ context: 2048 }))).toBeNull();
  });

  test("malformed or truncated protobuf safely returns null", () => {
    expect(decodeStepUsage(null)).toBeNull();
    expect(decodeStepUsage("not-bytes")).toBeNull();
    // truncated varint
    expect(decodeUsage(new Uint8Array([0x80]))).toBeNull();
    // invalid wire type 6 (tag = (1 << 3) | 6 = 14)
    expect(decodeUsage(new Uint8Array([14]))).toBeNull();
    // length-delimited field overflowing buffer
    expect(decodeStepUsage(new Uint8Array([(9 << 3) | 2, 10, 1, 2]))).toBeNull();
    expect(decodeGenerationUsage(new Uint8Array([(1 << 3) | 2, 20, 1]))).toBeNull();
  });
});

describe("step-usage SQLite cursor and incremental queries", () => {
  test("gen_metadata table: cursor pinning, pending state, anti-double-billing, and WAL side-effect-free read", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "gen-session.db");

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
    `);

    const gen0 = buildGenMetadataData({
      usage: { input: 100, output: 50, write: 0, read: 500, thinking: 20 },
    });
    const step0 = buildStepMetadata({
      input: 100,
      output: 50,
      write: 0,
      read: 500,
      thinking: 20,
    });
    db.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [0, gen0]);
    db.run("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)", [
      0,
      step0,
    ]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close(true);

    // Checkpointed WAL should have no -wal/-shm sidecars remaining after close
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`);
    }

    const cursor1 = modelUsageCursor(dbPath);
    expect(cursor1).toEqual({ source: null, idx: 0, generationIdx: 0 });
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    // Write a pre-send context-only row (pending) and a matching steps row
    const db2 = new Database(dbPath);
    db2.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [
      1,
      buildGenMetadataData({ context: 1024 }),
    ]);
    db2.close(true);

    const pendingRes = modelUsageAfter(dbPath, cursor1);
    expect(pendingRes).toEqual({ source: "gen_metadata", steps: [], pending: true });

    // Now complete generation 1 and 2, plus a duplicate step row in steps
    const db3 = new Database(dbPath);
    db3.run("UPDATE gen_metadata SET data = ? WHERE idx = 1", [
      buildGenMetadataData({
        usage: { input: 60, output: 30, write: 10, read: 700, thinking: 15 },
        context: 1024,
      }),
    ]);
    db3.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [
      2,
      buildGenMetadataData({
        usage: { input: 40, output: 20, write: 0, read: 800, thinking: 5 },
      }),
    ]);
    db3.run("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)", [
      1,
      buildStepMetadata({ input: 60, output: 30, write: 10, read: 700, thinking: 15 }),
    ]);
    db3.close(true);

    const res1 = modelUsageAfter(dbPath, cursor1);
    expect(res1?.source).toBe("gen_metadata");
    expect(res1?.pending).toBeUndefined();
    expect(res1?.steps.length).toBe(2);
    expect(sumStepUsage(res1!.steps)).toEqual({
      input: 100,
      output: 50,
      write: 10,
      read: 1500,
      thinking: 20,
    });

    // Advance cursor: next read yields empty steps and never double-bills from steps table
    const cursor2 = modelUsageCursor(dbPath);
    expect(cursor2).toEqual({ source: null, idx: 1, generationIdx: 2 });
    expect(modelUsageAfter(dbPath, cursor2)?.steps).toEqual([]);
  });

  test("legacy steps table: fallback when gen_metadata is absent and ignores non-model/incomplete steps", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "legacy-steps.db");

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
    `);
    db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)").run(
      0,
      buildStepMetadata({ input: 10, output: 20, write: 0, read: 30, thinking: 5 }),
    );
    db.close();

    const cursor = modelUsageCursor(dbPath);
    expect(cursor).toEqual({ source: "steps", idx: 0 });

    const db2 = new Database(dbPath);
    // non-model step (step_type=4) -> ignored
    db2
      .prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 4, 3, ?)")
      .run(1, buildStepMetadata({ input: 999, output: 999 }));
    // incomplete model step (status=1) -> ignored
    db2
      .prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 1, ?)")
      .run(2, buildStepMetadata({ input: 888, output: 888 }));
    // completed model step -> included
    db2
      .prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)")
      .run(3, buildStepMetadata({ input: 50, output: 25, write: 5, read: 200, thinking: 12 }));
    db2.close();

    const res = modelUsageAfter(dbPath, cursor);
    expect(res).toEqual({
      source: "steps",
      steps: [{ idx: 3, input: 50, output: 25, write: 5, read: 200, thinking: 12 }],
    });

    const nextCursor = modelUsageCursor(dbPath);
    expect(nextCursor).toEqual({ source: "steps", idx: 3 });
    expect(modelUsageAfter(dbPath, nextCursor)).toEqual({ source: "steps", steps: [] });
  });

  test("missing or corrupted sqlite file safely returns null", () => {
    const dir = makeTempDir();
    const missingPath = path.join(dir, "missing.db");
    const missingCursor = modelUsageCursor(missingPath);
    expect(missingCursor).toEqual({ source: null, idx: -1, generationIdx: -1 });
    expect(modelUsageAfter(missingPath, missingCursor)).toBeNull();

    const corruptPath = path.join(dir, "corrupt.db");
    fs.writeFileSync(corruptPath, "this is not a sqlite database");
    expect(modelUsageCursor(corruptPath)).toBeNull();
    expect(modelUsageAfter(corruptPath, { source: "gen_metadata", idx: -1 })).toBeNull();
  });
});

describe("AgySessionWorker persistent step-usage cursor", () => {
  test("does not skip pending row on delayed flush, recovers it on next turn, and resets on resetAndClose", async () => {
    const homeDir = makeTempDir();
    const workspaceDir = makeTempDir();
    const sessionId = "sess_delayed_flush_1";
    const dbFile = sessionDbPath(sessionId, homeDir);
    expect(dbFile).not.toBeNull();
    fs.mkdirSync(path.dirname(dbFile!), { recursive: true });

    const db = new Database(dbFile!);
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
    `);
    db.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [
      0,
      buildGenMetadataData({
        usage: { input: 10, output: 5, write: 0, read: 50, thinking: 1 },
      }),
    ]);
    db.close(true);

    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let turn = 0;
    const factory: AcpTransportFactory = (opts) => {
      return {
        async initialize() {
          return {};
        },
        async newSession() {
          return {
            sessionId,
            models: { currentModelId: "gemini-4-hydrogen-medium" },
          };
        },
        async prompt() {
          turn += 1;
          if (turn === 1) {
            // Turn 1: only pre-send context row is written before prompt resolves (delayed usage flush)
            const d = new Database(dbFile!);
            d.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [
              1,
              buildGenMetadataData({ context: 2048 }),
            ]);
            d.close(true);
            opts.onUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "turn1" },
              },
            });
            return {
              stopReason: "end_turn",
              usage: {
                inputTokens: 100,
                outputTokens: 10,
                cachedReadTokens: 0,
                cachedWriteTokens: 0,
                thoughtTokens: 0,
                totalTokens: 110,
              },
            };
          }

          if (turn === 2) {
            // Turn 2: turn 1's delayed row (idx=1) flushes alongside turn 2's row (idx=2)
            const d = new Database(dbFile!);
            d.run("UPDATE gen_metadata SET data = ? WHERE idx = 1", [
              buildGenMetadataData({
                usage: { input: 60, output: 30, write: 15, read: 700, thinking: 10 },
                context: 2048,
              }),
            ]);
            d.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [
              2,
              buildGenMetadataData({
                usage: { input: 40, output: 20, write: 5, read: 300, thinking: 5 },
              }),
            ]);
            d.close(true);
            opts.onUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "turn2" },
              },
            });
            return { stopReason: "end_turn" };
          }

          // Turn 3 (after resetAndClose): only idx=3 is new
          const d = new Database(dbFile!);
          d.run("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", [
            3,
            buildGenMetadataData({
              usage: { input: 12, output: 6, write: 0, read: 80, thinking: 2 },
            }),
          ]);
          d.close(true);
          opts.onUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "turn3" },
            },
          });
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        async close() {},
        isAlive: () => true,
      };
    };

    const account: AccountRecord = {
      id: "acc-step-test",
      label: "step@example.com",
      email: "step@example.com",
      source: "test",
      homeDir,
      proxyUrl: "",
      status: "ready",
      tier: "pro",
      statusReason: "",
      exitIp: "127.0.0.1",
      exitCountry: "JP",
      concurrencyLimit: 1,
      activeWorkers: 0,
      lastVerifiedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const worker = new AgySessionWorker({
      account,
      model: "gemini-4-hydrogen-medium",
      mcpServer,
      workspaceDir,
      transportFactory: factory,
    });

    try {
      const req1: GeminiGenerateRequest = {
        contents: [{ role: "user", parts: [{ text: "hello 1" }] }],
      };
      const res1 = await worker.executePrompt(req1);
      // Turn 1 timed out waiting for pending idx=1 -> falls back to ACP usage, cursor stays at idx=0
      expect(res1.usageMetadata?.promptTokenCount).toBe(100);

      const req2: GeminiGenerateRequest = {
        contents: [
          { role: "user", parts: [{ text: "hello 1" }] },
          { role: "model", parts: [{ text: "turn1" }] },
          { role: "user", parts: [{ text: "hello 2" }] },
        ],
      };
      const res2 = await worker.executePrompt(req2);
      // Turn 2 recovers delayed idx=1 + idx=2
      expect(res2.usageMetadata).toEqual({
        promptTokenCount: 1100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 15,
        totalTokenCount: 1185,
        cachedContentTokenCount: 1000,
        cacheCreationTokenCount: 20,
      });

      await worker.resetAndClose();

      const req3: GeminiGenerateRequest = {
        contents: [{ role: "user", parts: [{ text: "hello 3" }] }],
      };
      const res3 = await worker.executePrompt(req3);
      expect(res3.usageMetadata).toEqual({
        promptTokenCount: 92,
        candidatesTokenCount: 6,
        thoughtsTokenCount: 2,
        totalTokenCount: 100,
        cachedContentTokenCount: 80,
      });
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });
});
