import assert from "node:assert/strict";
import test from "node:test";
import { HerdrNdjsonTransport, HerdrTimeoutError, HerdrUnavailableError } from "../../src/herdr/transport.ts";
import { expectResult, HerdrProtocolError, toWireRecord } from "../../src/herdr/protocol.ts";
import { startFakeHerdrServer } from "../support/fake-herdr-server.ts";

async function eventually(predicate: () => boolean, timeout = 1_000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }

test("NDJSON transport uses unique ids and one bounded connection per normal request", async () => {
  const server = await startFakeHerdrServer((request) => ({ id: request.id!, result: { type: "ok", echoed: request.method! } }));
  try {
    const transport = new HerdrNdjsonTransport({ socketPath: server.socketPath, idFactory: (() => { let id = 0; return () => `r${++id}`; })() });
    assert.equal(expectResult(await transport.request("pane.close", toWireRecord({ pane_id: "p" })), "ok").echoed, "pane.close");
    await transport.request("tab.close", toWireRecord({ tab_id: "t" }));
    assert.deepEqual(server.requests.map((item) => item.id), ["r1", "r2"]); await eventually(() => server.openSocketCount === 0);
  } finally { await server.close(); }
});

test("transport rejects malformed and truncated responses without socket leaks", async (t) => {
  for (const [name, chunks] of [["malformed", ["not-json\n"]], ["truncated", ["{\"id\":\"r1\""]]] as const) {
    await t.test(name, async () => {
      const server = await startFakeHerdrServer(() => ({ $fake: "raw", chunks, end: true }));
      try { const transport = new HerdrNdjsonTransport({ socketPath: server.socketPath, idFactory: () => "r1" }); await assert.rejects(transport.request("ping"), HerdrUnavailableError); await eventually(() => server.openSocketCount === 0); } finally { await server.close(); }
    });
  }
});

test("response timeout and abort complete within bounds and release sockets", async () => {
  const server = await startFakeHerdrServer(() => ({ $fake: "none" }));
  try {
    const transport = new HerdrNdjsonTransport({ socketPath: server.socketPath, responseTimeoutMs: 40 });
    const started = Date.now(); await assert.rejects(transport.request("ping"), HerdrTimeoutError); assert.ok(Date.now() - started < 500);
    const controller = new AbortController(); const pending = transport.request("ping", {}, { signal: controller.signal, responseTimeoutMs: 5_000 }); controller.abort(); await assert.rejects(pending, /abort/i);
    await eventually(() => server.openSocketCount === 0);
  } finally { await server.close(); }
});

test("fake broadcasts prune closing clients while active malformed events still fail the protocol client", async () => {
  const server = await startFakeHerdrServer((request) => ({ id: request.id!, result: { type: "subscription_started" } }));
  try {
    const transport = new HerdrNdjsonTransport({ socketPath: server.socketPath }); const stream = await transport.subscribe(toWireRecord({ subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }] }));
    const next = stream[Symbol.asyncIterator]().next(); server.broadcastSubscriptions({ event: "unsupported.event", data: {} });
    await assert.rejects(next, HerdrProtocolError); stream.close();
    for (let index = 0; index < 100; index++) server.broadcast({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } });
    await eventually(() => server.openSocketCount === 0); assert.doesNotThrow(() => server.broadcastSubscriptions({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } }));
  } finally { await server.close(); }
});

test("subscription acknowledges once, decodes pushed events, and closes cleanly", async () => {
  const server = await startFakeHerdrServer((request) => ({ id: request.id!, result: { type: "subscription_started" } }));
  try {
    const transport = new HerdrNdjsonTransport({ socketPath: server.socketPath }); const stream = await transport.subscribe(toWireRecord({ subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }] }));
    const next = stream[Symbol.asyncIterator]().next(); server.broadcast({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done", future: true } });
    const received = await next; assert.equal(received.value?.data.agent_status, "done"); assert.equal(received.value?.data.future, true);
    stream.close(); await eventually(() => server.openSocketCount === 0);
  } finally { await server.close(); }
});
