import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import {
  AgySessionWorker,
  type AcpTransport,
} from '../src/acp/worker';
import type { AccountRecord, GeminiGenerateRequest } from '../src/types';

function makeAccount(id: string): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Mock-${id}`,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: '',
    proxyUrl: '',
    status: 'ready',
    statusReason: '',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function mcpRpc(url: string, payload: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const SAMPLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'OBJECT',
          properties: { path: { type: 'STRING' } },
        },
      },
    ],
  },
];

describe('worker tool batch race & state machine fixes', () => {
  it('1. delivers late/inter-turn tool_2 in Turn 2 without deadlock and completes in Turn 3', async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let mcpUrl = '';
    let promptCalls = 0;
    let onUpdateFn: ((params: Record<string, unknown>) => void) | null = null;
    let tool1Resolved: any = null;
    let tool2Resolved: any = null;
    let triggerLateTool2!: () => void;
    const lateTool2Triggered = new Promise<void>((resolve) => {
      triggerLateTool2 = resolve;
    });
    let lateTool2DispatchedResolve!: () => void;
    const lateTool2Dispatched = new Promise<void>((resolve) => {
      lateTool2DispatchedResolve = resolve;
    });

    const worker = new AgySessionWorker({
      account: makeAccount('late-batch'),
      model: 'gemini-4-hydrogen-medium',
      workspaceDir: 'unused',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: ({ onUpdate }): AcpTransport => {
        onUpdateFn = onUpdate;
        return {
          initialize: async () => ({ ok: true }),
          newSession: async (params) => {
            const servers = (params.mcpServers ?? []) as Array<{ url?: string }>;
            mcpUrl = servers[0]?.url ?? '';
            return { sessionId: 'sess-late-batch' };
          },
          setModel: async () => ({}),
          prompt: () => {
            promptCalls += 1;
            return (async () => {
              const listBody = await mcpRpc(mcpUrl, {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {},
              });
              const toolName = listBody.result.tools[0].name;

              const tool1Promise = mcpRpc(mcpUrl, {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: toolName, arguments: { path: 'file1.txt' } },
              });

              await lateTool2Triggered;
              const tool2Promise = mcpRpc(mcpUrl, {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: toolName, arguments: { path: 'file2.txt' } },
              });
              lateTool2DispatchedResolve();

              tool1Resolved = await tool1Promise;
              tool2Resolved = await tool2Promise;

              onUpdateFn?.({
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'done after tool_2' },
                },
              });
              return { stopReason: 'end_turn' };
            })();
          },
          cancel: async () => {},
          close: async () => {},
          isAlive: () => true,
        };
      },
    });

    try {
      const turn1Req: GeminiGenerateRequest = {
        tools: SAMPLE_TOOLS,
        contents: [{ role: 'user', parts: [{ text: 'Read file1 and file2' }] }],
      };

      const turn1Res = await withTimeout(worker.executePrompt(turn1Req), 2000, 'Turn 1');
      const fc1 = turn1Res.parts.find((p) => p.functionCall)?.functionCall;
      expect(fc1).toBeDefined();
      expect(fc1?.args).toEqual({ path: 'file1.txt' });

      // Simulate agy sending tool_2 during the inter-turn gap after Turn 1 finishes
      triggerLateTool2();
      await lateTool2Dispatched;
      await new Promise((r) => setTimeout(r, 40)); // wait past 8ms batchWindowMs so onBatchReady fires

      const turn2Req: GeminiGenerateRequest = {
        tools: SAMPLE_TOOLS,
        contents: [
          ...turn1Req.contents,
          { role: 'model', parts: turn1Res.parts },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: fc1!.id,
                  name: fc1!.name,
                  response: { content: 'content-of-file1' },
                },
              },
            ],
          },
        ],
      };

      const turn2Res = await withTimeout(worker.executePrompt(turn2Req), 1500, 'Turn 2');
      const fc2 = turn2Res.parts.find((p) => p.functionCall)?.functionCall;
      expect(fc2).toBeDefined();
      expect(fc2?.args).toEqual({ path: 'file2.txt' });
      expect(promptCalls).toBe(1);

      const turn3Req: GeminiGenerateRequest = {
        tools: SAMPLE_TOOLS,
        contents: [
          ...turn2Req.contents,
          { role: 'model', parts: turn2Res.parts },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: fc2!.id,
                  name: fc2!.name,
                  response: { content: 'content-of-file2' },
                },
              },
            ],
          },
        ],
      };

      const turn3Res = await withTimeout(worker.executePrompt(turn3Req), 2000, 'Turn 3');
      expect(promptCalls).toBe(1);
      expect(turn3Res.parts.map((p) => p.text).join('')).toBe('done after tool_2');
      expect(tool1Resolved?.result?.content?.[0]?.text).toContain('content-of-file1');
      expect(tool2Resolved?.result?.content?.[0]?.text).toContain('content-of-file2');
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  it('2. canReuse returns false when awaitingTools is empty but old inFlightPromptPromise is still pending', async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let newSessionCalls = 0;
    let promptCalls = 0;

    const worker = new AgySessionWorker({
      account: makeAccount('ghost-inflight'),
      model: 'gemini-4-hydrogen-medium',
      workspaceDir: 'unused',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => {
          newSessionCalls += 1;
          return { sessionId: `sess-ghost-${newSessionCalls}` };
        },
        setModel: async () => ({}),
        prompt: () => {
          promptCalls += 1;
          const callNum = promptCalls;
          if (callNum === 1) {
            onUpdate({
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'first response' },
              },
            });
            return Promise.resolve({ stopReason: 'end_turn' });
          }
          onUpdate({
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'cold started response' },
            },
          });
          return Promise.resolve({ stopReason: 'end_turn' });
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const req1: GeminiGenerateRequest = {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      };
      const res1 = await worker.executePrompt(req1);
      expect(res1.parts.map((p) => p.text).join('')).toBe('first response');
      expect(newSessionCalls).toBe(1);

      // Simulate ghost state: awaitingTools.size === 0 while an old inFlightPromptPromise is still pending
      (worker as unknown as { inFlightPromptPromise: Promise<unknown> | null }).inFlightPromptPromise =
        new Promise(() => {});

      const req2: GeminiGenerateRequest = {
        contents: [
          ...req1.contents,
          { role: 'model', parts: res1.parts },
          { role: 'user', parts: [{ text: '<hana-background-result>done</hana-background-result>' }] },
        ],
      };

      expect(worker.canReuse(req2)).toBe(false);

      const res2 = await withTimeout(worker.executePrompt(req2), 2000, 'Turn 2 cold start');
      expect(res2.timings?.coldStart).toBe(true);
      expect(newSessionCalls).toBe(2);
      expect(promptCalls).toBe(2);
      expect(res2.parts.map((p) => p.text).join('')).toBe('cold started response');
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });

  it('3. immediately resolves an omitted parallel tool result with an MCP error', async () => {
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    let mcpUrl = '';
    let parkedMcp2Response: Promise<any> | null = null;
    let promptCalls = 0;

    const worker = new AgySessionWorker({
      account: makeAccount('idle-cleanup'),
      model: 'gemini-4-hydrogen-medium',
      workspaceDir: 'unused',
      mcpServer,
      idleTimeoutMs: 5000,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async (params) => {
          const servers = (params.mcpServers ?? []) as Array<{ url?: string }>;
          mcpUrl = servers[0]?.url ?? '';
          return { sessionId: 'sess-idle-cleanup' };
        },
        setModel: async () => ({}),
        prompt: () => {
          promptCalls += 1;
          return (async () => {
            const listBody = await mcpRpc(mcpUrl, {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/list',
              params: {},
            });
            const toolName = listBody.result.tools[0].name;

            // Fire tool_1 and tool_2 concurrently in the same batch window
            const t1Promise = mcpRpc(mcpUrl, {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: toolName, arguments: { path: 'a.txt' } },
            });
            parkedMcp2Response = mcpRpc(mcpUrl, {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: toolName, arguments: { path: 'b.txt' } },
            });

            await Promise.all([t1Promise, parkedMcp2Response]);
            onUpdate({
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'continued after parallel tools' },
              },
            });
            return { stopReason: 'end_turn' };
          })();
        },
        cancel: async () => {},
        close: async () => {},
        isAlive: () => true,
      }),
    });

    try {
      const turn1Req: GeminiGenerateRequest = {
        tools: SAMPLE_TOOLS,
        contents: [{ role: 'user', parts: [{ text: 'Trigger tool_1 and tool_2' }] }],
      };

      const turn1Res = await withTimeout(worker.executePrompt(turn1Req), 2000, 'Turn 1');
      const fcs = turn1Res.parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
      expect(fcs).toHaveLength(2);
      const fc1 = fcs.find((call) => call.args?.path === 'a.txt')!;
      expect(fc1).toBeDefined();

      const brokerBefore = (worker as unknown as { broker: { pendingCount: number } | null }).broker;
      expect(brokerBefore?.pendingCount).toBe(2);

      // The client returns only tool_1, so the worker must settle tool_2 in the same turn.
      const turn2Req: GeminiGenerateRequest = {
        tools: SAMPLE_TOOLS,
        contents: [
          ...turn1Req.contents,
          { role: 'model', parts: turn1Res.parts },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: fc1.id,
                  name: fc1.name,
                  response: { content: 'ok' },
                },
              },
            ],
          },
        ],
      };

      const turn2Res = await withTimeout(worker.executePrompt(turn2Req), 2000, 'Turn 2');
      expect(turn2Res.parts.map((p) => p.text).join('')).toBe('continued after parallel tools');
      expect(promptCalls).toBe(1);

      const brokerAfter = (worker as unknown as { broker: { pendingCount: number } | null }).broker;
      expect(brokerAfter).toBe(brokerBefore);
      expect(brokerAfter?.pendingCount).toBe(0);
      expect((worker as unknown as { inFlightPromptPromise: unknown }).inFlightPromptPromise).toBeNull();

      expect(parkedMcp2Response).not.toBeNull();
      const settledMcp = await withTimeout(parkedMcp2Response!, 500, 'omitted MCP result');
      expect(settledMcp?.result).toEqual({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: 'Client omitted tool result for this call' }) }],
      });
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
    }
  });
});
