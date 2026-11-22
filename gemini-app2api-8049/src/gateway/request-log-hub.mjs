import { fault } from "./state.mjs";

function formatSseEvent(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class RequestLogHub {
  #maxCompleted;
  #inFlight = new Map();
  #completed = [];
  #sseClients = new Set();
  #pingTimer = null;
  #closed = false;

  constructor({ maxCompleted = 200, pingIntervalMs = 20000 } = {}) {
    this.#maxCompleted = maxCompleted;
    if (pingIntervalMs > 0) {
      this.#pingTimer = setInterval(() => {
        if (this.#closed || this.#sseClients.size === 0) return;
        this.#broadcast("ping", { ts: Date.now() });
      }, pingIntervalMs);
      this.#pingTimer.unref?.();
    }
  }

  #writeEvent(res, frame) {
    if (res.destroyed || res.writableEnded) {
      this.#sseClients.delete(res);
      return;
    }
    try {
      res.write(frame);
    } catch {
      this.#sseClients.delete(res);
      try {
        if (!res.destroyed && !res.writableEnded) res.end();
      } catch {
        // Ignore cleanup errors on broken socket
      }
    }
  }

  #broadcast(eventName, payload) {
    if (this.#closed || this.#sseClients.size === 0) return;
    const frame = formatSseEvent(eventName, payload);
    for (const res of [...this.#sseClients]) {
      this.#writeEvent(res, frame);
    }
  }

  listAll() {
    const running = [...this.#inFlight.values()]
      .map((entry) => entry.record)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return [...running, ...this.#completed].slice(0, this.#maxCompleted);
  }

  listCompleted() {
    return [...this.#completed];
  }

  start(id, record, controller) {
    this.#inFlight.set(id, { record, controller });
    this.#broadcast("request:start", record);
  }

  updateAttempt(requestId, payload) {
    this.#broadcast("request:attempt", { requestId, ...payload });
  }

  finish(id, finalRecord) {
    this.#inFlight.delete(id);
    this.#completed.unshift(finalRecord);
    if (this.#completed.length > this.#maxCompleted) {
      this.#completed.length = this.#maxCompleted;
    }
    this.#broadcast("request:finish", finalRecord);
  }

  cancel(id) {
    const entry = this.#inFlight.get(id);
    if (!entry) return false;
    entry.controller.abort(fault("REQUEST_CANCELLED", 499));
    return true;
  }

  clearCompleted() {
    const cleared = this.#completed.length;
    this.#completed.length = 0;
    this.#broadcast("requests", this.listAll());
    return cleared;
  }

  subscribe(req, res) {
    if (this.#closed) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    req.setTimeout?.(0);
    res.setTimeout?.(0);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    this.#sseClients.add(res);
    const cleanup = () => {
      this.#sseClients.delete(res);
    };
    req.once("close", cleanup);
    res.once("close", cleanup);
    res.once("error", cleanup);

    this.#writeEvent(res, formatSseEvent("requests", this.listAll()));
  }

  close() {
    this.#closed = true;
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    for (const res of [...this.#sseClients]) {
      this.#sseClients.delete(res);
      try {
        if (!res.destroyed && !res.writableEnded) res.end();
      } catch {
        // Ignore close errors
      }
    }
  }
}
