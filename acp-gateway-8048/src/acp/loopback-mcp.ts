import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SanitizedToolDefinition } from "./schema-sanitizer";

const TOKEN_PATH_RE = /^\/mcp\/([0-9a-f]{64})$/;
const TOKEN_BYTES = 32;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "agy-8048-bridge", version: "0.1.0" } as const;
const ALWAYS_LOAD_META = { "antigravity/alwaysLoad": true } as const;
const DEFAULT_BATCH_WINDOW_MS = 8;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 150_000;
const CALL_ID_PREFIX = "fc_";

export interface ExposedToolCall {
  id: string; // "fc_" + 24 hex chars
  name: string; // original Gemini function name
  mcpName: string;
  args: Record<string, unknown>;
}

export interface ToolResultPayload {
  callId: string;
  isError?: boolean;
  response: Record<string, unknown>;
}

export interface SessionToolBrokerOptions {
  tools: SanitizedToolDefinition[];
  batchWindowMs?: number;
  toolCallTimeoutMs?: number;
  onBatchReady?: (calls: ExposedToolCall[]) => void;
}

export interface LoopbackMcpServerOptions {
  port?: number;
}

interface ParkedCall {
  id: string;
  name: string;
  mcpName: string;
  args: Record<string, unknown>;
  promise: Promise<McpCallToolResult>;
  resolve: (result: McpCallToolResult) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface McpCallToolResult {
  isError?: true;
  content: McpContent[];
}

export interface RegisteredSession {
  token: string;
  url: string;
  unregister: () => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (value === undefined || value === null) return {};
  return { value };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function jsonRpcError(
  status: number,
  id: unknown,
  code: number,
  message: string,
): Response {
  return jsonResponse(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTNAMES.has(normalizeHostname(url.hostname));
  } catch {
    return false;
  }
}

function resolveToolCallTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit)) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
    return explicit > 0 ? explicit : 0;
  }
  const raw = process.env.AGY_8048_TOOL_CALL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  return parsed > 0 ? parsed : 0;
}

function resolveLoopbackPort(explicit?: number): number {
  if (explicit !== undefined) {
    if (explicit === 0) return 0;
    if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 65535) {
      return explicit;
    }
    return 0;
  }
  const raw = process.env.AGY_8048_LOOPBACK_MCP_PORT;
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return 0;
}

export class SessionToolBroker {
  private readonly toolsByMcpName = new Map<string, SanitizedToolDefinition>();
  private readonly parked = new Map<string, ParkedCall>();
  private readonly batchWindowMs: number;
  private readonly toolCallTimeoutMs: number;
  private readonly onBatchReady?: (calls: ExposedToolCall[]) => void;
  private batchQueue: ExposedToolCall[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionToolBrokerOptions) {
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.toolCallTimeoutMs = resolveToolCallTimeoutMs(options.toolCallTimeoutMs);
    this.onBatchReady = options.onBatchReady;
    for (const tool of options.tools) {
      this.toolsByMcpName.set(tool.mcpName, tool);
    }
  }

  get pendingCount(): number {
    return this.parked.size;
  }

  listMcpTools(): Array<Record<string, unknown>> {
    const list: Array<Record<string, unknown>> = [];
    for (const tool of this.toolsByMcpName.values()) {
      list.push({
        name: tool.mcpName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        _meta: ALWAYS_LOAD_META,
      });
    }
    list.push({
      name: "await_result",
      description: "Wait for an in-flight tool call result by call_id.",
      inputSchema: {
        type: "object",
        properties: {
          call_id: { type: "string", description: "The call ID to await." },
        },
        required: ["call_id"],
      },
      _meta: ALWAYS_LOAD_META,
    });
    return list;
  }

  async handleJsonRpc(
    msg: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown | null }> {
    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : "";
    const params = isObject(msg.params) ? msg.params : {};

    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return { status: 202, body: null };
    }

    if (method === "initialize") {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        },
      };
    }

    if (method === "ping") {
      return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
    }

    if (method === "tools/list") {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: { tools: this.listMcpTools() },
        },
      };
    }

    if (method === "tools/call") {
      const mcpName = typeof params.name === "string" ? params.name : "";
      const args = ensureObject(params.arguments);

      if (mcpName === "await_result") {
        const callId = typeof args.call_id === "string" ? args.call_id : "";
        const existing = this.parked.get(callId);
        if (!existing) {
          return {
            status: 200,
            body: {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: `Unknown or already completed call_id: ${callId}` }],
              },
            },
          };
        }
        const result = await this.awaitParkedCall(existing, signal);
        return { status: 200, body: { jsonrpc: "2.0", id, result } };
      }

      const def = this.toolsByMcpName.get(mcpName);
      if (!def) {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Unknown tool: ${mcpName}` }],
            },
          },
        };
      }

      const callArgs = { ...args };
      if (
        def.expectsToolSummary &&
        (typeof callArgs.toolSummary !== "string" || callArgs.toolSummary.trim() === "")
      ) {
        callArgs.toolSummary =
          def.originalName === "run_command" ? "Run command" : def.originalName;
      }

      let resolveFn: (res: McpCallToolResult) => void = () => {};
      const promise = new Promise<McpCallToolResult>((resolve) => {
        resolveFn = resolve;
      });

      const callId = `${CALL_ID_PREFIX}${randomBytes(12).toString("hex")}`;
      const parkedCall: ParkedCall = {
        id: callId,
        name: def.originalName,
        mcpName: def.mcpName,
        args: callArgs,
        promise,
        resolve: resolveFn,
        settled: false,
        timer: null,
      };
      if (this.toolCallTimeoutMs > 0) {
        const timer = setTimeout(() => {
          if (parkedCall.settled) return;
          parkedCall.settled = true;
          parkedCall.timer = null;
          this.parked.delete(callId);
          parkedCall.resolve({
            isError: true,
            content: [
              {
                type: "text",
                text: `Tool call timed out after ${this.toolCallTimeoutMs}ms (call_id=${callId})`,
              },
            ],
          });
        }, this.toolCallTimeoutMs);
        parkedCall.timer = timer;
      }
      this.parked.set(callId, parkedCall);

      this.enqueueForBatch({
        id: callId,
        name: def.originalName,
        mcpName: def.mcpName,
        args: callArgs,
      });

      const result = await this.awaitParkedCall(parkedCall, signal);
      return {
        status: 200,
        body: { jsonrpc: "2.0", id, result },
      };
    }

    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32601, message: `Method not found: ${method}` },
      },
    };
  }

  private async awaitParkedCall(
    entry: ParkedCall,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    const onAbort = () => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      this.parked.delete(entry.id);
      entry.resolve({
        isError: true,
        content: [{ type: "text", text: "Client disconnected before tool result arrived" }],
      });
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      return await entry.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  deliverResults(results: ToolResultPayload[]): void {
    for (const item of results) {
      const entry = this.parked.get(item.callId);
      if (!entry || entry.settled) continue;
      entry.settled = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      this.parked.delete(item.callId);
      entry.resolve({
        ...(item.isError ? { isError: true as const } : {}),
        content: [{ type: "text", text: JSON.stringify(item.response) }],
      });
    }
  }

  cancelAllPending(reason: string): number {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchQueue = [];

    let cancelled = 0;
    for (const [callId, entry] of this.parked.entries()) {
      if (entry.settled) continue;
      entry.settled = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.resolve({
        isError: true,
        content: [{ type: "text", text: reason }],
      });
      this.parked.delete(callId);
      cancelled += 1;
    }
    return cancelled;
  }

  private enqueueForBatch(call: ExposedToolCall): void {
    this.batchQueue.push(call);
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      const batch = this.batchQueue.splice(0, this.batchQueue.length);
      if (batch.length > 0) {
        this.onBatchReady?.(batch);
      }
    }, this.batchWindowMs);
  }
}

export class LoopbackMcpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly sessions = new Map<string, SessionToolBroker>();
  private readonly requestedPort: number;

  constructor(options: LoopbackMcpServerOptions = {}) {
    this.requestedPort = resolveLoopbackPort(options.port);
    this.start();
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.requestedPort,
      idleTimeout: 255,
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch: (request, server) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === "POST" && TOKEN_PATH_RE.test(pathname)) {
          if (typeof (server as { timeout?: (req: Request, sec: number) => void })?.timeout === "function") {
            (server as { timeout: (req: Request, sec: number) => void }).timeout(request, 0);
          }
        }
        return this.handleRequest(request, server.port ?? this.server?.port ?? 0);
      },
    });
  }

  stop(reason = "Loopback MCP server stopped"): number {
    const server = this.server;
    this.server = null;
    let cancelledPending = 0;
    for (const broker of this.sessions.values()) {
      cancelledPending += broker.cancelAllPending(reason);
    }
    this.sessions.clear();
    server?.stop(true);
    return cancelledPending;
  }

  registerSession(broker: SessionToolBroker): RegisteredSession {
    this.start();
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    this.sessions.set(token, broker);
    return {
      token,
      url: `http://127.0.0.1:${this.port}/mcp/${token}`,
      unregister: () => {
        this.sessions.delete(token);
      },
    };
  }

  private findSession(token: string): SessionToolBroker | null {
    const candidate = Buffer.from(token, "hex");
    if (candidate.length !== TOKEN_BYTES) return null;
    let found: SessionToolBroker | null = null;
    for (const [key, broker] of this.sessions) {
      const known = Buffer.from(key, "hex");
      if (known.length !== candidate.length) continue;
      if (timingSafeEqual(known, candidate)) found = broker;
    }
    return found;
  }

  private async handleRequest(request: Request, port: number): Promise<Response> {
    const url = new URL(request.url);
    const match = TOKEN_PATH_RE.exec(url.pathname);
    if (!match) return new Response("Not Found", { status: 404 });
    const token = match[1] ?? "";

    const host = (request.headers.get("host") ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return new Response("Forbidden", { status: 403 });
    }

    const origin = request.headers.get("origin");
    if (origin !== null && !isLoopbackOrigin(origin)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }

    const broker = this.findSession(token);
    if (!broker) {
      let reqId: unknown = null;
      try {
        const raw = await request.text();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isObject(parsed) && "id" in parsed) {
            reqId = parsed.id ?? null;
          }
        }
      } catch {
        reqId = null;
      }
      return jsonRpcError(
        401,
        reqId,
        -32001,
        "MCP session expired or invalidated (gateway restarted); please reconnect",
      );
    }

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }

    let text: string;
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_BYTES) {
        return new Response("Payload Too Large", { status: 413 });
      }
      text = new TextDecoder("utf-8").decode(buffer);
    } catch {
      return jsonRpcError(400, null, -32700, "Invalid request body");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonRpcError(400, null, -32700, "Parse error");
    }

    if (!isObject(parsed)) {
      return jsonRpcError(400, null, -32600, "Invalid Request");
    }

    const { status, body } = await broker.handleJsonRpc(parsed, request.signal);
    if (body === null) {
      return new Response(null, { status });
    }
    return jsonResponse(status, body);
  }
}
