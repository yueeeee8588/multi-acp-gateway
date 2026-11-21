import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgyWorkerArgs } from "../src/acp/env";
import { LoopbackMcpServer } from "../src/acp/loopback-mcp";
import {
  AGY_BRIDGE_AGENT_NAME,
  ensureMinimalAgentDefinition,
} from "../src/acp/minimal-agent";
import {
  AgySessionWorker,
  type AcpSessionSnapshot,
  type AcpTransport,
  type AcpTransportFactory,
} from "../src/acp/worker";
import { getConfig, updateConfig } from "../src/config/settings";
import type { AccountRecord, GeminiGenerateRequest } from "../src/types";

const tempDirs: string[] = [];
const prevMinimalEnv = process.env.AGY_8048_MINIMAL_AGENT;
const prevExcludeDefaultComponents = getConfig().excludeDefaultComponents;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeAccount(id = "acc-minimal-1"): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Account-${id}`,
    email: `${id}@example.com`,
    source: "test",
    homeDir: makeTempDir("agy-home-"),
    proxyUrl: "",
    status: "ready",
    tier: "standard",
    statusReason: "",
    exitIp: "127.0.0.1",
    exitCountry: "JP",
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  if (prevMinimalEnv === undefined) {
    delete process.env.AGY_8048_MINIMAL_AGENT;
  } else {
    process.env.AGY_8048_MINIMAL_AGENT = prevMinimalEnv;
  }

  updateConfig({ excludeDefaultComponents: prevExcludeDefaultComponents });

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("minimal-agent", () => {
  it("writes agent.md without excludeDefaultComponents: true by default and skips unchanged rewrites", () => {
    delete process.env.AGY_8048_MINIMAL_AGENT;
    updateConfig({ excludeDefaultComponents: false });

    const workspace = makeTempDir("agy-ws-");
    const agentPath = ensureMinimalAgentDefinition(workspace);
    expect(agentPath).toBe(
      path.join(workspace, ".agents", "agents", AGY_BRIDGE_AGENT_NAME, "agent.md"),
    );

    const content = fs.readFileSync(agentPath, "utf8");
    expect(content).toContain(`name: ${AGY_BRIDGE_AGENT_NAME}`);
    expect(content).not.toContain("excludeDefaultComponents: true");
    expect(content).toContain("Use only the provided tools.");

    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(agentPath, pastTime, pastTime);
    const beforeMtime = fs.statSync(agentPath).mtimeMs;

    ensureMinimalAgentDefinition(workspace);
    const afterMtime = fs.statSync(agentPath).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("refreshes agent.md immediately when excludeDefaultComponents config or env overrides change", () => {
    delete process.env.AGY_8048_MINIMAL_AGENT;
    updateConfig({ excludeDefaultComponents: false });

    const workspace = makeTempDir("agy-ws-toggle-");
    const agentPath = ensureMinimalAgentDefinition(workspace);
    expect(fs.readFileSync(agentPath, "utf8")).not.toContain("excludeDefaultComponents: true");

    // Switching config to true immediately overwrites agent.md on next call
    updateConfig({ excludeDefaultComponents: true });
    ensureMinimalAgentDefinition(workspace);
    expect(fs.readFileSync(agentPath, "utf8")).toContain("excludeDefaultComponents: true");

    // Switching config back to false immediately removes it on next call
    updateConfig({ excludeDefaultComponents: false });
    ensureMinimalAgentDefinition(workspace);
    expect(fs.readFileSync(agentPath, "utf8")).not.toContain("excludeDefaultComponents: true");

    // AGY_8048_MINIMAL_AGENT=1 has highest priority over config and options
    process.env.AGY_8048_MINIMAL_AGENT = "1";
    ensureMinimalAgentDefinition(workspace, { minimal: false });
    expect(fs.readFileSync(agentPath, "utf8")).toContain("excludeDefaultComponents: true");

    // AGY_8048_MINIMAL_AGENT=0 has highest priority over config and options
    updateConfig({ excludeDefaultComponents: true });
    process.env.AGY_8048_MINIMAL_AGENT = "0";
    ensureMinimalAgentDefinition(workspace, { minimal: true });
    expect(fs.readFileSync(agentPath, "utf8")).not.toContain("excludeDefaultComponents: true");
  });

  it("supports explicit options.minimal when AGY_8048_MINIMAL_AGENT is unset", () => {
    delete process.env.AGY_8048_MINIMAL_AGENT;
    updateConfig({ excludeDefaultComponents: false });

    const ws1 = makeTempDir("agy-ws-opt-true-");
    const path1 = ensureMinimalAgentDefinition(ws1, { minimal: true });
    expect(fs.readFileSync(path1, "utf8")).toContain("excludeDefaultComponents: true");

    updateConfig({ excludeDefaultComponents: true });
    const ws2 = makeTempDir("agy-ws-opt-false-");
    const path2 = ensureMinimalAgentDefinition(ws2, { minimal: false });
    expect(fs.readFileSync(path2, "utf8")).not.toContain("excludeDefaultComponents: true");
  });

  it("buildAgyWorkerArgs ensures agent.md exists and passes --agent agy-8048-bridge", () => {
    const homeDir = makeTempDir("agy-home-args-");
    const workspaceDir = makeTempDir("agy-ws-args-");
    const args = buildAgyWorkerArgs({ homeDir, workspaceDir });
    const idx = args.indexOf("--agent");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(AGY_BRIDGE_AGENT_NAME);
    expect(
      fs.existsSync(path.join(workspaceDir, ".agents", "agents", AGY_BRIDGE_AGENT_NAME, "agent.md")),
    ).toBe(true);
  });
});

describe("worker integration with minimal-agent and neutral passthrough", () => {
  it("passes systemInstruction and user content neutrally without prompt rewriting and preserves session reuse", async () => {
    const workspaceDir = makeTempDir("agy-worker-minimal-");
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const recorded = {
      newSessionParams: [] as Array<Record<string, unknown>>,
      promptParams: [] as Array<Record<string, unknown>>,
    };

    const factory: AcpTransportFactory = ({ onUpdate }) => {
      const transport: AcpTransport = {
        async initialize() {
          return {
            raw: {
              agentCapabilities: {
                _meta: { antigravity: { systemPrompt: { append: true } } },
              },
            },
          };
        },
        async newSession(params) {
          recorded.newSessionParams.push(params);
          return { sessionId: "sess-minimal-1" };
        },
        async setModel() {
          return { models: { currentModelId: "gemini-4-hydrogen-medium" } };
        },
        async prompt(params) {
          recorded.promptParams.push(params);
          onUpdate({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "OK" },
            },
          });
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        async close() {},
        isAlive: () => true,
      };
      return transport;
    };

    const snapshots: Array<AcpSessionSnapshot | null> = [];
    const worker = new AgySessionWorker({
      account: makeAccount(),
      model: "gemini-4-hydrogen-medium",
      mcpServer,
      workspaceDir,
      transportFactory: factory,
      stickyKey: "sticky-minimal-1",
      onSessionStateChange: (s) => snapshots.push(s),
    });

    const originalSystem = "You are a helpful assistant.";
    const originalUser1 = "Please say OK.";

    const req1: GeminiGenerateRequest = {
      systemInstruction: { parts: [{ text: originalSystem }] },
      contents: [{ role: "user", parts: [{ text: originalUser1 }] }],
    };

    try {
      const res1 = await worker.executePrompt(req1);
      expect(res1.parts[0]?.text).toBe("OK");

      expect(
        fs.existsSync(path.join(workspaceDir, ".agents", "agents", AGY_BRIDGE_AGENT_NAME, "agent.md")),
      ).toBe(true);

      const meta = recorded.newSessionParams[0]?._meta as {
        antigravity?: { systemPrompt?: { append?: string } };
      };
      expect(meta?.antigravity?.systemPrompt?.append).toBe(originalSystem);

      const sentBlocks1 = recorded.promptParams[0]?.prompt as Array<{ type: string; text?: string }>;
      expect(sentBlocks1[0]?.text).toContain(originalUser1);

      const req2: GeminiGenerateRequest = {
        systemInstruction: { parts: [{ text: originalSystem }] },
        contents: [
          { role: "user", parts: [{ text: originalUser1 }] },
          { role: "model", parts: [{ text: "OK" }] },
          { role: "user", parts: [{ text: "Follow up" }] },
        ],
      };
      expect(worker.canReuse(req2)).toBe(true);
      const res2 = await worker.executePrompt(req2);
      expect(res2.timings?.coldStart).toBe(false);
      expect(recorded.newSessionParams.length).toBe(1);
      expect(snapshots.length).toBe(2);
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });

  it("omits _meta.antigravity.systemPrompt when systemInstruction is empty", async () => {
    const workspaceDir = makeTempDir("agy-worker-empty-sys-");
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const newSessionParams: Array<Record<string, unknown>> = [];
    const factory: AcpTransportFactory = ({ onUpdate }) => ({
      async initialize() {
        return {
          raw: {
            agentCapabilities: {
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
          },
        };
      },
      async newSession(params) {
        newSessionParams.push(params);
        return { sessionId: "sess-empty-sys" };
      },
      async setModel() {
        return { models: { currentModelId: "gemini-4-hydrogen-medium" } };
      },
      async prompt() {
        onUpdate({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "Done" },
          },
        });
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async close() {},
      isAlive: () => true,
    });

    const worker = new AgySessionWorker({
      account: makeAccount(),
      model: "gemini-4-hydrogen-medium",
      mcpServer,
      workspaceDir,
      transportFactory: factory,
    });

    try {
      await worker.executePrompt({
        systemInstruction: { parts: [{ text: "   " }] },
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      });
      expect(newSessionParams[0]?._meta).toBeUndefined();
    } finally {
      await worker.resetAndClose();
      mcpServer.stop();
    }
  });
});
