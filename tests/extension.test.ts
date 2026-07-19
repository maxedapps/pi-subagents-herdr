import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Value } from "typebox/value";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { formatSubagentWidget } from "../extensions/herdr-subagents/index.ts";
import { SocketHerdrClient } from "../src/herdr.ts";
import { PROFILES } from "../src/profiles.ts";
import { SubagentRuntime, type Run } from "../src/runtime.ts";
import { idSchema, sendSchema, startSchema, statusSchema } from "../src/tools.ts";

interface Registered {
  tools: Array<{ name: string; parameters?: unknown }>;
  events: Array<{ name: string; handler: (...args: any[]) => unknown }>;
  commands: string[];
  messages: unknown[];
}

interface WidgetCall {
  key: string;
  content: string[] | undefined;
  options: unknown;
}

function mockRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-12345678-rest-of-id",
    parentSessionId: "parent",
    parentInstanceId: "instance",
    profile: "scout",
    childSessionId: "child-sensitive",
    childSessionDir: "/sensitive/session",
    childCwd: "/sensitive/cwd",
    terminalId: "terminal-sensitive",
    paneId: "pane-sensitive",
    tabId: "tab-sensitive",
    workspaceId: "workspace-sensitive",
    lifecycle: "live",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function mockUI(): { ui: any; calls: WidgetCall[] } {
  const calls: WidgetCall[] = [];
  return {
    calls,
    ui: {
      notify() {},
      setWidget(key: string, content: string[] | undefined, options?: unknown) {
        calls.push({ key, content, options });
      },
    },
  };
}

function mockContext(sessionId: string, hasUI: boolean, ui?: any) {
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    getLeafId: () => `${sessionId}-leaf`,
    getBranch: () => [],
  };
  return { sessionManager, hasUI, ui, cwd: "/repo" };
}

function event(registered: Registered, name: string) {
  const handler = registered.events.find((candidate) => candidate.name === name)?.handler;
  assert.ok(handler, `missing ${name} handler`);
  return handler;
}

function queuedRun(runtime: SubagentRuntime, sessionId: string, id: string, lifecycle: Run["lifecycle"] = "live"): Run {
  return mockRun({
    id,
    parentSessionId: sessionId,
    parentInstanceId: runtime.instanceId,
    lifecycle,
    status: "done",
    generation: {
      number: 3,
      input: "sensitive task input",
      baselineEntryId: null,
      resultEntryId: `${id}-result-sensitive`,
      delivery: "queued",
      blockingWaiter: false,
    },
  });
}

function deliveryMessage(run: Run) {
  return {
    role: "custom",
    customType: "herdr-subagent-result",
    details: {
      parentSessionId: run.parentSessionId,
      runId: run.id,
      profile: run.profile,
      generation: run.generation?.number,
      childSessionId: run.childSessionId,
      childEntryId: run.generation?.resultEntryId,
    },
  };
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

function extensionWithRuntimeCapture() {
  const originalBindParent = SubagentRuntime.prototype.bindParent;
  let runtime: SubagentRuntime | undefined;
  SubagentRuntime.prototype.bindParent = async function (binding, branch, reason) {
    runtime = this;
    return originalBindParent.call(this, binding, branch, reason);
  };
  const mocked = mockPi();
  withParentEnvironment(() => extension(mocked.pi));
  return {
    ...mocked,
    runtime() {
      assert.ok(runtime, "session_start did not bind the runtime");
      return runtime;
    },
    restore() {
      SubagentRuntime.prototype.bindParent = originalBindParent;
    },
  };
}

test("formatter maps every compact phase with exact precedence", () => {
  const pending = {
    number: 2,
    input: "sensitive input",
    baselineEntryId: null,
    delivery: "pending" as const,
    blockingWaiter: false,
  };
  const cases: Array<{ name: string; run: Run; phase: string; header?: string }> = [
    { name: "starting", run: mockRun({ lifecycle: "starting" }), phase: "starting" },
    { name: "pending working", run: mockRun({ status: "working", generation: pending }), phase: "g2 working" },
    { name: "pending blocked", run: mockRun({ status: "blocked", generation: pending }), phase: "g2 blocked" },
    { name: "pending waiting", run: mockRun({ status: "idle", generation: pending }), phase: "g2 waiting for result" },
    { name: "ready", run: mockRun({ generation: { ...pending, delivery: "ready" } }), phase: "g2 result ready" },
    { name: "queued", run: mockRun({ generation: { ...pending, delivery: "queued" } }), phase: "g2 result queued" },
    { name: "delivered", run: mockRun({ generation: { ...pending, delivery: "delivered" } }), phase: "g2 ready" },
    { name: "returned has no separate phase", run: mockRun({ generation: { ...pending, delivery: "delivered", returned: true } }), phase: "g2 ready" },
    { name: "stopping precedes delivery", run: mockRun({ lifecycle: "stopping", generation: { ...pending, delivery: "queued" } }), phase: "g2 stopping" },
    { name: "retained precedes delivery", run: mockRun({ lifecycle: "retained", generation: { ...pending, delivery: "queued" } }), phase: "g2 retained", header: "Subagents · 0 active · 1 retained" },
    { name: "live without generation", run: mockRun(), phase: "ready" },
  ];

  for (const { name, run, phase, header = "Subagents · 1 active" } of cases) {
    assert.deepEqual(formatSubagentWidget([run]), [
      header,
      `  scout      12345678 · ${phase}`,
    ], name);
  }
  assert.equal(formatSubagentWidget([]), undefined);
  assert.equal(formatSubagentWidget([mockRun({ lifecycle: "closed" })]), undefined);
});

test("formatter preserves order, filters closed runs, pads profiles, and redacts details", () => {
  const sensitive = "DO-NOT-DISPLAY";
  const runs = [
    mockRun({
      id: "run-a",
      profile: "worker",
      generation: {
        number: 7,
        input: `${sensitive}-input`,
        baselineEntryId: null,
        delivery: "pending",
        blockingWaiter: false,
        error: `${sensitive}-generation-error`,
      },
      latestResult: { childEntryId: `${sensitive}-entry`, text: `${sensitive}-result`, message: {} as any },
      childSessionDir: `/${sensitive}/session`,
      childCwd: `/${sensitive}/cwd`,
      worktree: { workspaceId: `${sensitive}-workspace`, path: `/${sensitive}/worktree`, branch: `${sensitive}-branch` },
      warning: `${sensitive}-warning`,
      retained: [`${sensitive}-retained`],
      error: `${sensitive}-error`,
      resultContent: `${sensitive}-content`,
    }),
    mockRun({ id: "run-closed-secret", lifecycle: "closed", profile: "researcher" }),
    mockRun({ id: "run-b23456789", profile: "researcher", lifecycle: "retained", retained: [`${sensitive}-resource`] }),
    mockRun({ id: "run-c34567890", profile: "scout", status: "working", generation: { number: 1, input: sensitive, baselineEntryId: null, delivery: "pending", blockingWaiter: false } }),
  ];

  const widget = formatSubagentWidget(runs);
  assert.deepEqual(widget, [
    "Subagents · 2 active · 1 retained",
    "  worker     a · g7 waiting for result",
    "  researcher b2345678 · retained",
    "  scout      c3456789 · g1 working",
  ]);
  assert.doesNotMatch(widget?.join("\n") ?? "", /DO-NOT-DISPLAY|closed-secret/);
});

test("formatter enforces the six-line overflow budget", () => {
  const five = Array.from({ length: 5 }, (_, index) => mockRun({ id: `run-row${index}` }));
  const six = [...five, mockRun({ id: "run-row5" })];
  assert.equal(formatSubagentWidget(five)?.length, 6);
  assert.deepEqual(formatSubagentWidget(six), [
    "Subagents · 6 active",
    "  scout      row0 · ready",
    "  scout      row1 · ready",
    "  scout      row2 · ready",
    "  scout      row3 · ready",
    "+2 more",
  ]);
});

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
  await event(registered, "session_start")({ type: "session_start", reason: "startup" }, ctx);
  const treeResult = await event(registered, "session_before_tree")({}, ctx);
  assert.equal(treeResult, undefined);
  await event(registered, "agent_settled")({}, ctx);
  await event(registered, "session_shutdown")({ reason: "quit" }, ctx);
});

test("widget refresh follows only the current UI session and clears at zero and shutdown", async () => {
  const fixture = extensionWithRuntimeCapture();
  const firstUI = mockUI();
  const secondUI = mockUI();
  const firstCtx = mockContext("parent-one", true, firstUI.ui);
  const secondCtx = mockContext("parent-two", true, secondUI.ui);

  try {
    await event(fixture.registered, "session_start")({ reason: "startup" }, firstCtx);
    const runtime = fixture.runtime();
    fixture.restore();
    assert.deepEqual(firstUI.calls, [{ key: "herdr-subagents", content: undefined, options: undefined }]);

    const oldRun = queuedRun(runtime, "parent-one", "run-old123456");
    runtime.runs.set(oldRun.id, oldRun as any);
    event(fixture.registered, "message_end")({ message: deliveryMessage(oldRun) }, firstCtx);
    assert.deepEqual(firstUI.calls.at(-1), {
      key: "herdr-subagents",
      content: [
        "Subagents · 1 active",
        "  scout      old12345 · g3 ready",
      ],
      options: undefined,
    });
    const staleCallCount = firstUI.calls.length;

    await event(fixture.registered, "session_start")({ reason: "new" }, secondCtx);
    assert.deepEqual(secondUI.calls, [{ key: "herdr-subagents", content: undefined, options: undefined }]);
    await assert.rejects(
      async () => event(fixture.registered, "session_shutdown")({ reason: "reload" }, firstCtx),
      /does not own this runtime/,
    );
    assert.equal(firstUI.calls.at(-1)?.content, undefined);
    const staleShutdownCallCount = firstUI.calls.length;

    const currentRun = queuedRun(runtime, "parent-two", "run-new123456");
    runtime.runs.set(currentRun.id, currentRun as any);
    event(fixture.registered, "message_end")({ message: deliveryMessage(currentRun) }, secondCtx);
    assert.deepEqual(secondUI.calls.at(-1)?.content, [
      "Subagents · 1 active",
      "  scout      new12345 · g3 ready",
    ]);
    assert.equal(firstUI.calls.length, staleShutdownCallCount);

    runtime.runs.delete(currentRun.id);
    const closedRun = queuedRun(runtime, "parent-two", "run-closed12", "closed");
    runtime.runs.set(closedRun.id, closedRun as any);
    event(fixture.registered, "message_end")({ message: deliveryMessage(closedRun) }, secondCtx);
    assert.equal(secondUI.calls.at(-1)?.content, undefined);

    await event(fixture.registered, "session_shutdown")({ reason: "quit" }, secondCtx);
    assert.equal(secondUI.calls.at(-1)?.content, undefined);
    assert.ok(secondUI.calls.every(({ key, options }) => key === "herdr-subagents" && options === undefined));
    assert.equal(firstUI.calls.length, staleShutdownCallCount);
    assert.equal(staleCallCount + 1, staleShutdownCallCount);
  } finally {
    fixture.restore();
  }
});

test("shutdown keeps refresh active through cleanup and then releases it", async () => {
  const fixture = extensionWithRuntimeCapture();
  const mockedUI = mockUI();
  const ctx = mockContext("shutdown-parent", true, mockedUI.ui);
  const originalClosePane = SocketHerdrClient.prototype.closePane;
  const originalCloseTab = SocketHerdrClient.prototype.closeTab;

  try {
    await event(fixture.registered, "session_start")({ reason: "startup" }, ctx);
    const runtime = fixture.runtime();
    fixture.restore();
    const active = mockRun({
      id: "run-cleanup123",
      parentSessionId: "shutdown-parent",
      parentInstanceId: runtime.instanceId,
      childSessionDir: "/path-that-does-not-exist/herdr-widget-test",
    });
    runtime.runs.set(active.id, active as any);
    await event(fixture.registered, "session_start")({ reason: "reload" }, ctx);

    SocketHerdrClient.prototype.closePane = async () => {};
    SocketHerdrClient.prototype.closeTab = async () => {};
    await event(fixture.registered, "session_shutdown")({ reason: "quit" }, ctx);

    const contents = mockedUI.calls.map(({ content }) => content);
    const stoppingIndex = contents.findIndex((content) => content?.[1]?.endsWith(" · stopping"));
    assert.notEqual(stoppingIndex, -1);
    assert.ok(contents.slice(stoppingIndex + 1).some((content) => content === undefined));
    assert.equal(contents.at(-1), undefined);
  } finally {
    fixture.restore();
    SocketHerdrClient.prototype.closePane = originalClosePane;
    SocketHerdrClient.prototype.closeTab = originalCloseTab;
  }
});

test("no-UI lifecycle leaves widget handling as a no-op", async () => {
  const fixture = extensionWithRuntimeCapture();
  const mockedUI = mockUI();
  const ctx = mockContext("headless-parent", false, mockedUI.ui);
  const originalClosePane = SocketHerdrClient.prototype.closePane;
  const originalCloseTab = SocketHerdrClient.prototype.closeTab;

  try {
    await event(fixture.registered, "session_start")({ reason: "startup" }, ctx);
    const runtime = fixture.runtime();
    fixture.restore();
    const active = mockRun({
      id: "run-headless",
      parentSessionId: "headless-parent",
      parentInstanceId: runtime.instanceId,
      childSessionDir: "/path-that-does-not-exist/herdr-headless-test",
    });
    runtime.runs.set(active.id, active as any);
    SocketHerdrClient.prototype.closePane = async () => {};
    SocketHerdrClient.prototype.closeTab = async () => {};
    await event(fixture.registered, "session_shutdown")({ reason: "quit" }, ctx);
    assert.deepEqual(mockedUI.calls, []);
  } finally {
    fixture.restore();
    SocketHerdrClient.prototype.closePane = originalClosePane;
    SocketHerdrClient.prototype.closeTab = originalCloseTab;
  }
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
