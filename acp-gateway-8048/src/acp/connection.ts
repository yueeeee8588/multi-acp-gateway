import type { Subprocess } from "bun";

export type StderrRedactor = (text: string) => string;

export interface AcpCapabilities {
  mcpCapabilities: {
    http: boolean;
    sse?: boolean;
  };
  promptCapabilities: {
    image: boolean;
  };
  sessionCapabilities: {
    resume: boolean;
  };
  systemPromptAppend: string;
  raw: Record<string, unknown>;
}

export interface AcpConnectionOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  redactor?: StderrRedactor;
  onUpdate?: (params: Record<string, unknown>) => void;
  onExit?: (code: number | null, stderr: string) => void;
  onStderr?: (chunk: string) => void;
}

interface PendingRequest {
  id: number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

class StderrRingBuffer {
  private readonly capacity: number;
  private buffer: Buffer;
  private writePos = 0;
  private isFull = false;

  constructor(capacityBytes = 16 * 1024) {
    this.capacity = capacityBytes;
    this.buffer = Buffer.alloc(capacityBytes);
  }

  push(chunk: Uint8Array | string): void {
    const data =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf-8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (data.length >= this.capacity) {
      data.copy(this.buffer, 0, data.length - this.capacity, data.length);
      this.writePos = 0;
      this.isFull = true;
      return;
    }

    const spaceToEnd = this.capacity - this.writePos;
    if (data.length <= spaceToEnd) {
      data.copy(this.buffer, this.writePos);
      this.writePos += data.length;
      if (this.writePos === this.capacity) {
        this.writePos = 0;
        this.isFull = true;
      }
    } else {
      data.copy(this.buffer, this.writePos, 0, spaceToEnd);
      const remaining = data.length - spaceToEnd;
      data.copy(this.buffer, 0, spaceToEnd, data.length);
      this.writePos = remaining;
      this.isFull = true;
    }
  }

  toString(): string {
    if (!this.isFull) {
      return this.buffer.subarray(0, this.writePos).toString("utf-8");
    }
    const part1 = this.buffer.subarray(this.writePos);
    const part2 = this.buffer.subarray(0, this.writePos);
    return Buffer.concat([part1, part2]).toString("utf-8");
  }
}

export function extractAgy8048McpToolFromPermission(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const toolCall =
    p.toolCall && typeof p.toolCall === "object"
      ? (p.toolCall as Record<string, unknown>)
      : null;

  if (toolCall) {
    if (typeof toolCall.name === "string") {
      const m = /^(?:mcp_agy8048_|agy8048\/)([A-Za-z0-9_.-]+)$/.exec(toolCall.name.trim());
      if (m?.[1]) return m[1];
    }
    if (typeof toolCall.title === "string") {
      const m = /^Run ([A-Za-z0-9_.-]+) from MCP server ["']?agy8048["']?$/.exec(
        toolCall.title.trim(),
      );
      if (m?.[1]) return m[1];
    }
  }

  if (Array.isArray(p.options)) {
    for (const opt of p.options) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      for (const field of [o.name, o.label]) {
        if (typeof field !== "string") continue;
        const m = /'mcp\(agy8048\/([A-Za-z0-9_.-]+)\)'/.exec(field);
        if (m?.[1]) return m[1];
      }
    }
  }

  return null;
}

function selectPermissionOption(
  options: unknown[],
  preferAllow: boolean,
): Record<string, unknown> | undefined {
  const valid = options.filter(
    (o): o is Record<string, unknown> => Boolean(o && typeof o === "object"),
  );
  if (preferAllow) {
    return (
      valid.find((o) => o.kind === "allow_once" || o.optionId === "allow_once") ??
      valid.find((o) => o.kind === "allow_always" || o.optionId === "allow_always") ??
      valid.find((o) =>
        [o.kind, o.optionId, o.id, o.name, o.label].some(
          (f) => typeof f === "string" && /allow|approve|accept/i.test(f),
        ),
      )
    );
  }
  return (
    valid.find((o) => o.kind === "reject_once" || o.optionId === "reject_once") ??
    valid.find((o) => o.kind === "reject_always" || o.optionId === "reject_always") ??
    valid.find((o) =>
      [o.kind, o.optionId, o.id, o.name, o.label].some(
        (f) => typeof f === "string" && /reject|deny|cancel/i.test(f),
      ),
    )
  );
}

const FORCE_KILL_AFTER_MS = 1500;
const POST_FORCE_KILL_WAIT_MS = 500;

const activeConnections = new Set<AcpConnection>();
let exitCleanupRegistered = false;

function registerProcessExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", () => {
    for (const conn of activeConnections) {
      conn.forceKillSyncOnProcessExit();
    }
    activeConnections.clear();
  });
}

export class AcpConnection {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrRing = new StderrRingBuffer(16 * 1024);
  private readonly redactor?: StderrRedactor;
  private readonly onUpdate?: (params: Record<string, unknown>) => void;
  private readonly onExit?: (code: number | null, stderr: string) => void;
  private stderrHandler?: (chunk: string) => void;
  private closed = false;
  private exited = false;
  private exitPromise: Promise<number | null> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: AcpConnectionOptions) {
    this.redactor = options.redactor;
    this.onUpdate = options.onUpdate;
    this.onExit = options.onExit;
    this.stderrHandler = options.onStderr;
  }

  onStderr(handler: (chunk: string) => void): void {
    this.stderrHandler = handler;
  }

  get isAlive(): boolean {
    return (
      !this.closed &&
      !this.exited &&
      this.proc !== null &&
      this.proc.exitCode === null &&
      !this.proc.killed
    );
  }

  getStderr(): string {
    const raw = this.stderrRing.toString();
    return this.redactor ? this.redactor(raw) : raw;
  }

  start(): void {
    if (this.proc) return;
    this.closed = false;
    this.exited = false;
    this.closePromise = null;

    registerProcessExitCleanup();

    const proc = Bun.spawn([this.options.binaryPath, ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    activeConnections.add(this);

    void this.readStdoutLoop(proc.stdout);
    void this.readStderrLoop(proc.stderr);
    this.exitPromise = proc.exited
      .then((code) => {
        this.handleProcessExit(code, proc);
        return code;
      })
      .catch(() => {
        this.handleProcessExit(null, proc);
        return null;
      });
  }

  /** @internal Synchronous best-effort cleanup when the host Bun process exits. */
  forceKillSyncOnProcessExit(): void {
    const proc = this.proc;
    this.closed = true;
    this.proc = null;
    if (proc && !this.exited) {
      try {
        proc.kill(9);
      } catch {}
    }
  }

  async initialize(timeoutMs = 30_000): Promise<AcpCapabilities> {
    if (!this.proc) {
      this.start();
    }

    const result = (await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "agy-8048-bridge",
          version: "0.1.0",
        },
      },
      timeoutMs,
    )) as Record<string, unknown>;

    const agentCaps =
      result?.agentCapabilities && typeof result.agentCapabilities === "object"
        ? (result.agentCapabilities as Record<string, unknown>)
        : {};
    const mcpCaps =
      agentCaps.mcpCapabilities && typeof agentCaps.mcpCapabilities === "object"
        ? (agentCaps.mcpCapabilities as Record<string, unknown>)
        : {};
    const promptCaps =
      agentCaps.promptCapabilities && typeof agentCaps.promptCapabilities === "object"
        ? (agentCaps.promptCapabilities as Record<string, unknown>)
        : {};
    const sessionCaps =
      agentCaps.sessionCapabilities && typeof agentCaps.sessionCapabilities === "object"
        ? (agentCaps.sessionCapabilities as Record<string, unknown>)
        : {};

    if (mcpCaps.http === false) {
      throw new Error(
        "ACP initialize failed: agentCapabilities.mcpCapabilities.http is false (HTTP MCP transport required)",
      );
    }

    const meta =
      result?._meta && typeof result._meta === "object"
        ? (result._meta as Record<string, unknown>)
        : {};
    const antigravityMeta =
      meta.antigravity && typeof meta.antigravity === "object"
        ? (meta.antigravity as Record<string, unknown>)
        : {};
    const sysPrompt =
      antigravityMeta.systemPrompt && typeof antigravityMeta.systemPrompt === "object"
        ? (antigravityMeta.systemPrompt as Record<string, unknown>)
        : {};

    return {
      mcpCapabilities: {
        http: mcpCaps.http !== false,
        sse: typeof mcpCaps.sse === "boolean" ? mcpCaps.sse : undefined,
      },
      promptCapabilities: {
        image: Boolean(promptCaps.image),
      },
      sessionCapabilities: {
        resume: Boolean(sessionCaps.resume),
      },
      systemPromptAppend: typeof sysPrompt.append === "string" ? sysPrompt.append : "",
      raw: result ?? {},
    };
  }

  /**
   * Send a JSON-RPC request and wait for its response.
   * Pass `timeoutMs <= 0` (e.g. `0`) to disable the fixed request timeout for
   * long-running streaming `session/prompt` calls guarded by an idle watchdog.
   */
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<T> {
    if (this.closed || !this.proc) {
      return Promise.reject(new Error(`ACP connection is closed (cannot send ${method})`));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        id,
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request '${method}' (id=${id}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pending.set(id, entry);
      const failPending = (err: Error) => {
        if (!this.pending.has(id)) return;
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        this.pending.delete(id);
        reject(err);
      };

      const written = this.writeStdinLine(`${payload}\n`, failPending);
      if (!written && this.pending.has(id)) {
        failPending(new Error("ACP process is not alive"));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.isAlive) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.writeStdinLine(`${payload}\n`);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    const proc = this.proc;
    const exitPromise = this.exitPromise;
    this.proc = null;

    for (const entry of this.pending.values()) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      entry.reject(new Error("ACP connection closed"));
    }
    this.pending.clear();

    if (!proc || this.exited) {
      activeConnections.delete(this);
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }

    try {
      const endRes: unknown = proc.stdin?.end();
      if (
        endRes !== null &&
        (typeof endRes === "object" || typeof endRes === "function") &&
        typeof (endRes as PromiseLike<unknown>).then === "function"
      ) {
        (endRes as PromiseLike<unknown>).then(undefined, () => {});
      }
    } catch {}
    try {
      proc.kill();
    } catch {}

    this.closePromise = (async () => {
      if (!exitPromise || this.exited) {
        activeConnections.delete(this);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = await Promise.race([
        exitPromise.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), FORCE_KILL_AFTER_MS);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);

      if (timedOut && !this.exited) {
        try {
          proc.kill(9);
        } catch {}
        let postTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          exitPromise.then(() => undefined),
          new Promise<void>((resolve) => {
            postTimer = setTimeout(resolve, POST_FORCE_KILL_WAIT_MS);
            if (typeof postTimer.unref === "function") postTimer.unref();
          }),
        ]);
        if (postTimer) clearTimeout(postTimer);
      }

      activeConnections.delete(this);
    })();

    return this.closePromise;
  }

  private async readStdoutLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length > 0) {
            this.handleFrame(line);
          }
          newlineIdx = buffer.indexOf("\n");
        }
      }
      const tail = (buffer + decoder.decode()).trim();
      if (tail.length > 0) {
        this.handleFrame(tail);
      }
    } catch {
      // Stream closed or process terminated
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderrLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrRing.push(value);
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0 && this.stderrHandler) {
          try {
            this.stderrHandler(text);
          } catch {
            // Ignore handler errors so stderr reading continues uninterrupted
          }
        }
      }
      const tail = decoder.decode();
      if (tail.length > 0 && this.stderrHandler) {
        try {
          this.stderrHandler(tail);
        } catch {
          // Ignore handler errors
        }
      }
    } catch {
      // Stream closed
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        this.handleIncomingRequest(msg.id as number | string, msg.method, msg.params);
      } else {
        this.handleNotification(msg.method, msg.params);
      }
      return;
    }

    if (msg.id !== undefined && msg.id !== null) {
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);

      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as Record<string, unknown>;
        const message = typeof errObj.message === "string" ? errObj.message : "ACP JSON-RPC error";
        const err = new Error(message) as Error & { code?: unknown; data?: unknown };
        err.code = errObj.code;
        err.data = errObj.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update" && params && typeof params === "object") {
      this.onUpdate?.(params as Record<string, unknown>);
    }
  }

  private handleIncomingRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    if (method === "session/request_permission") {
      const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const options = Array.isArray(p.options) ? p.options : [];
      const isAgy8048Tool = extractAgy8048McpToolFromPermission(p) !== null;
      const chosen = selectPermissionOption(options, isAgy8048Tool);

      const outcome = chosen
        ? {
            outcome: "selected",
            optionId: chosen.optionId ?? chosen.id ?? (isAgy8048Tool ? "allow_once" : "reject_once"),
          }
        : {
            outcome: isAgy8048Tool ? "selected" : "cancelled",
            ...(isAgy8048Tool ? { optionId: "allow_once" } : {}),
          };

      this.sendResponse(id, { outcome });
      return;
    }

    this.sendErrorResponse(id, -32601, `Method not found: ${method}`);
  }

  private writeStdinLine(line: string, onError?: (err: Error) => void): boolean {
    if (!this.isAlive || !this.proc?.stdin) {
      return false;
    }

    try {
      const res: unknown = this.proc.stdin.write(line);
      if (
        res !== null &&
        (typeof res === "object" || typeof res === "function") &&
        typeof (res as PromiseLike<unknown>).then === "function"
      ) {
        (res as PromiseLike<unknown>).then(undefined, (err: unknown) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
      return true;
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private sendResponse(id: number | string, result: unknown): void {
    if (!this.isAlive) return;
    this.writeStdinLine(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private sendErrorResponse(id: number | string, code: number, message: string): void {
    if (!this.isAlive) return;
    this.writeStdinLine(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
    );
  }

  private handleProcessExit(
    code: number | null,
    exitedProc?: Subprocess<"pipe", "pipe", "pipe">,
  ): void {
    if (this.exited) return;
    this.exited = true;
    activeConnections.delete(this);

    const wasClosed = this.closed;
    this.closed = true;
    if (!exitedProc || this.proc === exitedProc) {
      this.proc = null;
    }

    const stderr = this.getStderr();
    for (const entry of this.pending.values()) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      entry.reject(new Error(`ACP process exited with code ${code ?? "null"}`));
    }
    this.pending.clear();

    if (!wasClosed) {
      this.onExit?.(code, stderr);
    }
  }
}
