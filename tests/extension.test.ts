import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/herdr-subagents/index.ts";
import { PROFILES } from "../src/profiles.ts";
import { idSchema, sendSchema, startSchema, statusSchema } from "../src/tools.ts";

interface Registered {
  tools: Array<{ name: string }>;
  events: Array<{ name: string; handler: (...args: unknown[]) => unknown }>;
  commands: string[];
}

function mockPi(): { pi: ExtensionAPI; registered: Registered } {
  const registered: Registered = { tools: [], events: [], commands: [] };
  const pi = {
    registerTool(tool: { name: string }) { registered.tools.push(tool); },
    on(name: string, handler: (...args: unknown[]) => unknown) { registered.events.push({ name, handler }); },
    registerCommand(name: string) { registered.commands.push(name); },
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

test("parent registers exactly five tools and one skill hook", () => withParentEnvironment(() => {
  const { pi, registered } = mockPi();
  extension(pi);
  assert.deepEqual(registered.tools.map(({ name }) => name), [
    "subagent_start", "subagent_status", "subagent_send", "subagent_interrupt", "subagent_stop",
  ]);
  assert.deepEqual(registered.events.map(({ name }) => name), ["resources_discover"]);
  assert.deepEqual(registered.commands, []);
  const resources = registered.events[0]?.handler({}, {}) as { skillPaths: string[] };
  assert.equal(resources.skillPaths.length, 1);
  assert.match(resources.skillPaths[0] ?? "", /skills\/use-herdr-subagents\/SKILL\.md$/);
  assert.equal(existsSync(resources.skillPaths[0] ?? ""), true);
}));

test("child guard registers nothing", () => {
  const before = process.env.PI_HERDR_SUBAGENT;
  process.env.PI_HERDR_SUBAGENT = "1";
  try {
    const { pi, registered } = mockPi();
    extension(pi);
    assert.deepEqual(registered, { tools: [], events: [], commands: [] });
  } finally {
    if (before === undefined) delete process.env.PI_HERDR_SUBAGENT; else process.env.PI_HERDR_SUBAGENT = before;
  }
});

test("fixed profiles expose only the approved controls", () => {
  assert.deepEqual(Object.keys(PROFILES), ["scout", "researcher", "worker"]);
  assert.deepEqual(PROFILES.scout.tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(PROFILES.researcher.tools, ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content"]);
  assert.deepEqual(PROFILES.worker.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual([PROFILES.scout.thinking, PROFILES.researcher.thinking, PROFILES.worker.thinking], ["low", "medium", "high"]);
});

test("strict schemas reject deprecated and unknown fields", () => {
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x" }), true);
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x", harness: "pi" }), false);
  assert.equal(Value.Check(startSchema, { profile: "scout", task: "x", model: "m", thinking: "high", cwd: "/x", worktree: "auto" }), false);
  assert.equal(Value.Check(statusSchema, { id: "run", wait: true, timeoutMs: 1 }), true);
  assert.equal(Value.Check(statusSchema, { scope: "all", states: ["done"] }), false);
  assert.equal(Value.Check(sendSchema, { id: "run", message: "x", cleanup: "retain" }), false);
  assert.equal(Value.Check(idSchema, { id: "run", integration: {} }), false);
});
