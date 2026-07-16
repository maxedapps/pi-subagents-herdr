import assert from "node:assert/strict";
import test from "node:test";
import { HerdrClient } from "../../src/herdr/client.ts";
import { decodeEvent } from "../../src/herdr/protocol.ts";
import { HerdrLiveCache, HerdrSubscriptionManager } from "../../src/herdr/subscriptions.ts";
import { HerdrNdjsonTransport } from "../../src/herdr/transport.ts";
import { startFakeHerdrServer } from "../support/fake-herdr-server.ts";
import { pane, snapshot, success, tab, workspace } from "./fixtures.ts";

async function eventually(predicate: () => boolean, timeout = 2_000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }

test("snapshot bootstrap and events update cache without collapsing done to idle", () => {
  const cache = new HerdrLiveCache(); cache.replace(snapshot, 1);
  cache.apply(decodeEvent({ event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } }), 2);
  assert.equal(cache.panes.get("w1:p1")?.agent_status, "done");
  const moved = { ...pane, pane_id: "w2:p9", workspace_id: "w2", tab_id: "w2:t1", agent_status: "idle" as const };
  const createdWorkspace = { ...workspace, workspace_id: "w2", active_tab_id: "w2:t1" }; const createdTab = { ...tab, tab_id: "w2:t1", workspace_id: "w2" };
  cache.apply(decodeEvent({ event: "pane_moved", data: { type: "pane_moved", previous_pane_id: "w1:p1", previous_workspace_id: "w1", previous_tab_id: "w1:t1", pane: moved, created_workspace: createdWorkspace, created_tab: createdTab, closed_tab_id: "w1:t1", closed_workspace_id: "w1" } }), 3);
  assert.equal(cache.panes.has("w1:p1"), false); assert.equal(cache.panes.get("w2:p9")?.terminal_id, "term_parent");
  assert.equal(cache.workspaces.has("w1"), false); assert.equal(cache.tabs.has("w1:t1"), false); assert.equal(cache.workspaces.get("w2")?.active_tab_id, "w2:t1"); assert.equal(cache.tabs.get("w2:t1")?.workspace_id, "w2");
});

test("subscription manager resnapshots before connected and after bounded reconnect", async () => {
  let snapshots = 0;
  const server = await startFakeHerdrServer((request) => {
    if (request.method === "session.snapshot") { snapshots += 1; return success(request.id, { type: "session_snapshot", snapshot }); }
    if (request.method === "events.subscribe") return success(request.id, { type: "subscription_started" });
    return success(request.id, { type: "ok" });
  });
  const health: string[] = [];
  const manager = new HerdrSubscriptionManager({ client: new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })), ownedPaneIds: () => ["w1:p1"], backoffMs: [10], reconcileIntervalMs: 10_000, onHealth: (value) => health.push(value) });
  try {
    await manager.start(); await eventually(() => manager.cache.health === "connected"); assert.equal(snapshots, 1);
    const subscriptionRequest = server.requests.find((request) => request.method === "events.subscribe"); assert.ok(JSON.stringify(subscriptionRequest?.params).includes("pane.agent_status_changed"));
    server.broadcast({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" } }); await eventually(() => manager.cache.panes.get("w1:p1")?.agent_status === "blocked");
    server.disconnectClients(); await eventually(() => snapshots >= 2 && manager.cache.health === "connected"); assert.ok(health.includes("unavailable"));
  } finally { await manager.stop(); await eventually(() => server.openSocketCount === 0); await server.close(); }
});

test("subscription acknowledgement forms a snapshot barrier and replays in-flight events", async () => {
  let server!: Awaited<ReturnType<typeof startFakeHerdrServer>>;
  server = await startFakeHerdrServer((request) => {
    if (request.method === "events.subscribe") return success(request.id, { type: "subscription_started" });
    if (request.method === "session.snapshot") {
      server.broadcastSubscriptions({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } });
      return success(request.id, { type: "session_snapshot", snapshot });
    }
    return success(request.id, { type: "ok" });
  });
  const manager = new HerdrSubscriptionManager({ client: new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })), ownedPaneIds: () => ["w1:p1"], reconcileIntervalMs: 10_000, backoffMs: [5] });
  try {
    await manager.start(); await eventually(() => manager.cache.health === "connected" && manager.cache.panes.get("w1:p1")?.agent_status === "done");
    assert.deepEqual(server.requests.slice(0, 2).map((request) => request.method), ["events.subscribe", "session.snapshot"]);
  } finally { await manager.stop(); await server.close(); }
});

test("periodic reconciliation is serialized so later events cannot be overwritten by a stale snapshot", async () => {
  let snapshots = 0; let server!: Awaited<ReturnType<typeof startFakeHerdrServer>>;
  server = await startFakeHerdrServer(async (request) => {
    if (request.method === "events.subscribe") return success(request.id, { type: "subscription_started" });
    if (request.method === "session.snapshot") {
      snapshots += 1;
      if (snapshots === 2) { server.broadcastSubscriptions({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } }); await new Promise((resolve) => setTimeout(resolve, 30)); }
      return success(request.id, { type: "session_snapshot", snapshot });
    }
    return success(request.id, { type: "ok" });
  });
  const manager = new HerdrSubscriptionManager({ client: new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })), ownedPaneIds: () => ["w1:p1"], reconcileIntervalMs: 15, backoffMs: [5] });
  try { await manager.start(); await eventually(() => snapshots >= 2 && manager.cache.panes.get("w1:p1")?.agent_status === "done"); assert.equal(manager.cache.panes.get("w1:p1")?.agent_status, "done"); } finally { await manager.stop(); await server.close(); }
});

test("ownership subscription rebuild aborts stale stream and keeps last-known cache", async () => {
  let panes = ["w1:p1"];
  const server = await startFakeHerdrServer((request) => request.method === "session.snapshot" ? success(request.id, { type: "session_snapshot", snapshot }) : success(request.id, { type: "subscription_started" }));
  const manager = new HerdrSubscriptionManager({ client: new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })), ownedPaneIds: () => panes, backoffMs: [5], reconcileIntervalMs: 10_000 });
  try { await manager.start(); await eventually(() => manager.cache.health === "connected"); panes = ["w1:p1", "w1:p2"]; manager.ownershipChanged(); await eventually(() => server.requests.filter((request) => request.method === "events.subscribe").length >= 2); assert.equal(manager.cache.panes.get("w1:p1")?.terminal_id, "term_parent"); } finally { await manager.stop(); await server.close(); }
});
