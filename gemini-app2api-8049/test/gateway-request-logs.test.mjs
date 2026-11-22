import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fixture } from "./gateway-fixture.mjs";

const chat = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "Synthetic request" }],
};

async function setup(t, options) {
  const f = await fixture(options);
  t.after(f.close);
  return f;
}

async function until(check, message = "Condition not met in time") {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function holdTurns(f, t) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await f.close();
  });
  const open = f.app.provider.openTurn;
  f.app.provider.openTurn = (...args) => {
    const turn = open(...args);
    const events = turn.events;
    return {
      ...turn,
      events: (async function* () {
        await gate;
        yield* events;
      })(),
    };
  };
  return release;
}

function connectSse(base, cookie) {
  const events = [];
  let buffer = "";
  let ended = false;
  const req = http.get(
    `${base}/admin/api/events`,
    { headers: { Cookie: cookie } },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventName = "message";
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }
          if (dataLines.length > 0) {
            events.push({
              event: eventName,
              data: JSON.parse(dataLines.join("\n")),
            });
          }
        }
      });
      res.on("end", () => {
        ended = true;
      });
    },
  );
  req.on("error", () => {
    ended = true;
  });
  return {
    events,
    get ended() {
      return ended;
    },
    close() {
      req.destroy();
    },
  };
}

test("GET /admin/api/requests returns enhanced App2ApiRequestLog fields and preserves overview", async (t) => {
  const f = await setup(t);
  const res = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(res.status, 200);

  const logsRes = await f.admin("requests");
  assert.equal(logsRes.status, 200);
  const logs = await logsRes.json();
  assert.equal(Array.isArray(logs), true);
  assert.equal(logs.length, 1);

  const log = logs[0];
  assert.equal(typeof log.id, "string");
  assert.equal(log.timestamp, log.at);
  assert.equal(log.startedAt, log.at);
  assert.equal(log.state, "completed");
  assert.equal(log.stream, false);
  assert.equal(log.protocol, "chat");
  assert.equal(typeof log.accountId, "string");
  assert.equal(typeof log.accountLabel, "string");
  assert.equal(log.switchCount, 0);
  assert.equal(typeof log.firstEventMs, "number");
  assert.ok(log.firstEventMs >= 0);
  assert.equal(log.inputTokens, null);
  assert.equal(log.outputTokens, null);
  assert.equal(log.cachedTokens, null);
  assert.equal(log.cacheHit, false);
  assert.equal(log.error, null);
  assert.equal(Array.isArray(log.attempts), true);
  assert.equal(log.attempts.length, 1);

  const attempt = log.attempts[0];
  assert.equal(attempt.index, 0);
  assert.equal(attempt.accountId, log.accountId);
  assert.equal(attempt.accountLabel, log.accountLabel);
  assert.equal(attempt.status, "success");
  assert.equal(attempt.httpStatus, 200);
  assert.equal(attempt.requestedModel, "gemini-neon");
  assert.equal(typeof attempt.durationMs, "number");
  assert.equal(typeof attempt.firstEventMs, "number");

  const overview = await f.admin("overview").then((r) => r.json());
  assert.equal(overview.requests.length, 1);
  assert.equal(overview.requests[0].id, log.id);
  assert.equal(overview.requests[0].state, "completed");
});

test("GET /admin/api/events streams requests snapshot, request:start, request:attempt, request:finish and closes cleanly", async (t) => {
  const f = await setup(t);
  const sse = connectSse(f.base, f.cookie);
  t.after(() => sse.close());

  await until(() => sse.events.some((e) => e.event === "requests"), "Did not receive initial requests snapshot");
  assert.deepEqual(sse.events[0].data, []);

  const res = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(res.status, 200);

  await until(() => sse.events.some((e) => e.event === "request:finish"), "Did not receive request:finish");

  const names = sse.events.map((e) => e.event);
  assert.ok(names.includes("requests"));
  assert.ok(names.includes("request:start"));
  assert.ok(names.includes("request:attempt"));
  assert.ok(names.includes("request:finish"));

  const startEvt = sse.events.find((e) => e.event === "request:start");
  assert.equal(startEvt.data.state, "running");

  const finishEvt = sse.events.find((e) => e.event === "request:finish");
  assert.equal(finishEvt.data.state, "completed");
  assert.equal(finishEvt.data.attempts.length, 1);

  await f.close();
  await until(() => sse.ended, "SSE stream did not close cleanly on app.close()");
});

test("POST /admin/api/requests/:id/cancel aborts in-flight request and returns 404 for unknown id", async (t) => {
  const f = await setup(t);
  const release = holdTurns(f, t);

  const notFound = await f.admin("requests/req_nonexistent/cancel", {
    method: "POST",
    body: {},
  });
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { ok: false, error: "REQUEST_NOT_FOUND" });

  const inFlightPromise = f.api("/v1/chat/completions", { method: "POST", body: chat });

  let runningId = null;
  await until(() => f.seen.length > 0, "Request did not enter provider");

  const runningLogs = await f.admin("requests").then((r) => r.json());
  assert.equal(runningLogs.length, 1);
  assert.equal(runningLogs[0].state, "running");
  runningId = runningLogs[0].id;

  const cancelRes = await f.admin(`requests/${runningId}/cancel`, {
    method: "POST",
    body: {},
  });
  assert.equal(cancelRes.status, 200);
  assert.deepEqual(await cancelRes.json(), { ok: true, id: runningId });

  release();
  const apiRes = await inFlightPromise;
  assert.equal(apiRes.status, 499);

  const finalLogs = await f.admin("requests").then((r) => r.json());
  assert.equal(finalLogs.length, 1);
  assert.equal(finalLogs[0].id, runningId);
  assert.equal(finalLogs[0].state, "cancelled");
  assert.equal(finalLogs[0].cancellationSource, "admin_cancel");
  assert.ok(["REQUEST_CANCELLED", "NATIVE_TURN_ABORTED"].includes(finalLogs[0].errorCode));
});

test("DELETE /admin/api/requests clears completed history, keeps in-flight, and broadcasts SSE", async (t) => {
  const f = await setup(t);
  const res1 = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(res1.status, 200);

  const sse = connectSse(f.base, f.cookie);
  t.after(() => sse.close());
  await until(() => sse.events.some((e) => e.event === "requests"));
  const initialCount = sse.events.length;

  const release = holdTurns(f, t);
  const inFlightPromise = f.api("/v1/chat/completions", { method: "POST", body: chat });
  await until(() => f.seen.length >= 2, "Second request did not enter provider");

  const delRes = await f.admin("requests", { method: "DELETE" });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { ok: true, cleared: 1 });

  await until(
    () => sse.events.slice(initialCount).some((e) => e.event === "requests"),
    "Did not broadcast requests snapshot after DELETE",
  );

  const currentLogs = await f.admin("requests").then((r) => r.json());
  assert.equal(currentLogs.length, 1);
  assert.equal(currentLogs[0].state, "running");

  release();
  await inFlightPromise;
});
