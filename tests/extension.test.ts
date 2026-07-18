import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Value } from "typebox/value";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/herdr-subagents/index.ts";
import { PROFILES } from "../src/profiles.ts";
import { idSchema, sendSchema, startSchema, statusSchema } from "../src/tools.ts";

interface Registered {
  tools: Array<{ name: string; parameters?: unknown }>;
  events: Array<{ name: string; handler: (...args: any[]) => unknown }>;
  commands: string[];
  messages: unknown[];
}

function mockPi(): { pi: ExtensionAPI; registered: Registered } {
  const registered: Registered = { tools: [], events: [], commands: [], messages: [] };
  const pi = {
    registerTool(tool: { name: string; parameters?: unknown }) { registered.tools.push(tool); },
    on(name: string, handler: (...args: any[]) => unknown) { registered.events.push({ name, handler }); },
    registerCommand(name: string) { registered.commands.push(name); },
    sendMessage(message: unknown, options: unknown) { registered.messages.push({ message, options }); },
    appendEntry() {},
  };
  return { pi: pi as unknown as ExtensionAPI, registered };
}

function withParentEnvironment(run: () => void): void {
  const before = {
    child: process.env.PI_HERDR_SUBAGENT,
    socket: process.env.HERDR_SOCKET_PATH,
    workspace: process.env.HERDR_WORKSPACE_ID,
  };
  delete process.env.PI_HERDR_SUBAGENT;
  process.env.HERDR_SOCKET_PATH = "/tmp/test-herdr.sock";
  process.env.HERDR_WORKSPACE_ID = "w-test";
  try { run(); }
  finally {
    if (before.child === undefined) delete process.env.PI_HERDR_SUBAGENT; else process.env.PI_HERDR_SUBAGENT = before.child;
    if (before.socket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = before.socket;
    if (before.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = before.workspace;
  }
}

test("parent registers exactly four tools, one skill hook, and result confirmation", () => withParentEnvironment(() => {
  const { pi, registered } = mockPi();
  extension(pi);
  assert.deepEqual(registered.tools.map(({ name }) => name), [
    "subagent_start", "subagent_status", "subagent_send", "subagent_stop",
  ]);
  assert.deepEqual(registered.events.map(({ name }) => name), [
    "resources_discover", "session_start", "message_end", "agent_settled", "session_before_tree", "session_shutdown",
  ]);
  assert.deepEqual(registered.commands, []);
  const resources = registered.events.find(({ name }) => name === "resources_discover")?.handler({}, {}) as { skillPaths: string[] };
  assert.equal(resources.skillPaths.length, 1);
  assert.match(resources.skillPaths[0] ?? "", /skills\/use-herdr-subagents\/SKILL\.md$/);
  assert.equal(existsSync(resources.skillPaths[0] ?? ""), true);
}));

test("session lifecycle hooks bind ephemeral diagnostics and leave an empty tree navigable", async () => {
  let registered!: Registered;
  withParentEnvironment(() => {
    const mocked = mockPi();
    registered = mocked.registered;
    extension(mocked.pi);
  });
  const sessionManager = SessionManager.inMemory("/repo", { id: "ephemeral-parent" });
  const ctx = { sessionManager, hasUI: false };
  await registered.events.find(({ name }) => name === "session_start")?.handler({ type: "session_start", reason: "startup" }, ctx);
  const treeResult = await registered.events.find(({ name }) => name === "session_before_tree")?.handler({}, ctx);
  assert.equal(treeResult, undefined);
  await registered.events.find(({ name }) => name === "agent_settled")?.handler({}, ctx);
  await registered.events.find(({ name }) => name === "session_shutdown")?.handler({ reason: "quit" }, ctx);
});

test("child guard registers nothing", () => {
  const before = process.env.PI_HERDR_SUBAGENT;
  process.env.PI_HERDR_SUBAGENT = "1";
  try {
    const { pi, registered } = mockPi();
    extension(pi);
    assert.deepEqual(registered, { tools: [], events: [], commands: [], messages: [] });
  } finally {
    if (before === undefined) delete process.env.PI_HERDR_SUBAGENT; else process.env.PI_HERDR_SUBAGENT = before;
  }
});

test("fixed profiles expose only approved controls", () => {
  assert.deepEqual(Object.keys(PROFILES), ["scout", "researcher", "worker"]);
  assert.deepEqual(PROFILES.scout.tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(PROFILES.researcher.tools, ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content"]);
  assert.deepEqual(PROFILES.worker.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual([PROFILES.scout.thinking, PROFILES.researcher.thinking, PROFILES.worker.thinking], ["low", "medium", "high"]);
});

test("strict schemas accept only background/default or bounded blocking start/send", () => {
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x" }), true);
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x", wait: false }), true);
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x", wait: true, timeoutMs: 1 }), true);
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x", timeoutMs: 1 }), false);
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x", model: "m", cwd: "/x", cleanup: "retain" }), false);

  assert.equal(Value.Check(statusSchema, {}), true);
  assert.equal(Value.Check(statusSchema, { id: "run" }), true);
  assert.equal(Value.Check(statusSchema, { id: "run", wait: true }), false);
  assert.equal(Value.Check(statusSchema, { timeoutMs: 1 }), false);

  assert.equal(Value.Check(sendSchema, { id: "run", message: "x" }), true);
  assert.equal(Value.Check(sendSchema, { id: "run", message: "x", wait: true, timeoutMs: 300_000 }), true);
  assert.equal(Value.Check(sendSchema, { id: "run", message: "x", timeoutMs: 1 }), false);
  assert.equal(Value.Check(sendSchema, { id: "run", message: "x", cleanup: "retain" }), false);
  assert.equal(Value.Check(idSchema, { id: "run" }), true);
  assert.equal(Value.Check(idSchema, { id: "run", integration: {} }), false);
});
