import { decodeGrpcMessage } from "./native-evidence.mjs";
/** Product-only native HTTP2 transport. No App, IPC, research ledger or retry.
 * Prompt tools finish one generation; caller results are new checked API turns.
 */
import http2 from "node:http2";
import net from "node:net";
import crypto from "node:crypto";
import { buildConsumerToolInitial } from "../../native-wire/consumer-tool-codec.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../../native-wire/protobuf.mjs";
import {
  GrpcMessageReader,
  frameGrpcMessage,
} from "../../native-wire/robin-current.mjs";
import { fault } from "./oauth-client-defaults.mjs";
import { PROMPT_MAX_BYTES } from "../openai-contract.mjs";
import { NATIVE_RESPONSE_LIMITS as RESPONSE_LIMITS } from './native-response-limits.mjs';
import { observeNative } from './native-diagnostic.mjs';
import { connectHttp2, resolveOutboundProxy } from './outbound-proxy.mjs';
export const DEFAULT_HTTP2_PING_INTERVAL_MS = 15_000;
export const DEFAULT_HTTP2_PING_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP2_IDLE_TIMEOUT_MS = 60_000;
export const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 5000;
// Node v22 defaults Happy Eyeballs per-family attempt timeout to 250ms, which aborts
// IPv4 connects over high-RTT VPN tunnels when IPv6 returns immediate EHOSTUNREACH.
export function ensureConnectAttemptTimeout(minMs = MIN_CONNECT_ATTEMPT_TIMEOUT_MS) {
  if (
    typeof net.getDefaultAutoSelectFamilyAttemptTimeout === "function" &&
    typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function" &&
    net.getDefaultAutoSelectFamilyAttemptTimeout() < minMs
  ) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(minMs);
  }
}
ensureConnectAttemptTimeout();
export const NATIVE_ORIGIN = "https://robinfrontend-pa.googleapis.com";
export const NATIVE_RPC =
  "/assistant.mobile.robin.RobinService/ProcessQuery";
// ProcessQuery compatibility snapshot checked against native 1.135.1.1291.
// A protocol constant, not a runtime App dependency or copied device identity.
export const NATIVE_COMPATIBILITY_VERSION = "1.135.1.1291";

// Shared HTTP/2 ClientHttp2Session pool, isolated per connect factory and keyed by origin + proxyUrl.
const pooledSessionsByConnect = new WeakMap();
const allPooledEntries = new Set();

function getSessionPool(connectFn) {
  let pool = pooledSessionsByConnect.get(connectFn);
  if (!pool) {
    pool = new Map();
    pooledSessionsByConnect.set(connectFn, pool);
  }
  return pool;
}

export function buildNativeHttp2PoolKey(origin, env = process.env) {
  const proxyUrl = resolveOutboundProxy(origin, env);
  return `${origin}|${proxyUrl ? proxyUrl.href : 'direct'}`;
}

function closeSessionGracefully(session, { force = false } = {}) {
  if (!session) return Promise.resolve();
  if (force || typeof session.close !== 'function') {
    try { session.destroy?.(); } catch {}
    return Promise.resolve();
  }
  if (session.destroyed || session.closed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cleanup);
      resolve();
    };
    const cleanup = setTimeout(() => {
      try { session.destroy?.(); } catch {}
      finish();
    }, 250);
    cleanup.unref?.();
    session.once?.('close', finish);
    try {
      session.close();
    } catch {
      try { session.destroy?.(); } catch {}
      finish();
    }
  });
}

function evictPoolEntry(entry, { closeWhenIdle = false, force = false } = {}) {
  if (!entry) return;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (entry.pool.get(entry.key) === entry) {
    entry.pool.delete(entry.key);
  }
  entry.evicted = true;
  if (entry.activeStreams === 0) {
    allPooledEntries.delete(entry);
    if (closeWhenIdle) {
      void closeSessionGracefully(entry.session, { force });
    }
  }
}

export function acquirePooledHttp2Session({
  origin = NATIVE_ORIGIN,
  connect = connectHttp2,
  env = process.env,
} = {}) {
  const pool = getSessionPool(connect);
  const key = buildNativeHttp2PoolKey(origin, env);
  const existing = pool.get(key);
  if (
    existing &&
    !existing.evicted &&
    !existing.session.closed &&
    !existing.session.destroyed
  ) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.session.ref?.();
    existing.activeStreams++;
    return existing;
  }
  if (existing) {
    evictPoolEntry(existing, { closeWhenIdle: false });
  }
  // http2.connect returns ClientHttp2Session synchronously; inserting into `pool`
  // immediately deduplicates concurrent callers while the handshake is in flight.
  const session = connect(origin);
  const entry = {
    key,
    pool,
    session,
    activeStreams: 1,
    evicted: false,
    idleTimer: null,
  };
  const onGoaway = () => evictPoolEntry(entry, { closeWhenIdle: true });
  const onClose = () => evictPoolEntry(entry, { closeWhenIdle: false });
  const onError = () => evictPoolEntry(entry, { closeWhenIdle: false });
  session.on?.('goaway', onGoaway);
  session.on?.('close', onClose);
  session.on?.('error', onError);
  pool.set(key, entry);
  allPooledEntries.add(entry);
  return entry;
}

export function releasePooledHttp2Session(
  entry,
  { idleTimeoutMs = DEFAULT_HTTP2_IDLE_TIMEOUT_MS } = {},
) {
  if (!entry) return;
  entry.activeStreams = Math.max(0, entry.activeStreams - 1);
  if (entry.activeStreams > 0) return;
  if (entry.evicted || entry.session.closed || entry.session.destroyed) {
    evictPoolEntry(entry, { closeWhenIdle: true });
    return;
  }
  entry.session.unref?.();
  if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.activeStreams === 0) {
        evictPoolEntry(entry, { closeWhenIdle: true });
      }
    }, idleTimeoutMs);
    entry.idleTimer.unref?.();
  }
}

export async function closeNativeHttp2Pool({ force = false } = {}) {
  const entries = [...allPooledEntries];
  const closes = [];
  for (const entry of entries) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.pool.get(entry.key) === entry) {
      entry.pool.delete(entry.key);
    }
    entry.evicted = true;
    allPooledEntries.delete(entry);
    closes.push(closeSessionGracefully(entry.session, { force }));
  }
  await Promise.allSettled(closes);
}

export function getNativeHttp2PoolStats() {
  let activeStreams = 0;
  for (const entry of allPooledEntries) activeStreams += entry.activeStreams;
  return { sessions: allPooledEntries.size, activeStreams };
}

export function openDirectTurn(
  token,
  {
    messages,
    images = [],
    modeCategory = 3,
    thinkingLevel = 2,
    smartModelSelection = false,
    temporaryChat = true,
    continuation,
    timeoutMs = 180000,
    pingIntervalMs = DEFAULT_HTTP2_PING_INTERVAL_MS,
    signal,
    allowNativeTools = false,
    emitHeaders = false,
    diagnostic,
  } = {},
  {
    connect = connectHttp2,
    pool = (connect === connectHttp2),
    idleTimeoutMs = DEFAULT_HTTP2_IDLE_TIMEOUT_MS,
    origin = NATIVE_ORIGIN,
    env = process.env,
  } = {},
) {
  if (
    typeof token !== "string" ||
    !token ||
    token.length > 65536 ||
    /\s/.test(token)
  )
    throw fault("NATIVE_CREDENTIAL_REQUIRED", 503);
  if (
    !Array.isArray(messages) ||
    messages.length !== 1 ||
    messages[0]?.role !== "user" ||
    typeof messages[0].content !== "string" ||
    !messages[0].content
  )
    throw fault("INVALID_NATIVE_INPUT");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw fault("INVALID_TIMEOUT");
  if (signal?.aborted) throw fault("REQUEST_CANCELLED", 499);
  const text = messages[0].content;
  if (Buffer.byteLength(text) > PROMPT_MAX_BYTES) throw fault("PROMPT_TOO_LARGE", 413);
  const initial = buildConsumerToolInitial({
    userText: text,
    images,
    modeCategory,
    thinkingLevel,
    smartModelSelection,
    temporaryChat,
    continuation,
    allowNativeTools,
    clientMetadata: {
      clientType: 21,
      languageCode: "en",
      interfaceLanguageCode: "en",
      clientVersion: NATIVE_COMPATIBILITY_VERSION,
      clientInstanceId: crypto.randomUUID(),
      triggerType: 1,
      uiSource: 1,
    },
  }, { maxInputBytes: PROMPT_MAX_BYTES });
  const wire = Buffer.concat(
    [
      initial,
      Buffer.concat([v(1, 1), m(1007, m(1, Buffer.from(text)))]),
      Buffer.concat([v(1, 1), m(1007, m(2, Buffer.alloc(0)))]),
    ].map(frameGrpcMessage),
  );
  if (wire.length > 16 * 1024 * 1024) throw fault("PROMPT_TOO_LARGE", 413);
  const note = (name, values) => observeNative(diagnostic, 'event', name, values);
  note('transport_open', { mode: modeCategory, thinking: thinkingLevel, timeoutMs, bytes: wire.length });
  let client,
    pooledEntry = null,
    pooledReleased = false,
    onClientError = null,
    onClientGoaway = null,
    socket,
    connectionEnd = null,
    streamCloseCode = null,
    request,
    timer,
    pingTimer = null,
    pingInFlight = false,
    closed = false,
    ended = false,
    error = null,
    waiting = null,
    httpStatus = null,
    grpcStatus = null,
    grpcMessage = null,
    http2ResetCode = null,
    received = 0,
    queued = 0;
  const items = [],
    reader = new GrpcMessageReader({ maxBytes: RESPONSE_LIMITS.frameBytes });
  const detachSocketListeners = () => {
    const current = socket;
    socket = null;
    if (!current) return;
    try { current.removeListener?.('end', socketEnd); } catch {}
    try { current.removeListener?.('close', socketClose); } catch {}
  };
  const connectionEnded = (kind) => {
    if (closed || ended || connectionEnd) return;
    // Node's socketOnClose() locally closes unfinished streams with CANCEL.
    // Capture the code BEFORE that handler so its synthetic 8 is not peer RST evidence.
    const code = request?.rstCode;
    connectionEnd = { rstCode: Number.isInteger(code) ? code : 0 };
    note(`peer_connection_${kind}`, { rstCode: connectionEnd.rstCode });
    if (kind === 'close') detachSocketListeners();
  };
  const socketEnd = () => connectionEnded('end');
  const socketClose = () => connectionEnded('close');
  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    pingInFlight = false;
  };
  const stop = () => {
    clearTimeout(timer);
    stopPing();
    signal?.removeEventListener("abort", abort);
    detachSocketListeners();
    if (pooledEntry && client && onClientError) {
      client.off?.("error", onClientError);
      onClientError = null;
    }
    if (pooledEntry && client && onClientGoaway) {
      client.off?.("goaway", onClientGoaway);
      onClientGoaway = null;
    }
    note('local_stream_close', { requestedCode: ended ? 0 : 8, rstCode: request?.rstCode });
    try {
      request?.close(ended ? http2.constants.NGHTTP2_NO_ERROR : http2.constants.NGHTTP2_CANCEL);
    } catch {}
    if (pooledEntry) {
      if (!pooledReleased) {
        pooledReleased = true;
        releasePooledHttp2Session(pooledEntry, { idleTimeoutMs });
      }
      return;
    }
    const session = client;
    const destroy = () => { note('local_session_destroy'); try { session?.destroy(); } catch {} };
    if (typeof session?.close !== "function") { destroy(); return; }
    // Graceful session shutdown flushes RST_STREAM before closing the socket.
    // A hard bound still prevents a peer from holding cleanup open forever.
    const cleanup = setTimeout(destroy, 250); cleanup.unref();
    session.once?.("close", () => clearTimeout(cleanup));
    try { session.close(); } catch { clearTimeout(cleanup); destroy(); }
  };
  const push = (event) => {
    if (closed) return;
    if (waiting) {
      const resolve = waiting.resolve;
      waiting = null;
      resolve({ value: event, done: false });
    } else {
      const size = event.bytes?.length ?? 0;
      if (queued + size > RESPONSE_LIMITS.queuedBytes) return fail("NATIVE_RECEIVE_LIMIT");
      queued += size;
      items.push(event);
    }
  };
  const fail = (code, status = 502) => {
    if (closed) return;
    note('transport_failure', { code });
    error = fault(code, status);
    closed = true;
    if (waiting) {
      waiting.reject(error);
      waiting = null;
    }
    stop();
  };
  const abort = () => { note('local_signal_abort'); fail("REQUEST_CANCELLED", 499); };
  const events = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (items.length) {
        const value = items.shift();
        queued -= value.bytes?.length ?? 0;
        return Promise.resolve({ value, done: false });
      }
      if (error) return Promise.reject(error);
      if (ended || closed) return Promise.resolve({ done: true });
      if (waiting) return Promise.reject(fault("NATIVE_READER_BUSY", 502));
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    return() {
      cancel();
      return Promise.resolve({ done: true });
    },
  };
  const cancel = () => {
    if (closed) return;
    note('local_cancel');
    closed = true;
    items.length = 0;
    queued = 0;
    if (waiting) {
      waiting.resolve({ done: true });
      waiting = null;
    }
    stop();
  };
  const rejectPeerReset = () => {
    // Sample before our own stop()/cancel(); local cleanup must not become upstream evidence.
    if (closed) return false;
    const code = request?.rstCode;
    if (!Number.isInteger(code) || code <= 0 || code > 0xffffffff) return false;
    if (connectionEnd?.rstCode === 0) {
      streamCloseCode = code;
      fail("NATIVE_STREAM_CLOSED_EARLY");
      return true;
    }
    http2ResetCode = code;
    note('peer_reset', { rstCode: code });
    fail("NATIVE_STREAM_RESET");
    return true;
  };
  const status = (headers) => {
    if (headers["grpc-message"] !== undefined)
      grpcMessage = decodeGrpcMessage(headers["grpc-message"]);
    if (headers[":status"] !== undefined)
      httpStatus = Number(headers[":status"]);
    if (headers["grpc-status"] !== undefined) {
      const parsed = Number(headers["grpc-status"]);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 16)
        return fail("NATIVE_INVALID_STATUS");
      grpcStatus = parsed;
    }
    if (httpStatus === 429 || grpcStatus === 8)
      return fail("NATIVE_QUOTA_EXHAUSTED", 429);
    if ([401, 403].includes(httpStatus) || [7, 16].includes(grpcStatus))
      return fail(
        "NATIVE_PERMISSION_OR_AUTH",
        [401, 403].includes(httpStatus) ? httpStatus : 403,
      );
    if (httpStatus === 503) {
      if (grpcStatus !== null && grpcStatus !== 0 && grpcStatus !== 14)
        return fail("NATIVE_TURN_FAILED");
      return fail("NATIVE_UPSTREAM_UNAVAILABLE", 503);
    }
    if (httpStatus !== null && httpStatus !== 200)
      return fail("NATIVE_HTTP_REJECTED");
  };
  timer = setTimeout(() => { note('transport_deadline'); fail("NATIVE_TRANSPORT_TIMEOUT"); }, timeoutMs);
  timer.unref();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (pool) {
      pooledEntry = acquirePooledHttp2Session({ origin, connect, env });
      client = pooledEntry.session;
    } else {
      client = connect(origin);
    }
    try {
      socket = client.socket;
      socket?.setKeepAlive?.(true, 15_000);
      socket?.prependOnceListener?.('end', socketEnd);
      socket?.prependOnceListener?.('close', socketClose);
    } catch {
      detachSocketListeners();
    }
    onClientError = () => fail("NATIVE_CONNECTION_FAILED");
    client.on("error", onClientError);
    if (diagnostic) {
      onClientGoaway = code => note('peer_goaway', { goawayCode: code });
      client.on('goaway', onClientGoaway);
    }
    if (Number.isInteger(pingIntervalMs) && pingIntervalMs > 0 && typeof client.ping === "function") {
      pingTimer = setInterval(() => {
        if (closed || ended || client.closed || client.destroyed || pingInFlight) return;
        pingInFlight = true;
        try {
          client.ping(() => { pingInFlight = false; });
        } catch {
          pingInFlight = false;
        }
      }, pingIntervalMs);
      pingTimer.unref();
    }
    request = client.request({
      ":method": "POST",
      ":path": NATIVE_RPC,
      authorization: "Bearer " + token,
      "content-type": "application/grpc",
      "grpc-timeout": `${timeoutMs}m`,
      te: "trailers",
      "user-agent": "gemini-app2api/1.0",
    });
    request.on("response", headers => {
      note('peer_headers', { httpStatus: Number(headers[':status']), grpcStatus: Number(headers['grpc-status']) });
      status(headers);
      if (emitHeaders && !closed && httpStatus === 200) push({ type: 'headers', httpStatus });
    });
    request.on("trailers", headers => { note('peer_trailers', { grpcStatus: Number(headers['grpc-status']) }); status(headers); });
    request.on("error", () => {
      note('stream_error', { rstCode: request?.rstCode });
      if (!rejectPeerReset()) fail("NATIVE_STREAM_FAILED");
    });
    request.on("close", () => {
      note('stream_close', { rstCode: request?.rstCode });
      if (!ended && !closed && !rejectPeerReset())
        fail("NATIVE_STREAM_CLOSED_EARLY");
    });
    request.on("data", (chunk) => {
      if (closed) return;
      note('peer_data', { bytes: chunk.length });
      try {
        received += chunk.length;
        if (received > RESPONSE_LIMITS.wireBytes) return fail("NATIVE_RECEIVE_LIMIT");
        for (const bytes of reader.push(chunk)) {
          observeNative(diagnostic, 'frame', bytes);
          push({ type: "frame", bytes });
        }
      } catch {
        fail("NATIVE_FRAME_REJECTED");
      }
    });
    request.on("end", () => {
      note('stream_end', { rstCode: request?.rstCode });
      if (closed) return;
      // Node may emit readable 'end' for RST_STREAM(CANCEL). That is not a successful end.
      if (rejectPeerReset()) return;
      try {
        reader.finish();
        push({ type: "end", httpStatus, grpcStatus });
        ended = true;
        clearTimeout(timer);
        stopPing();
        if (pooledEntry && !pooledReleased) {
          pooledReleased = true;
          signal?.removeEventListener("abort", abort);
          detachSocketListeners();
          if (client && onClientError) {
            client.off?.("error", onClientError);
            onClientError = null;
          }
          if (client && onClientGoaway) {
            client.off?.("goaway", onClientGoaway);
            onClientGoaway = null;
          }
          releasePooledHttp2Session(pooledEntry, { idleTimeoutMs });
        }
      } catch {
        fail("NATIVE_FRAME_REJECTED");
      }
    });
    note('local_half_close', { bytes: wire.length });
    request.end(wire);
  } catch {
    fail("NATIVE_CONNECTION_FAILED");
  }
  return {
    events,
    cancel,
    getSafeStatus: () => ({
      httpStatus,
      grpcStatus,
      ...(grpcMessage ? { grpcMessage } : {}),
      ...(http2ResetCode !== null ? { http2ResetCode } : {}),
      ...(connectionEnd ? { connectionEndObserved: true } : {}),
      ...(streamCloseCode !== null ? { streamCloseCode } : {}),
      ended,
      receivedBytes: received,
      requestBytes: wire.length,
    }),
  };
}
