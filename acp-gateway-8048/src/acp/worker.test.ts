import { describe, expect, spyOn, test } from "bun:test";
import { AgySessionWorker, classifyUpstreamError, type AcpTransport, type WorkerOptions } from "./worker";
import { LoopbackMcpServer } from "./loopback-mcp";
import type { AccountRecord, GeminiGenerateRequest, GeminiPart } from "../types";

type ClassifiedError = NonNullable<ReturnType<typeof classifyUpstreamError>>;

// Exercise the update boundary without launching agy, opening MCP, or touching accounts.
type UpdateBoundary = {
  handleUpdate(params: Record<string, unknown>): void;
  scheduleSoftErrorCutoff(text: string, classified: ClassifiedError): void;
  activeTurnParts: GeminiPart[];
  activeTurnCallbacks: { onPart: (part: GeminiPart) => void };
};

function createUpdateHarness() {
  const worker = new AgySessionWorker({
    account: {
      id: "test", label: "test", email: "", source: "test",
      homeDir: "unused", proxyUrl: "", status: "ready", tier: "standard",
      statusReason: "", exitIp: "", exitCountry: "", concurrencyLimit: 1,
      activeWorkers: 0, lastVerifiedAt: null, createdAt: 0, updatedAt: 0,
    },
    model: "test",
    workspaceDir: "unused",
    mcpServer: {} as WorkerOptions["mcpServer"],
  });
  const boundary = worker as unknown as UpdateBoundary;
  const streamed: GeminiPart[] = [];
  boundary.activeTurnCallbacks = { onPart: (part) => streamed.push(part) };
  const cutoff = spyOn(boundary, "scheduleSoftErrorCutoff").mockImplementation(() => {});
  const send = (sessionUpdate: string, text: string) =>
    boundary.handleUpdate({ update: { sessionUpdate, content: { type: "text", text } } });
  return { boundary, streamed, cutoff, send };
}

const ordinaryTexts = [
  "linux.do 的 /api/reload 返回 403，我们来排查。",
  "Review safety and policy violation handling before changing account state.",
  "quota、429、401 与 login 是这段文档讨论的关键词。",
  "403", "safety", "quota", "linux.do", "/api/reload",
  "RESOURCE_EXHAUSTED is an error code we should document.",
  "VALIDATION_REQUIRED means verification is required.",
  "API Error: is a prefix used by the upstream service.",
];

describe("model text is never an upstream error frame", () => {
  for (const type of ["agent_thought_chunk", "agent_message_chunk"]) {
    for (const text of ordinaryTexts) {
      test(`${type} passes through ${JSON.stringify(text)}`, () => {
        const { boundary, streamed, cutoff, send } = createUpdateHarness();
        try {
          send(type, text);
          const expected = type === "agent_thought_chunk" ? { text, thought: true } : { text };
          expect(boundary.activeTurnParts).toEqual([expected]);
          expect(streamed).toEqual([expected]);
          expect(cutoff).not.toHaveBeenCalled();
        } finally {
          cutoff.mockRestore();
        }
      });
    }
  }

  test("later chunks also bypass classification, including after thoughts", () => {
    const { boundary, streamed, cutoff, send } = createUpdateHarness();
    try {
      send("agent_thought_chunk", "Check linux.do and /api/reload safety.");
      send("agent_message_chunk", "The response was 403; check quota and login.");
      send("agent_message_chunk", "RESOURCE_EXHAUSTED: retry after 2s");
      expect(boundary.activeTurnParts).toEqual(streamed);
      expect(streamed).toHaveLength(3);
      expect(cutoff).not.toHaveBeenCalled();
    } finally {
      cutoff.mockRestore();
    }
  });
});

const classifiedCases: Array<[string, ClassifiedError]> = [
  ["VALIDATION_REQUIRED", { code: "VALIDATION_REQUIRED", upstreamStatus: 403, retryAfterMs: 600_000 }],
  ["Verify your account", { code: "VALIDATION_REQUIRED", upstreamStatus: 403, retryAfterMs: 600_000 }],
  ["RESOURCE_EXHAUSTED: retry-after: 1.5s", { code: "QUOTA_EXHAUSTED", upstreamStatus: 429, retryAfterMs: 1500 }],
  ["RESOURCE_EXHAUSTED: retry-after: 250 ms", { code: "QUOTA_EXHAUSTED", upstreamStatus: 429, retryAfterMs: 250 }],
  ["RESOURCE_EXHAUSTED: Retry-After: 0", { code: "QUOTA_EXHAUSTED", upstreamStatus: 429, retryAfterMs: 0 }],
  ["UNAUTHENTICATED", { code: "AUTH_REQUIRED", upstreamStatus: 401 }],
  // ACP 协议层的认证错误措辞（agy CLI 冷启动时返回），必须归入 AUTH_REQUIRED，
  // 否则会被当成普通 TRANSPORT_ERROR，过期账号会反复被选中。
  ["Authentication required", { code: "AUTH_REQUIRED", upstreamStatus: 401 }],
  ["Account restricted", { code: "RESTRICTED", upstreamStatus: 403 }],
];

describe("explicit upstream errors", () => {
  for (const [message, classified] of classifiedCases) {
    test(`classifies ${message}`, () => {
      expect(classifyUpstreamError(message)).toEqual(classified);
    });

    test(`error frame schedules cutoff for ${message}`, () => {
      const { boundary, streamed, cutoff } = createUpdateHarness();
      try {
        boundary.handleUpdate({ update: { sessionUpdate: "error", message } });
        expect(cutoff).toHaveBeenCalledTimes(1);
        expect(cutoff).toHaveBeenCalledWith(message, classified);
        expect(boundary.activeTurnParts).toEqual([]);
        expect(streamed).toEqual([]);
      } finally {
        cutoff.mockRestore();
      }
    });
  }

  test("an explicit error after normal output is still handled", () => {
    const { boundary, cutoff, send } = createUpdateHarness();
    try {
      send("agent_message_chunk", "Normal output");
      boundary.handleUpdate({ sessionUpdate: "error", message: "RESOURCE_EXHAUSTED" });
      expect(cutoff).toHaveBeenCalledTimes(1);
      expect(cutoff).toHaveBeenCalledWith("RESOURCE_EXHAUSTED", {
        code: "QUOTA_EXHAUSTED", upstreamStatus: 429, retryAfterMs: undefined,
      });
    } finally {
      cutoff.mockRestore();
    }
  });

  for (const message of ["safety", "policy violation", "Blocked by safety policy violation"]) {
    test(`content blocking does not restrict the account: ${message}`, () => {
      expect(classifyUpstreamError(message)).toBeNull();
      const { boundary, cutoff } = createUpdateHarness();
      try {
        boundary.handleUpdate({ update: { sessionUpdate: "error", message } });
        expect(cutoff).toHaveBeenCalledTimes(1);
        expect(cutoff).toHaveBeenCalledWith(message, {
          code: "SOFT_ERROR", upstreamStatus: 502,
        });
      } finally {
        cutoff.mockRestore();
      }
    });
  }

  test("unknown error frame falls back to SOFT_ERROR", () => {
    const { boundary, cutoff } = createUpdateHarness();
    const update = { sessionUpdate: "error", details: "unexpected failure" };
    try {
      boundary.handleUpdate({ update });
      expect(cutoff).toHaveBeenCalledTimes(1);
      expect(cutoff).toHaveBeenCalledWith(JSON.stringify(update), {
        code: "SOFT_ERROR", upstreamStatus: 502,
      });
    } finally {
      cutoff.mockRestore();
    }
  });
});

function makeUsageAccount(): AccountRecord {
  return {
    id: "acc-usage",
    label: "acc-usage",
    email: "usage@example.com",
    source: "test",
    homeDir: "unused",
    proxyUrl: "",
    status: "ready",
    tier: "standard",
    statusReason: "",
    exitIp: "",
    exitCountry: "",
    concurrencyLimit: 1,
    activeWorkers: 0,
    lastVerifiedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("AgySessionWorker upstream usage accounting", () => {
  test("parses inclusive inputTokens with cachedReadTokens > 0 and avoids double-counting thoughtTokens", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const worker = new AgySessionWorker({
      account: makeUsageAccount(),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-inclusive" }),
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
          });
          onUpdate({
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
          });
          return {
            stopReason: "end_turn",
            usage: {
              inputTokens: 1000,
              cachedReadTokens: 800,
              cachedWriteTokens: 0,
              outputTokens: 120,
              thoughtTokens: 20,
              totalTokens: 1120,
            },
          };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const req: GeminiGenerateRequest = {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      };
      const res = await worker.executePrompt(req);
      expect(res.cacheHit).toBe(true);
      expect(res.cachedTokens).toBe(800);
      expect(res.usageMetadata).toEqual({
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 20,
        totalTokenCount: 1120,
        cachedContentTokenCount: 800,
      });
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("parses exclusive inputTokens with cachedReadTokens > 0 and cachedWriteTokens", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const worker = new AgySessionWorker({
      account: makeUsageAccount(),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-exclusive" }),
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
          });
          return {
            stopReason: "end_turn",
            usage: {
              inputTokens: 200,
              cachedReadTokens: 800,
              cachedWriteTokens: 50,
              outputTokens: 120,
              thoughtTokens: 20,
              totalTokens: 1170,
            },
          };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const req: GeminiGenerateRequest = {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      };
      const res = await worker.executePrompt(req);
      expect(res.cacheHit).toBe(true);
      expect(res.cachedTokens).toBe(800);
      expect(res.usageMetadata).toEqual({
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 20,
        totalTokenCount: 1170,
        cachedContentTokenCount: 800,
        cacheCreationTokenCount: 50,
      });
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("returns undefined usage fields when upstream omits usage", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    let turns = 0;
    const worker = new AgySessionWorker({
      account: makeUsageAccount(),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-no-usage" }),
        setModel: async () => ({}),
        prompt: async () => {
          turns++;
          onUpdate({
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `turn-${turns}` } },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const req1: GeminiGenerateRequest = {
        systemInstruction: { parts: [{ text: "sys" }] },
        contents: [{ role: "user", parts: [{ text: "turn 1" }] }],
      };
      const res1 = await worker.executePrompt(req1);
      expect(res1.cacheHit).toBeUndefined();
      expect(res1.cachedTokens).toBeUndefined();
      expect(res1.usageMetadata).toBeUndefined();

      // Even on reused session, never fabricate cachedTokens with local estimateTokens(skipped)
      const req2: GeminiGenerateRequest = {
        systemInstruction: req1.systemInstruction,
        contents: [
          { role: "user", parts: [{ text: "turn 1" }] },
          { role: "model", parts: [{ text: "turn-1" }] },
          { role: "user", parts: [{ text: "turn 2" }] },
        ],
      };
      const res2 = await worker.executePrompt(req2);
      expect(res2.cacheHit).toBeUndefined();
      expect(res2.cachedTokens).toBeUndefined();
      expect(res2.usageMetadata).toBeUndefined();
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("returns undefined usage fields on intermediate tool-call turn and real usage on terminal turn", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    let capturedSessionId = "";

    const worker = new AgySessionWorker({
      account: makeUsageAccount(),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate, env }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async (params) => {
          // Extract session token from registered MCP server URL
          const servers = params.mcpServers as Array<{ url?: string }>;
          const mcpUrl = servers?.[0]?.url ?? "";
          const match = mcpUrl.match(/\/mcp\/([^/?]+)/);
          capturedSessionId = match?.[1] ?? "";
          void env;
          return { sessionId: "sess-tool-turn" };
        },
        setModel: async () => ({}),
        prompt: async () => {
          // Trigger tool call via loopback MCP server and wait for tool result before finishing prompt
          const mcpRes = await fetch(`http://127.0.0.1:${mcpServer.port}/mcp/${capturedSessionId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "lookup", arguments: { q: "test" } },
            }),
          });
          await mcpRes.json();

          onUpdate({
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final answer" } },
          });
          return {
            stopReason: "end_turn",
            usage: {
              inputTokens: 500,
              cachedReadTokens: 300,
              outputTokens: 60,
              thoughtTokens: 15,
              totalTokens: 560,
            },
          };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const req1: GeminiGenerateRequest = {
        tools: [{ functionDeclarations: [{ name: "lookup", description: "Lookup tool" }] }],
        contents: [{ role: "user", parts: [{ text: "find something" }] }],
      };

      // Intermediate turn wakes via toolBatchPromise while session/prompt is still in flight
      const midRes = await worker.executePrompt(req1);
      expect(midRes.cacheHit).toBeUndefined();
      expect(midRes.cachedTokens).toBeUndefined();
      expect(midRes.usageMetadata).toBeUndefined();
      expect(midRes.parts.some((p) => Boolean(p.functionCall))).toBe(true);

      const callPart = midRes.parts.find((p) => Boolean(p.functionCall))!;
      const req2: GeminiGenerateRequest = {
        tools: req1.tools,
        contents: [
          { role: "user", parts: [{ text: "find something" }] },
          { role: "model", parts: [callPart] },
          {
            role: "user",
            parts: [{ functionResponse: { id: callPart.functionCall!.id, name: "lookup", response: { ok: true } } }],
          },
        ],
      };

      const finalRes = await worker.executePrompt(req2);
      expect(finalRes.cacheHit).toBe(true);
      expect(finalRes.cachedTokens).toBe(300);
      expect(finalRes.usageMetadata).toEqual({
        promptTokenCount: 500,
        candidatesTokenCount: 45,
        thoughtsTokenCount: 15,
        totalTokenCount: 560,
        cachedContentTokenCount: 300,
      });
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });
});

describe("AgySessionWorker slot B optimizations", () => {
  function makeTestAccount(homeDir = "unused"): AccountRecord {
    return {
      id: "slot-b-acc",
      label: "slot-b-acc",
      email: "slotb@example.com",
      source: "test",
      homeDir,
      proxyUrl: "",
      status: "ready",
      tier: "standard",
      statusReason: "",
      exitIp: "",
      exitCountry: "",
      concurrencyLimit: 2,
      activeWorkers: 0,
      lastVerifiedAt: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  test("skips MCP registration and passes mcpServers: [] when request has no tools", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    const registerSpy = spyOn(mcpServer, "registerSession");
    let capturedMcpServers: Array<Record<string, unknown>> | undefined;

    const worker = new AgySessionWorker({
      account: makeTestAccount(),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async (params) => {
          capturedMcpServers = params.mcpServers as Array<Record<string, unknown>>;
          return { sessionId: "sess-no-tools" };
        },
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            sessionId: "sess-no-tools",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
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
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      expect(res.parts).toEqual([{ text: "ok" }]);
      expect(capturedMcpServers).toEqual([]);
      expect(registerSpy).not.toHaveBeenCalled();
    } finally {
      registerSpy.mockRestore();
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test.each(['confirmed', 'unverified', 'rejected', 'mismatch'] as const)(
    'checks the selected model before sending the prompt (%s)', async (scenario) => {
      const requested = 'gemini-3.8-flash-low';
      const defaultModel = 'gemini-3.8-flash-high';
      const calls: string[] = [];
      const worker = new AgySessionWorker({
        account: makeTestAccount(),
        model: requested,
        workspaceDir: 'unused',
        mcpServer: new LoopbackMcpServer(),
        transportFactory: ({ onUpdate }) => ({
          initialize: async () => ({ sessionCapabilities: { resume: true } }),
          newSession: async () => ({ sessionId: 'model-check', models: { currentModelId: defaultModel } }),
          async setModel(params) {
            calls.push(`set:${params.modelId}`);
            if (scenario === 'rejected') throw new Error('Unknown model');
            return {};
          },
          async resumeSession() {
            calls.push('verify');
            onUpdate({ sessionId: 'model-check', update: {
              sessionUpdate: 'agent_message_chunk', content: { text: 'old content' },
            } });
            if (scenario === 'unverified') throw new Error('Verification unavailable');
            return { sessionId: 'model-check', models: { currentModelId: scenario === 'mismatch' ? defaultModel : requested } };
          },
          async prompt() {
            calls.push('prompt');
            onUpdate({ sessionId: 'model-check', update: {
              sessionUpdate: 'agent_message_chunk', content: { text: 'reply' },
            } });
            return { stopReason: 'end_turn' };
          },
          async cancel() {},
          async close() {},
          isAlive: () => true,
        }),
      });

      try {
        const response = worker.executePrompt({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
        if (scenario === 'rejected' || scenario === 'mismatch') {
          await expect(response).rejects.toMatchObject({
            code: 'MODEL_SELECTION_FAILED',
            modelSelection: { confirmedModel: defaultModel },
            timings: { setModelMs: expect.any(Number) },
          });
          expect(calls).toEqual(scenario === 'rejected' ? [`set:${requested}`] : [`set:${requested}`, 'verify']);
        } else {
          const result = await response;
          expect(result.modelSelection?.confirmedModel).toBe(scenario === 'confirmed' ? requested : undefined);
          expect(result.modelSelection?.modelSelectionAcknowledged).toBe(true);
          expect(result.parts).toEqual([{ text: 'reply' }]);
          expect(calls).toEqual([`set:${requested}`, 'verify', 'prompt']);
        }
      } finally {
        await worker.resetAndClose();
      }
    },
  );

  test("records split cold-start and warm-reuse timings in WorkerPromptResult", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const worker = new AgySessionWorker({
      account: makeTestAccount(),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => ({ sessionId: "sess-timings" }),
        setModel: async () => ({}),
        prompt: async () => {
          onUpdate({
            sessionId: "sess-timings",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } },
          });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const res1 = await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "turn 1" }] }],
      });
      expect(res1.timings?.coldStart).toBe(true);
      expect(res1.timings?.sessionResumed).toBe(false);
      expect(typeof res1.timings?.spawnMs).toBe("number");
      expect(typeof res1.timings?.initializeMs).toBe("number");
      expect(typeof res1.timings?.sessionSetupMs).toBe("number");
      expect(typeof res1.timings?.setModelMs).toBe("number");
      expect(typeof res1.timings?.promptToFirstEventMs).toBe("number");

      const res2 = await worker.executePrompt({
        contents: [
          { role: "user", parts: [{ text: "turn 1" }] },
          { role: "model", parts: [{ text: "reply" }] },
          { role: "user", parts: [{ text: "turn 2" }] },
        ],
      });
      expect(res2.timings?.coldStart).toBe(false);
      expect(res2.timings?.sessionResumed).toBe(false);
      expect(res2.timings?.spawnMs).toBeUndefined();
      expect(res2.timings?.initializeMs).toBeUndefined();
      expect(res2.timings?.sessionSetupMs).toBeUndefined();
      expect(typeof res2.timings?.promptToFirstEventMs).toBe("number");
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  test("ignores handleUpdate frames whose sessionId does not match current sessionId", () => {
    const worker = new AgySessionWorker({
      account: makeTestAccount(),
      model: "test",
      workspaceDir: "unused",
      mcpServer: {} as WorkerOptions["mcpServer"],
    });
    const boundary = worker as unknown as UpdateBoundary & { sessionId: string | null };
    const streamed: GeminiPart[] = [];
    boundary.sessionId = "sess-active";
    boundary.activeTurnCallbacks = { onPart: (part) => streamed.push(part) };

    boundary.handleUpdate({
      sessionId: "sess-stale",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } },
    });
    expect(boundary.activeTurnParts).toEqual([]);
    expect(streamed).toEqual([]);

    boundary.handleUpdate({
      sessionId: "sess-active",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh" } },
    });
    expect(boundary.activeTurnParts).toEqual([{ text: "fresh" }]);
    expect(streamed).toEqual([{ text: "fresh" }]);
  });

  test("adopts prewarmed transport and skips spawn and initialize", async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let spawnCalls = 0;
    let initCalls = 0;
    let newSessionCalls = 0;
    let boundHandlers: {
      onUpdate: (params: Record<string, unknown>) => void;
      onExit: (code: number | null, stderr: string) => void;
    } | null = null;

    const prewarmedTransport: AcpTransport = {
      initialize: async () => {
        initCalls++;
        return { ok: true };
      },
      newSession: async () => {
        newSessionCalls++;
        return { sessionId: "sess-prewarmed" };
      },
      setModel: async () => ({}),
      prompt: async () => {
        boundHandlers?.onUpdate({
          sessionId: "sess-prewarmed",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "prewarmed ok" } },
        });
        return { stopReason: "end_turn" };
      },
      cancel: async () => {},
      close: async () => {},
      isAlive: () => true,
    };

    const worker = new AgySessionWorker({
      account: makeTestAccount("home-prewarm"),
      model: "gemini-4-hydrogen-medium",
      workspaceDir: "unused",
      mcpServer,
      transportFactory: () => {
        spawnCalls++;
        throw new Error("transportFactory should not be called when prewarmed transport is adopted");
      },
    });

    worker.adoptPrewarmedTransport(prewarmedTransport, "home-prewarm", {
      initCaps: { raw: { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } } },
      bindHandlers: (handlers) => {
        boundHandlers = handlers;
      },
    });

    try {
      const res = await worker.executePrompt({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      });
      expect(res.parts).toEqual([{ text: "prewarmed ok" }]);
      expect(spawnCalls).toBe(0);
      expect(initCalls).toBe(0);
      expect(newSessionCalls).toBe(1);
      expect(res.timings?.coldStart).toBe(true);
      expect(res.timings?.spawnMs).toBeUndefined();
      expect(res.timings?.initializeMs).toBeUndefined();
      expect(typeof res.timings?.sessionSetupMs).toBe("number");
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });
});
