import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import {
  openDirectTurn,
  NATIVE_COMPATIBILITY_VERSION,
  DEFAULT_HTTP2_PING_INTERVAL_MS,
  ensureConnectAttemptTimeout,
  MIN_CONNECT_ATTEMPT_TIMEOUT_MS,
} from "../src/gateway/native-transport.mjs";
import {
  resolveOutboundProxy,
  createConnectTunnel,
  parseWindowsProxyServer,
  readWindowsSystemProxy,
  clearWindowsSystemProxyCache,
} from "../src/gateway/outbound-proxy.mjs";
import { NativeDirectProvider } from "../src/native-provider.mjs";
import { automaticRecoveryKind } from "../src/gateway/automatic-recovery.mjs";
import {
  GrpcMessageReader,
  frameGrpcMessage,
} from "../native-wire/robin-current.mjs";
import {
  parse,
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
const field = (bytes, n) => parse(bytes).find((f) => f.number === n)?.payload;
const number = (b) => b?.reduce((n, x, i) => n + (x & 127) * 2 ** (7 * i), 0);
async function serverFor(t, handler) {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return () => http2.connect(`http://127.0.0.1:${server.address().port}`);
}
test("product transport sends exactly three native frames and half-closes prompt-only input", async (t) => {
  let frames,
    ended = false;
  const connect = await serverFor(t, (stream, headers) => {
    assert.equal(headers[":path"], "/assistant.mobile.robin.RobinService/ProcessQuery");
    assert.equal(headers["grpc-timeout"], "180000m");
    assert.equal(headers["user-agent"], "gemini-app2api/1.0");
    assert.equal(headers["x-client-pctx"], undefined);
    const reader = new GrpcMessageReader();
    frames = [];
    stream.on("data", (b) => frames.push(...reader.push(b)));
    stream.on("end", () => {
      ended = true;
      reader.finish();
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      stream.end(
        frameGrpcMessage(m(1003, m(1, Buffer.concat([v(9, 1), v(41, 8)])))),
      );
    });
  });
  const raw = openDirectTurn(
    "synthetic-token",
    {
      messages: [{ role: "user", content: "Synthetic query" }],
      modeCategory: 8,
      thinkingLevel: 3,
    },
    { connect },
  );
  const events = [];
  for await (const event of raw.events) {
    events.push(event);
    if (event.type === "end") break;
  }
  raw.cancel();
  assert.equal(ended, true);
  assert.equal(frames.length, 3);
  const initial = field(frames[0], 1000),
    template = field(field(initial, 1001), 1);
  assert.equal(number(field(template, 47)), 8);
  assert.equal(number(field(template, 48)), 3);
  assert.equal(number(field(template, 55)), 0);
  assert.equal(number(field(template, 56)), 0);
  assert.equal(field(initial, 1009), undefined);
  assert.equal(field(initial, 1013), undefined);
  const metadata = field(initial, 1);
  assert.deepEqual(field(template, 13), metadata, "outer and generate metadata must match");
  assert.equal(NATIVE_COMPATIBILITY_VERSION, "1.135.1.1291");
  assert.equal(field(field(metadata, 3), 1).toString(), NATIVE_COMPATIBILITY_VERSION);
  assert.equal(number(field(metadata, 4)), 21);
  assert.match(field(metadata, 23).toString(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(events.at(-1).grpcStatus, 0);
  assert.equal(events.at(-1).httpStatus, 200);
});
for (const [status, code] of [
  [429, "NATIVE_QUOTA_EXHAUSTED"],
  [401, "NATIVE_PERMISSION_OR_AUTH"],
  [403, "NATIVE_PERMISSION_OR_AUTH"],
  [503, "NATIVE_UPSTREAM_UNAVAILABLE"],
])
  test("real local HTTP2 status classification " + status, async (t) => {
    const connect = await serverFor(t, (stream) => {
      stream.on("error", () => {});
      stream.respond({ ":status": status });
      stream.end();
    });
    const turn = openDirectTurn(
      "synthetic-token",
      { messages: [{ role: "user", content: "Synthetic query" }] },
      { connect },
    );
    await assert.rejects(
      async () => {
        for await (const e of turn.events) {
        }
      },
      (e) => e.code === code && e.status === status,
    );
    turn.cancel();
  });
test("abort before connect is rejected; cancelled native calls cannot remain pending", async () => {
  let connects = 0;
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      openDirectTurn(
        "synthetic-token",
        {
          messages: [{ role: "user", content: "fixture" }],
          signal: controller.signal,
        },
        {
          connect: () => {
            connects++;
          },
        },
      ),
    (e) => e.code === "REQUEST_CANCELLED",
  );
  assert.equal(connects, 0);
});
test("truncated actual gRPC frame is rejected rather than successful empty completion", async (t) => {
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    stream.end(Buffer.from([0, 0, 0, 0, 5, 1]));
  });
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "Synthetic query" }] },
    { connect },
  );
  await assert.rejects(
    async () => {
      for await (const e of turn.events) {
      }
    },
    (e) => e.code === "NATIVE_FRAME_REJECTED",
  );
  turn.cancel();
});

test("real local HTTP2 captures the decoded Google error header without interpreting it", async (t) => {
  const message =
    "com.google.assistant.boq.bard.application.utils.BardStatusException: Before proceeding, please accept our terms of service.";
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers({
        "grpc-status": "9",
        "grpc-message": encodeURIComponent(message),
      }),
    );
    stream.end();
  });
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "Synthetic query" }] },
    { connect },
  );
  try {
    for await (const e of turn.events) if (e.type === "end") break;
    assert.equal(turn.getSafeStatus().httpStatus, 200);
    assert.equal(turn.getSafeStatus().grpcStatus, 9);
    assert.equal(turn.getSafeStatus().grpcMessage, message);
  } finally {
    turn.cancel();
  }
});

test("HTTP 200 with trailer gRPC 14 captures UNAVAILABLE evidence cleanly", async (t) => {
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () =>
      stream.sendTrailers({
        "grpc-status": "14",
        "grpc-message": encodeURIComponent("503:Service Unavailable"),
      }),
    );
    stream.end();
  });
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "Synthetic query" }] },
    { connect },
  );
  try {
    for await (const e of turn.events) if (e.type === "end") break;
    assert.equal(turn.getSafeStatus().httpStatus, 200);
    assert.equal(turn.getSafeStatus().grpcStatus, 14);
    assert.equal(turn.getSafeStatus().grpcMessage, "503:Service Unavailable");
  } finally {
    turn.cancel();
  }
});

test("combined HTTP 503 and gRPC headers preserve gRPC evidence and enforce conflict precedence through provider", async (t) => {
  let responseHeaders;
  const connect = await serverFor(t, (stream) => {
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", () => {
      stream.respond(responseHeaders);
      stream.end();
    });
  });
  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    {
      openTurn: (token, options) =>
        openDirectTurn(token, options, { connect }),
      timeoutMs: 1000,
    },
  );

  // HTTP 503 + gRPC 14 preserves grpcStatus: 14 and qualifies as recoverable transport outage.
  responseHeaders = {
    ":status": 503,
    "grpc-status": "14",
    "grpc-message": encodeURIComponent("503:Service Unavailable"),
  };
  await assert.rejects(
    provider.runTurn("synthetic", {
      model: "gemini-argon",
      messages: [{ role: "user", content: "Synthetic query" }],
    }),
    (err) => {
      assert.equal(err.code, "NATIVE_UPSTREAM_UNAVAILABLE");
      assert.equal(err.status, 503);
      assert.equal(err.nativeEvidence.upstreamHttpStatus, 503);
      assert.equal(err.nativeEvidence.grpcStatus, 14);
      assert.equal(err.nativeEvidence.upstreamMessage, "503:Service Unavailable");
      assert.equal(automaticRecoveryKind(err, "gemini-argon"), "transport");
      return true;
    },
  );

  // Conflicting HTTP 503 + gRPC 13 (INTERNAL) preserves grpcStatus: 13 and must not recover as 503 unavailable.
  responseHeaders = {
    ":status": 503,
    "grpc-status": "13",
    "grpc-message": encodeURIComponent("Internal edge error"),
  };
  await assert.rejects(
    provider.runTurn("synthetic", {
      model: "gemini-argon",
      messages: [{ role: "user", content: "Synthetic query" }],
    }),
    (err) => {
      assert.equal(err.code, "NATIVE_TURN_FAILED");
      assert.equal(err.status, 502);
      assert.equal(err.nativeEvidence.upstreamHttpStatus, 503);
      assert.equal(err.nativeEvidence.grpcStatus, 13);
      assert.equal(err.nativeEvidence.upstreamMessage, "Internal edge error");
      assert.equal(automaticRecoveryKind(err, "gemini-argon"), null);
      return true;
    },
  );
});

test("configured native deadline is sent as bounded standard gRPC milliseconds", async (t) => {
  let observed;
  const connect = await serverFor(t, (stream, headers) => {
    observed = headers["grpc-timeout"];
    stream.on("error", () => {});
    stream.resume();
    stream.on("end", () => {
      stream.respond({ ":status": 200, "grpc-status": "0" });
      stream.end();
    });
  });
  const turn = openDirectTurn(
    "synthetic-token",
    {
      messages: [{ role: "user", content: "Synthetic deadline request" }],
      timeoutMs: 1234,
    },
    { connect },
  );
  try {
    for await (const e of turn.events) if (e.type === "end") break;
  } finally {
    turn.cancel();
  }
  assert.equal(observed, "1234m");
  assert.match(observed, /^[0-9]{1,8}m$/);
  let called = false;
  assert.throws(
    () =>
      openDirectTurn(
        "synthetic-token",
        {
          messages: [{ role: "user", content: "Synthetic" }],
          timeoutMs: 600001,
        },
        {
          connect: () => {
            called = true;
          },
        },
      ),
    (e) => e.code === "INVALID_TIMEOUT",
  );
  assert.equal(called, false);
});

test("mid-stream peer TCP FIN and TCP RST do not throw ERR_HTTP2_SOCKET_UNBOUND and surface recoverable transport errors", async (t) => {
  for (const mode of ["fin", "rst"]) {
    let rawSocket = null;
    const server = http2.createServer();
    server.on("connection", (sock) => {
      rawSocket = sock;
    });
    server.on("stream", (stream) => {
      stream.on("error", () => {});
      stream.resume();
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      setImmediate(() => {
        if (mode === "fin") rawSocket?.end();
        else rawSocket?.destroy();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => server.close(r)));

    const connect = () => http2.connect(`http://127.0.0.1:${server.address().port}`);
    const provider = new NativeDirectProvider(
      { getValidAccessToken: async () => "synthetic-token" },
      {
        openTurn: (token, options) => openDirectTurn(token, options, { connect }),
        timeoutMs: 1000,
      },
    );

    await assert.rejects(
      provider.runTurn("synthetic", {
        model: "gemini-argon",
        messages: [{ role: "user", content: `Synthetic ${mode} drop` }],
      }),
      (err) => {
        assert.notEqual(err.code, "ERR_HTTP2_SOCKET_UNBOUND");
        assert.equal(err.status, 502);
        assert.ok(
          ["NATIVE_STREAM_CLOSED_EARLY", "NATIVE_STREAM_RESET"].includes(err.code),
          `Unexpected error code for ${mode}: ${err.code}`,
        );
        assert.equal(automaticRecoveryKind(err, "gemini-argon"), "transport");
        return true;
      },
    );
  }
});

test("outbound connect attempt timeout floor prevents 250ms Happy Eyeballs VPN timeouts without lowering higher user settings", (t) => {
  const prev = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(prev));

  assert.ok(
    prev >= MIN_CONNECT_ATTEMPT_TIMEOUT_MS,
    `Expected module-load timeout floor >= ${MIN_CONNECT_ATTEMPT_TIMEOUT_MS}, got ${prev}`,
  );

  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  ensureConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), MIN_CONNECT_ATTEMPT_TIMEOUT_MS);

  net.setDefaultAutoSelectFamilyAttemptTimeout(8000);
  ensureConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 8000);
});

test("native HTTP/2 transport sends periodic PING keepalive frames during silent thinking turns", async (t) => {
  assert.equal(DEFAULT_HTTP2_PING_INTERVAL_MS, 15_000);
  let pingsReceived = 0;
  const server = http2.createServer();
  server.on("session", (session) => {
    session.on("ping", () => { pingsReceived++; });
  });
  server.on("stream", (stream) => {
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    setTimeout(() => {
      stream.write(frameGrpcMessage(m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from("Alive")))), v(9, 1), m(30, Buffer.from("Used 4 Neon High model")), v(41, 3), v(42, 2)])))));
      stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end();
    }, 95);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const connect = () => http2.connect(`http://127.0.0.1:${server.address().port}`);
  const turn = openDirectTurn(
    "synthetic-token",
    { messages: [{ role: "user", content: "hi" }], pingIntervalMs: 25, timeoutMs: 2000 },
    { connect },
  );
  const events = [];
  try {
    for await (const ev of turn.events) events.push(ev);
  } finally {
    turn.cancel();
  }
  assert.equal(events.at(-1).type, "end");
  assert.ok(pingsReceived >= 2, `Expected >= 2 HTTP/2 PING keepalives during silent turn, got ${pingsReceived}`);
});

test("outbound proxy resolver honors HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, and NO_PROXY rules", () => {
  assert.equal(resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {}), null);
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { HTTPS_PROXY: "http://127.0.0.1:7890" })?.href,
    "http://127.0.0.1:7890/",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { https_proxy: "http://user:pass@127.0.0.1:7890" })?.port,
    "7890",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { ALL_PROXY: "http://127.0.0.1:8080" })?.port,
    "8080",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost, .googleapis.com",
    }),
    null,
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "*",
    }),
    null,
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { HTTPS_PROXY: "socks5://127.0.0.1:1080" })?.href,
    "socks5://127.0.0.1:1080",
  );
  assert.equal(
    resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", { ALL_PROXY: "socks5h://u:p@127.0.0.1:10808" })?.protocol,
    "socks5h:",
  );
});

test("Windows system proxy parsing and registry fallback", () => {
  assert.equal(parseWindowsProxyServer("127.0.0.1:7890", "https:")?.href, "http://127.0.0.1:7890/");
  assert.equal(
    parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:10808", "https:")?.href,
    "http://127.0.0.1:7891/",
  );
  assert.equal(
    parseWindowsProxyServer("http=127.0.0.1:7890;socks=127.0.0.1:10808", "http:")?.href,
    "http://127.0.0.1:7890/",
  );
  assert.equal(
    parseWindowsProxyServer("socks=127.0.0.1:10808", "https:")?.href,
    "socks5://127.0.0.1:10808",
  );
  assert.equal(parseWindowsProxyServer("", "https:"), null);
  assert.equal(parseWindowsProxyServer("not a valid proxy\n", "https:"), null);

  clearWindowsSystemProxyCache();
  const regEnabledOutput = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:10808",
    "    ProxyOverride    REG_SZ    localhost;127.*;*.local;<local>",
    "",
  ].join("\r\n");

  const resolved = resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {}, {
    platform: "win32",
    allowWindowsSystemProxy: true,
    spawnSync: () => ({ status: 0, stdout: regEnabledOutput }),
  });
  assert.equal(resolved?.href, "http://127.0.0.1:7891/");

  const bypassed = resolveOutboundProxy("https://myserver.local/test", {}, {
    platform: "win32",
    allowWindowsSystemProxy: true,
    spawnSync: () => ({ status: 0, stdout: regEnabledOutput }),
  });
  assert.equal(bypassed, null);

  const disabled = resolveOutboundProxy("https://robinfrontend-pa.googleapis.com", {}, {
    platform: "win32",
    allowWindowsSystemProxy: true,
    spawnSync: () => ({
      status: 0,
      stdout: "    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n",
    }),
  });
  assert.equal(disabled, null);

  const parsedReg = readWindowsSystemProxy({}, {
    spawnSync: () => ({ status: 0, stdout: regEnabledOutput }),
  });
  assert.equal(parsedReg.enabled, true);
  assert.equal(parsedReg.proxyServer, "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:10808");
});

test("HTTP CONNECT tunnel forwards HTTP/2 traffic with Proxy-Authorization and fails cleanly on proxy rejection", async (t) => {
  // Upstream HTTP/2 target
  const target = http2.createServer();
  target.on("stream", (stream) => {
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.write(frameGrpcMessage(m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from("Proxied")))), v(9, 1), m(30, Buffer.from("Used 4 Neon High model")), v(41, 3), v(42, 2)])))));
    stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end();
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => target.close(r)));

  // Local HTTP CONNECT proxy
  let seenAuth = null;
  let rejectNext = false;
  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    seenAuth = req.headers["proxy-authorization"] || null;
    if (rejectNext) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => proxy.close(r)));

  const proxyUrl = new URL(`http://alice:secret@127.0.0.1:${proxy.address().port}`);
  const targetPort = target.address().port;
  const connectViaProxy = () =>
    http2.connect(`http://127.0.0.1:${targetPort}`, {
      createConnection: () => createConnectTunnel(proxyUrl, "127.0.0.1", targetPort),
    });

  const provider = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    { openTurn: (token, options) => openDirectTurn(token, options, { connect: connectViaProxy }), timeoutMs: 2000 },
  );
  const res = await provider.runTurn("synthetic", {
    model: "gemini-neon",
    messages: [{ role: "user", content: "hello via proxy" }],
  });
  assert.equal(res.content, "Proxied");
  assert.equal(seenAuth, "Basic " + Buffer.from("alice:secret").toString("base64"));

  // Proxy 407 rejection surfaces cleanly as NATIVE_CONNECTION_FAILED (502)
  rejectNext = true;
  await assert.rejects(
    provider.runTurn("synthetic", {
      model: "gemini-neon",
      messages: [{ role: "user", content: "should fail" }],
    }),
    (err) => {
      assert.equal(err.status, 502);
      assert.ok(
        ["NATIVE_CONNECTION_FAILED", "NATIVE_STREAM_CLOSED_EARLY", "NATIVE_STREAM_FAILED", "NATIVE_STREAM_RESET"].includes(err.code),
        `Unexpected proxy error code: ${err.code}`,
      );
      return true;
    },
  );
});

test("SOCKS5 tunnel supports no-auth, username/password auth, and handles handshake errors", async (t) => {
  const target = http2.createServer();
  target.on("stream", (stream) => {
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.write(frameGrpcMessage(m(1003, m(1, Buffer.concat([m(1, m(2, m(1, Buffer.from("Socks5OK")))), v(9, 1), m(30, Buffer.from("Used 4 Neon High model")), v(41, 3), v(42, 2)])))));
    stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end();
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => target.close(r)));
  const targetPort = target.address().port;

  let requireAuth = false;
  let forceRejectConnect = false;
  let seenCreds = null;
  let seenAtyp = null;
  let seenHost = null;

  const socksServer = net.createServer((client) => {
    let stage = "greeting";
    let buf = Buffer.alloc(0);
    let upstream = null;

    client.on("data", (chunk) => {
      if (stage === "relay") {
        upstream?.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        const methods = buf.subarray(2, 2 + nmethods);
        buf = buf.subarray(2 + nmethods);
        if (requireAuth) {
          if (!methods.includes(0x02)) {
            client.write(Buffer.from([0x05, 0xff]));
            client.destroy();
            return;
          }
          stage = "auth";
          client.write(Buffer.from([0x05, 0x02]));
        } else {
          stage = "connect";
          client.write(Buffer.from([0x05, 0x00]));
        }
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const user = buf.subarray(2, 2 + ulen).toString("utf8");
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        buf = buf.subarray(3 + ulen + plen);
        seenCreds = `${user}:${pass}`;
        if (user !== "socksuser" || pass !== "sockspass") {
          client.write(Buffer.from([0x01, 0x01]));
          client.destroy();
          return;
        }
        stage = "connect";
        client.write(Buffer.from([0x01, 0x00]));
      }
      if (stage === "connect") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        seenAtyp = atyp;
        let offset = 4;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          seenHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          const dlen = buf[4];
          if (buf.length < 4 + 1 + dlen + 2) return;
          seenHost = buf.subarray(5, 5 + dlen).toString("utf8");
          offset = 5 + dlen;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          offset = 20;
        } else {
          client.destroy();
          return;
        }
        const port = buf.readUInt16BE(offset);
        const extra = buf.subarray(offset + 2);
        buf = Buffer.alloc(0);

        if (forceRejectConnect) {
          client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
          return;
        }

        const connectHost = atyp === 0x03 ? "127.0.0.1" : seenHost;
        upstream = net.connect(port, connectHost, () => {
          stage = "relay";
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (extra.length > 0) upstream.write(extra);
          upstream.on("data", (d) => client.write(d));
          upstream.on("end", () => client.end());
          upstream.on("error", () => client.destroy());
        });
        upstream.on("error", () => client.destroy());
      }
    });
    client.on("error", () => upstream?.destroy());
  });
  await new Promise((r) => socksServer.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => socksServer.close(r)));
  const socksPort = socksServer.address().port;

  // 1. No-auth SOCKS5 with IPv4 target
  const noAuthUrl = new URL(`socks5://127.0.0.1:${socksPort}`);
  const providerNoAuth = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    {
      openTurn: (token, options) =>
        openDirectTurn(token, options, {
          connect: () =>
            http2.connect(`http://127.0.0.1:${targetPort}`, {
              createConnection: () => createConnectTunnel(noAuthUrl, "127.0.0.1", targetPort),
            }),
        }),
      timeoutMs: 2000,
    },
  );
  const res1 = await providerNoAuth.runTurn("synthetic", {
    model: "gemini-neon",
    messages: [{ role: "user", content: "hello socks5" }],
  });
  assert.equal(res1.content, "Socks5OK");
  assert.equal(seenAtyp, 0x01);

  // 2. Username/password auth SOCKS5h with domain target (ATYP 0x03)
  requireAuth = true;
  const authUrl = new URL(`socks5h://socksuser:sockspass@127.0.0.1:${socksPort}`);
  const providerAuth = new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic-token" },
    {
      openTurn: (token, options) =>
        openDirectTurn(token, options, {
          connect: () =>
            http2.connect(`http://localhost:${targetPort}`, {
              createConnection: () => createConnectTunnel(authUrl, "localhost", targetPort),
            }),
        }),
      timeoutMs: 2000,
    },
  );
  const res2 = await providerAuth.runTurn("synthetic", {
    model: "gemini-neon",
    messages: [{ role: "user", content: "hello socks5 auth" }],
  });
  assert.equal(res2.content, "Socks5OK");
  assert.equal(seenCreds, "socksuser:sockspass");
  assert.equal(seenAtyp, 0x03);
  assert.equal(seenHost, "localhost");

  // 3. Bad credentials fail cleanly
  const badAuthUrl = new URL(`socks5://wrong:creds@127.0.0.1:${socksPort}`);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const tunnel = createConnectTunnel(badAuthUrl, "127.0.0.1", targetPort);
      tunnel.on("error", reject);
      tunnel.write("ping");
    }),
    /SOCKS5_AUTH_FAILED/,
  );

  // 4. Connection refused reply surfaces cleanly
  requireAuth = false;
  forceRejectConnect = true;
  await assert.rejects(
    new Promise((resolve, reject) => {
      const tunnel = createConnectTunnel(noAuthUrl, "127.0.0.1", targetPort);
      tunnel.on("error", reject);
      tunnel.write("ping");
    }),
    /SOCKS5_CONNECT_FAILED_5/,
  );
});
