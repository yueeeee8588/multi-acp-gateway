import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer, SessionToolBroker } from '../src/acp/loopback-mcp';
import { sanitizeToolDeclarations, type SanitizedToolDefinition } from '../src/acp/schema-sanitizer';

// ---------------------------------------------------------------------------
// WP-3: LoopbackMcpServer `_meta: { "antigravity/alwaysLoad": true }` 专项测试
//
// 验收目标：JSON-RPC `tools/list` 返回的 `result.tools` 数组里，
//   1) 所有透传的动态工具都携带 `_meta: { "antigravity/alwaysLoad": true }`；
//   2) 内置的 `await_result` 工具也携带同样的 `_meta`。
// ---------------------------------------------------------------------------

const ALWAYS_LOAD_META = { 'antigravity/alwaysLoad': true } as const;

interface RawTool {
  name?: string;
  description?: unknown;
  inputSchema?: unknown;
  _meta?: unknown;
}

interface ToolsListBody {
  jsonrpc?: string;
  id?: unknown;
  result?: { tools?: RawTool[] };
  error?: unknown;
}

/** 构造一组已 sanitize 的动态工具定义（模拟 worker 注入的真实路径）。 */
function buildSanitizedTools(): SanitizedToolDefinition[] {
  const { tools } = sanitizeToolDeclarations([
    {
      name: 'lookup_data',
      description: 'Look up data by query',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    },
    {
      name: 'send.email', // 含非法字符，确保走 normalizeMcpToolName 分支
      description: 'Send an email',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string' }, body: { type: 'string' } },
      },
    },
    {
      name: 'await_result', // 与保留名冲突，必须被重命名而非覆盖内置工具
      description: 'A dynamic tool that collides with the reserved builtin name',
      parameters: { type: 'object', properties: {} },
    },
  ]);
  return tools;
}

/** 对给定 url 发起一次 JSON-RPC POST 并解析 JSON。 */
async function rpc(url: string, payload: unknown): Promise<ToolsListBody> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ToolsListBody;
}

/** 通过真实 LoopbackMcpServer HTTP 端点请求 tools/list。 */
async function listToolsViaServer(
  tools: SanitizedToolDefinition[],
): Promise<{ server: LoopbackMcpServer; tools: RawTool[] }> {
  const server = new LoopbackMcpServer();
  const broker = new SessionToolBroker({ tools });
  const session = server.registerSession(broker);
  const body = await rpc(session.url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  expect(body.error).toBeUndefined();
  return { server, tools: body.result?.tools ?? [] };
}

function expectAlwaysLoadMeta(tool: RawTool): void {
  expect(tool._meta).toEqual(ALWAYS_LOAD_META);
  // 键名必须精确为 "antigravity/alwaysLoad"，且值为 true
  const meta = tool._meta as Record<string, unknown>;
  expect(Object.keys(meta)).toEqual(['antigravity/alwaysLoad']);
  expect(meta['antigravity/alwaysLoad']).toBe(true);
}

describe('LoopbackMcpServer tools/list _meta.antigravity/alwaysLoad', () => {
  it('透传的所有动态工具都携带 _meta: {"antigravity/alwaysLoad": true}', async () => {
    const sanitized = buildSanitizedTools();
    const expectedDynamicNames = sanitized.map((t) => t.mcpName);
    expect(expectedDynamicNames.length).toBeGreaterThan(0);

    const { server, tools } = await listToolsViaServer(sanitized);
    try {
      const toolNames = tools.map((t) => t.name ?? '');
      for (const name of expectedDynamicNames) {
        expect(toolNames).toContain(name);
      }

      const dynamicTools = tools.filter((t) => t.name !== 'await_result');
      expect(dynamicTools.length).toBe(expectedDynamicNames.length);
      for (const tool of dynamicTools) {
        expectAlwaysLoadMeta(tool);
      }
    } finally {
      server.stop();
    }
  });

  it('内置 await_result 工具也携带 _meta: {"antigravity/alwaysLoad": true}', async () => {
    const { server, tools } = await listToolsViaServer(buildSanitizedTools());
    try {
      const awaitResult = tools.find((t) => t.name === 'await_result');
      expect(awaitResult).toBeDefined();
      expectAlwaysLoadMeta(awaitResult!);
    } finally {
      server.stop();
    }
  });

  it('tools/list 结果里的每一个工具（动态 + 内置）都携带该 _meta，无一遗漏', async () => {
    const { server, tools } = await listToolsViaServer(buildSanitizedTools());
    try {
      expect(tools.length).toBeGreaterThanOrEqual(2);
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expectAlwaysLoadMeta(tool);
      }
    } finally {
      server.stop();
    }
  });

  it('SessionToolBroker.listMcpTools() 与 handleJsonRpc("tools/list") 两条路径一致', async () => {
    const tools = buildSanitizedTools();
    const broker = new SessionToolBroker({ tools });

    const listed = broker.listMcpTools();
    expect(listed.length).toBe(tools.length + 1); // 动态工具 + await_result
    for (const tool of listed) {
      expect(tool._meta).toEqual(ALWAYS_LOAD_META);
    }

    const { status, body } = await broker.handleJsonRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
      params: {},
    });
    expect(status).toBe(200);
    const resultTools = (body as ToolsListBody).result?.tools ?? [];
    expect(resultTools.length).toBe(listed.length);
    for (const tool of resultTools) {
      expect(tool._meta).toEqual(ALWAYS_LOAD_META);
    }
  });
});
