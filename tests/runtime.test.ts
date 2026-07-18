import assert from "node:assert/strict";
import test from "node:test";
import { PROFILES } from "../src/profiles.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import { FakeHerdr } from "./fake-herdr.ts";

function runtime(client: FakeHerdr, suffix = "reader", timeout = 20): SubagentRuntime {
  return new SubagentRuntime(client, { workspaceId: "w-parent" }, {
    idFactory: () => `run-${suffix}`,
    readinessTimeoutMs: timeout,
    pollIntervalMs: 1,
    gitStatus: async () => "",
  });
}

test("start waits for readiness, launches fixed Pi, and sends the task once", async () => {
  const client = new FakeHerdr();
  client.startStatus = "working";
  client.statuses = ["working", "idle"];
  const run = await runtime(client).start("scout", "inspect this", "/repo");
  assert.equal(run.status, "idle");
  assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 2);
  assert.deepEqual(client.calls.filter(({ method }) => method === "pane.send_input").map(({ input }) => input), [
    { paneId: "w-parent:p-child", text: "inspect this" },
  ]);
  const launch = client.calls.find(({ method }) => method === "agent.start")?.input as Record<string, unknown>;
  assert.deepEqual(launch.argv, [
    "pi", "--no-session", "--name", "scout-n-reader", "--thinking", "low", "--tools",
    "read,grep,find,ls", "--append-system-prompt", PROFILES.scout.systemPrompt,
  ]);
  assert.deepEqual(launch.env, { PI_HERDR_SUBAGENT: "1" });
  assert.equal(launch.cwd, "/repo");
});

test("start always performs a fresh readiness lookup", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  client.statuses = ["idle"];
  await runtime(client, "fresh").start("scout", "task", "/repo");
  assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 1);
  assert.ok(client.calls.findIndex(({ method }) => method === "agent.get") < client.calls.findIndex(({ method }) => method === "pane.send_input"));
});

test("readiness waits until the Pi session is addressable", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  client.statuses = ["idle", "idle"];
  client.sessionStates = [false, true];
  await runtime(client, "addressable").start("scout", "task", "/repo");
  assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 2);
});

test("readiness timeout bounds a stalled lookup, closes topology, and omits the run", async () => {
  const client = new FakeHerdr();
  client.startStatus = "working";
  client.hangGetAgent = true;
  const subject = runtime(client, "timeout", 4);
  await assert.rejects(subject.start("scout", "task", "/repo"), /readiness timed out/);
  assert.deepEqual(subject.list(), []);
  assert.ok(client.calls.some(({ method }) => method === "pane.close"));
  assert.ok(client.calls.some(({ method }) => method === "tab.close"));
  assert.equal(client.calls.some(({ method }) => method === "pane.send_input"), false);
});

test("reader lifecycle uses explicit status, send, interrupt, and stop", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  const subject = runtime(client);
  const started = await subject.start("scout", "first", "/repo");
  assert.equal(subject.list().length, 1);
  client.statuses = ["working", "idle", "idle", "done"];
  const status = await subject.status(started.id);
  assert.equal(status.output, "terminal output");
  await subject.send(started.id, "follow-up");
  await subject.interrupt(started.id);
  const stopped = await subject.stop(started.id);
  assert.equal(stopped.retainedTab, undefined);
  assert.deepEqual(subject.list(), []);
  assert.deepEqual(client.calls.filter(({ method }) => method === "pane.send_input").map(({ input }) => input), [
    { paneId: "w-parent:p-child", text: "first" },
    { paneId: "w-parent:p-child", text: "follow-up" },
  ]);
  assert.deepEqual(client.calls.find(({ method }) => method === "pane.send_keys")?.input, {
    paneId: "w-parent:p-child", keys: ["ctrl+c"],
  });
  assert.ok(client.calls.some(({ method, input }) => method === "tab.close" && input === "w-parent:t-reader"));
});

test("status wait reaches a terminal state and caps output at 50,000 characters", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  const subject = runtime(client);
  const started = await subject.start("scout", "task", "/repo");
  client.statuses = ["working", "done"];
  client.read = { text: "x".repeat(60_000), revision: 9, truncated: false };
  const status = await subject.status(started.id, true, 50);
  assert.equal(status.run.status, "done");
  assert.equal(status.output.length, 50_000);
  assert.equal(status.truncated, true);
});

test("status wait bounds a stalled agent lookup", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  client.statuses = ["idle"];
  const subject = runtime(client);
  const started = await subject.start("scout", "task", "/repo");
  client.hangGetAgent = true;
  await assert.rejects(subject.status(started.id, true, 4), /Status wait timed out/);
  assert.equal(subject.list().length, 1);
});

test("pane-close failure retains the run, while later tab-cleanup failure does not", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  const subject = runtime(client);
  const started = await subject.start("scout", "task", "/repo");
  client.statuses = ["done"];
  client.failClosePane = true;
  await assert.rejects(subject.stop(started.id), /pane close failed/);
  assert.equal(subject.list().length, 1);
  client.failClosePane = false;
  client.failCloseTab = true;
  client.statuses = ["done"];
  const stopped = await subject.stop(started.id);
  assert.equal(stopped.retainedTab, "w-parent:t-reader");
  assert.deepEqual(subject.list(), []);
});

test("unknown or reloaded run IDs are never adopted", async () => {
  const subject = runtime(new FakeHerdr());
  await assert.rejects(subject.status("old-run"), /Unknown current-instance run/);
  await assert.rejects(subject.send("old-run", "message"), /Unknown current-instance run/);
});
