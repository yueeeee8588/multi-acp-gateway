import { describe, expect, test } from "bun:test";
import { LoopbackMcpServer } from "../src/acp/loopback-mcp";
import {
  AgySessionWorker,
  WorkerError,
  type AcpTransport,
} from "../src/acp/worker";
import type { AccountRecord } from "../src/types";

function makeAccount(id = "warm-reuse-acc"): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: id,
    email: `${id}@example.com`,
    source: "test",
    homeDir: "unused",
    proxyUrl: "",
    status: "ready",
    statusReason: "",
    tier: "standard",
    exitIp: "127.0.0.1",
    exitCountry: "JP",
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function extractPromptTexts(promptBlocks: unknown): string[] {
  if (!Array.isArray(promptBlocks)) return [];
  return promptBlocks
    .map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .filter((t) => t.length > 0);
}

describe("AgySessionWorker warm-reuse dedup & promptToFirstEventMs / idle watchdog", () => {
  test("1. R1 -> R2 -> R3 warm reuse strips already-committed [model] turns so R2/R3 send items=1", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const capturedPrompts: Array<Array<Record<string, unknown>>> = [];
    let turn = 0;

    const worker = new AgySessionWorker({
      account: makeAccount("dedup-3-turns"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-dedup-3" }),
        setModel: async () => ({}),
        prompt: async (params) => {
          turn++;
          capturedPrompts.push(params.prompt as Array<Record<string, unknown>>);
          if (turn === 1) {
            onUpdate({
              sessionId: "sess-dedup-3",
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: "internal reasoning 1" },
              },
            });
            onUpdate({
              sessionId: "sess-dedup-3",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Answer " },
              },
            });
            onUpdate({
              sessionId: "sess-dedup-3",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "One" },
              },
            });
          } else if (turn === 2) {
            onUpdate({
              sessionId: "sess-dedup-3",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Answer Two" },
              },
            });
          } else {
            onUpdate({
              sessionId: "sess-dedup-3",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Answer Three" },
              },
            });
          }
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      // R1: [U1]
      const res1 = await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "Question 1" }] }],
      });
      expect(res1.timings?.coldStart).toBe(true);
      expect(capturedPrompts).toHaveLength(1);
      expect(capturedPrompts[0]).toHaveLength(1);
      expect(extractPromptTexts(capturedPrompts[0]).join("\n")).toContain("Question 1");

      // R2: [U1, A1, U2] -> warm reuse, strips A1, sends only [U2]
      const res2 = await worker.executePrompt({
        contents: [
          { role: "user", parts: [{ text: "Question 1" }] },
          { role: "model", parts: [{ text: "Answer One" }] },
          { role: "user", parts: [{ text: "Question 2" }] },
        ],
      });
      expect(res2.timings?.coldStart).toBe(false);
      expect(capturedPrompts).toHaveLength(2);
      expect(capturedPrompts[1]).toHaveLength(1);
      const r2Text = extractPromptTexts(capturedPrompts[1]).join("\n");
      expect(r2Text).toContain("Question 2");
      expect(r2Text).not.toContain("[model]");
      expect(r2Text).not.toContain("Answer One");

      // R3: [U1, A1, U2, A2 (with surrounding whitespace), U3] -> warm reuse, strips A2, sends only [U3]
      const res3 = await worker.executePrompt({
        contents: [
          { role: "user", parts: [{ text: "Question 1" }] },
          { role: "model", parts: [{ text: "Answer One" }] },
          { role: "user", parts: [{ text: "Question 2" }] },
          { role: "model", parts: [{ text: "  Answer Two\n" }] },
          { role: "user", parts: [{ text: "Question 3" }] },
        ],
      });
      expect(res3.timings?.coldStart).toBe(false);
      expect(capturedPrompts).toHaveLength(3);
      expect(capturedPrompts[2]).toHaveLength(1);
      const r3Text = extractPromptTexts(capturedPrompts[2]).join("\n");
      expect(r3Text).toContain("Question 3");
      expect(r3Text).not.toContain("[model]");
      expect(r3Text).not.toContain("Answer Two");
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("2. preserves tampered A1 in R2 instead of silently stripping it", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const capturedPrompts: Array<Array<Record<string, unknown>>> = [];
    let turn = 0;

    const worker = new AgySessionWorker({
      account: makeAccount("dedup-tampered"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-tampered" }),
        setModel: async () => ({}),
        prompt: async (params) => {
          turn++;
          capturedPrompts.push(params.prompt as Array<Record<string, unknown>>);
          onUpdate({
            sessionId: "sess-tampered",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: turn === 1 ? "Original Answer" : "Follow-up Answer" },
            },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "Question 1" }] }],
      });

      const res2 = await worker.executePrompt({
        contents: [
          { role: "user", parts: [{ text: "Question 1" }] },
          { role: "model", parts: [{ text: "Tampered Answer By Client" }] },
          { role: "user", parts: [{ text: "Question 2" }] },
        ],
      });
      expect(res2.timings?.coldStart).toBe(false);
      expect(capturedPrompts).toHaveLength(2);
      expect(capturedPrompts[1]).toHaveLength(2);
      const r2Text = extractPromptTexts(capturedPrompts[1]).join("\n");
      expect(r2Text).toContain("[model]");
      expect(r2Text).toContain("Tampered Answer By Client");
      expect(r2Text).toContain("Question 2");
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("3. non-content frames neither set promptToFirstEventMs nor reset idleTimer (triggers 504 TIMEOUT)", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let noiseTimer: ReturnType<typeof setInterval> | null = null;
    let releasePrompt: (() => void) | null = null;

    const worker = new AgySessionWorker({
      account: makeAccount("idle-watchdog-noise"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      idleTimeoutMs: 120,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-noise" }),
        setModel: async () => ({}),
        prompt: async () => {
          const noiseFrames = [
            { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
            { sessionUpdate: "session_info_update", title: "local-ack" },
            { sessionUpdate: "available_commands_update", commands: [] },
            { sessionUpdate: "plan", entries: [] },
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
          ];
          let idx = 0;
          // Emit non-content frames every 30ms — would infinitely extend a 120ms timer if allowed to reset it.
          noiseTimer = setInterval(() => {
            const frame = noiseFrames[idx % noiseFrames.length];
            idx++;
            onUpdate({ sessionId: "sess-noise", update: frame });
          }, 30);

          await new Promise<void>((resolve) => {
            releasePrompt = resolve;
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {
          if (noiseTimer) {
            clearInterval(noiseTimer);
            noiseTimer = null;
          }
          releasePrompt?.();
        },
        isAlive: () => true,
      }),
    });

    try {
      let caught: unknown;
      try {
        await worker.executePrompt({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WorkerError);
      const workerErr = caught as WorkerError;
      expect(workerErr.code).toBe("TIMEOUT");
      expect(workerErr.upstreamStatus).toBe(504);
      expect(workerErr.timings?.promptToFirstEventMs).toBeUndefined();
    } finally {
      if (noiseTimer) clearInterval(noiseTimer);
      releasePrompt?.();
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("4a. first non-empty agent_thought_chunk records promptToFirstEventMs and resets idleTimer", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const worker = new AgySessionWorker({
      account: makeAccount("first-thought-event"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      idleTimeoutMs: 140,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-thought-first" }),
        setModel: async () => ({}),
        prompt: async () => {
          // 15ms: local non-content frames (must NOT stamp promptToFirstEventMs)
          await new Promise((r) => setTimeout(r, 15));
          onUpdate({
            sessionId: "sess-thought-first",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
          });
          onUpdate({
            sessionId: "sess-thought-first",
            update: { sessionUpdate: "session_info_update", title: "ack" },
          });

          // ~80ms total: first substantive thought chunk (stamps promptToFirstEventMs & resets 140ms timer)
          await new Promise((r) => setTimeout(r, 65));
          onUpdate({
            sessionId: "sess-thought-first",
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } },
          });

          // ~170ms total (> initial 140ms, but only 90ms after thought chunk -> survives only if timer was reset)
          await new Promise((r) => setTimeout(r, 90));
          onUpdate({
            sessionId: "sess-thought-first",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final reply" } },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const res = await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "think then answer" }] }],
      });
      expect(res.parts).toEqual([
        { text: "thinking...", thought: true },
        { text: "final reply" },
      ]);
      expect(typeof res.timings?.promptToFirstEventMs).toBe("number");
      // Must reflect the ~80ms thought chunk, not the 15ms non-content frames
      expect(res.timings!.promptToFirstEventMs!).toBeGreaterThanOrEqual(55);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("4b. first non-empty agent_message_chunk records promptToFirstEventMs and resets idleTimer", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const worker = new AgySessionWorker({
      account: makeAccount("first-msg-event"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      idleTimeoutMs: 140,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-msg-first" }),
        setModel: async () => ({}),
        prompt: async () => {
          await new Promise((r) => setTimeout(r, 15));
          onUpdate({
            sessionId: "sess-msg-first",
            update: { sessionUpdate: "available_commands_update", commands: [] },
          });
          onUpdate({
            sessionId: "sess-msg-first",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
          });

          // ~80ms total: first non-empty message chunk
          await new Promise((r) => setTimeout(r, 65));
          onUpdate({
            sessionId: "sess-msg-first",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part 1 " } },
          });

          // ~170ms total (> initial 140ms, survives because timer was reset at ~80ms)
          await new Promise((r) => setTimeout(r, 90));
          onUpdate({
            sessionId: "sess-msg-first",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part 2" } },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const res = await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "answer" }] }],
      });
      expect(res.parts).toEqual([{ text: "part 1 " }, { text: "part 2" }]);
      expect(typeof res.timings?.promptToFirstEventMs).toBe("number");
      expect(res.timings!.promptToFirstEventMs!).toBeGreaterThanOrEqual(55);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("5a. cancels via session/cancel within 100ms on 2 consecutive internal 429 retries with no effective output", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const cancelCalls: string[] = [];
    const worker = new AgySessionWorker({
      account: makeAccount("429-storm-cancel"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-429-storm" }),
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            sessionId: "sess-429-storm",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "⚠ API error (attempt 1): 429 RESOURCE_EXHAUSTED retrying in 5s" },
            },
          });
          await new Promise((r) => setTimeout(r, 10));
          onUpdate({
            sessionId: "sess-429-storm",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "⚠ API error (attempt 2): 429 RESOURCE_EXHAUSTED retrying in 12s" },
            },
          });
          // Simulate agy hanging on 8-minute backoff if not cancelled
          await new Promise((r) => setTimeout(r, 5000));
          return { stopReason: "end_turn" };
        },
        cancel: async (sessionId) => {
          cancelCalls.push(sessionId);
        },
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const started = performance.now();
      let caught: unknown;
      try {
        await worker.executePrompt({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        });
      } catch (err) {
        caught = err;
      }
      const elapsedMs = performance.now() - started;

      expect(caught).toBeInstanceOf(WorkerError);
      expect((caught as WorkerError).code).toBe("QUOTA_EXHAUSTED");
      expect((caught as WorkerError).upstreamStatus).toBe(429);
      expect(cancelCalls).toEqual(["sess-429-storm"]);
      expect(elapsedMs).toBeLessThan(100);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("5b. does NOT false-cancel on 429 retry notices once effective output has been produced", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const cancelCalls: string[] = [];
    const worker = new AgySessionWorker({
      account: makeAccount("429-no-false-kill"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-429-safe" }),
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            sessionId: "sess-429-safe",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "⚠ API error (attempt 1): 429 RESOURCE_EXHAUSTED retrying in 5s" },
            },
          });
          onUpdate({
            sessionId: "sess-429-safe",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Recovered answer" },
            },
          });
          onUpdate({
            sessionId: "sess-429-safe",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "⚠ API error (attempt 2): 429 RESOURCE_EXHAUSTED" },
            },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async (sessionId) => {
          cancelCalls.push(sessionId);
        },
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const res = await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      expect(res.parts).toEqual([{ text: "Recovered answer" }]);
      expect(cancelCalls).toEqual([]);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });
});
