import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Value } from "typebox/value";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension, { formatSubagentWidget, presentSubagentWidget } from "../extensions/herdr-subagents/index.ts";
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

type WidgetFactory = (tui: any, theme: any) => { render(width: number): string[]; invalidate(): void };

interface WidgetCall {
  key: string;
  content: string[] | WidgetFactory | undefined;
  options: unknown;
}

function fakeTheme() {
  const calls: Array<{ token: string; text: string }> = [];
  return {
    calls,
    theme: {
      fg(token: string, text: string) {
        calls.push({ token, text });
        return `\x1b[34m${text}\x1b[0m`;
      },
    },
  };
}

function renderFactory(
  content: WidgetCall["content"],
  width: number,
  themed = fakeTheme(),
): { lines: string[]; calls: Array<{ token: string; text: string }> } {
  if (typeof content !== "function") throw new Error("expected widget factory");
  return { lines: content({} as any, themed.theme).render(width), calls: themed.calls };
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
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
      setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: unknown) {
        calls.push({ key, content, options });
      },
    },
  };
}

function mockContext(sessionId: string, hasUI: boolean, ui?: any, mode = hasUI ? "tui" : "json") {
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    getLeafId: () => `${sessionId}-leaf`,
    getBranch: () => [],
  };
  return { sessionManager, hasUI, ui, mode, cwd: "/repo" };
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

test("presentation maps every compact phase and semantic tone with exact precedence", () => {
  const pending = {
    number: 2,
    input: "sensitive input",
    baselineEntryId: null,
    delivery: "pending" as const,
    blockingWaiter: false,
  };
  const cases: Array<{ name: string; run: Run; label: string; tone: string; rpc: string; header?: string }> = [
    { name: "starting", run: mockRun({ lifecycle: "starting" }), label: "starting", tone: "accent", rpc: "starting" },
    { name: "pending working", run: mockRun({ status: "working", generation: pending }), label: "working", tone: "accent", rpc: "g2 working" },
    { name: "pending blocked", run: mockRun({ status: "blocked", generation: pending }), label: "blocked", tone: "warning", rpc: "g2 blocked" },
    { name: "pending waiting", run: mockRun({ status: "idle", generation: pending }), label: "waiting for result", tone: "muted", rpc: "g2 waiting for result" },
    { name: "ready", run: mockRun({ generation: { ...pending, delivery: "ready" } }), label: "result ready", tone: "success", rpc: "g2 result ready" },
    { name: "queued", run: mockRun({ generation: { ...pending, delivery: "queued" } }), label: "result queued", tone: "success", rpc: "g2 result queued" },
    { name: "delivered", run: mockRun({ generation: { ...pending, delivery: "delivered" } }), label: "ready", tone: "success", rpc: "g2 ready" },
    { name: "returned has no separate phase", run: mockRun({ generation: { ...pending, delivery: "delivered", returned: true } }), label: "ready", tone: "success", rpc: "g2 ready" },
    { name: "stopping precedes delivery", run: mockRun({ lifecycle: "stopping", generation: { ...pending, delivery: "queued" } }), label: "stopping", tone: "muted", rpc: "g2 stopping" },
    { name: "retained precedes delivery", run: mockRun({ lifecycle: "retained", generation: { ...pending, delivery: "queued" } }), label: "retained", tone: "error", rpc: "g2 retained", header: "Subagents · 0 active · 1 retained" },
    { name: "live without generation", run: mockRun(), label: "ready", tone: "success", rpc: "ready" },
  ];

  for (const { name, run, label, tone, rpc, header = "Subagents · 1 active" } of cases) {
    const presentation = presentSubagentWidget([run]);
    assert.deepEqual(presentation, {
      header,
      rows: [{
        kind: "agent",
        profile: "scout",
        id: "12345678",
        generation: run.generation ? "g2 " : "",
        phase: label,
        tone,
      }],
    }, name);
    assert.deepEqual(formatSubagentWidget([run]), [
      header,
      `  scout      12345678 · ${rpc}`,
    ], name);
  }
  assert.equal(presentSubagentWidget([]), undefined);
  assert.equal(presentSubagentWidget([mockRun({ lifecycle: "closed" })]), undefined);
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

  const presentation = presentSubagentWidget(runs);
  const widget = formatSubagentWidget(runs);
  assert.deepEqual(widget, [
    "Subagents · 2 active · 1 retained",
    "  worker     a · g7 waiting for result",
    "  researcher b2345678 · retained",
    "  scout      c3456789 · g1 working",
  ]);
  assert.doesNotMatch(JSON.stringify(presentation), /DO-NOT-DISPLAY|closed-secret/);
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

test("TUI factory renders exact-width complete themed edges and semantic rows", async () => {
  const fixture = extensionWithRuntimeCapture();
  const mockedUI = mockUI();
  const ctx = mockContext("render-parent", true, mockedUI.ui);
  const pending = { number: 2, input: "DO-NOT-DISPLAY", baselineEntryId: null, delivery: "pending" as const, blockingWaiter: false };

  try {
    await event(fixture.registered, "session_start")({ reason: "startup" }, ctx);
    const runtime = fixture.runtime();
    fixture.restore();
    const runs = [
      mockRun({ id: "run-starting", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, lifecycle: "starting", childCwd: "/DO-NOT-DISPLAY" }),
      mockRun({ id: "run-queued", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, generation: { ...pending, delivery: "queued" } }),
      mockRun({ id: "run-blocked", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, status: "blocked", generation: pending }),
      mockRun({ id: "run-retained", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, lifecycle: "retained" }),
      mockRun({ id: "run-stopping", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, lifecycle: "stopping" }),
    ];
    for (const run of runs) runtime.runs.set(run.id, run as any);
    await event(fixture.registered, "session_start")({ reason: "reload" }, ctx);
    const factory = mockedUI.calls.at(-1)?.content;
    assert.equal(typeof factory, "function");

    const exactFit = visibleWidth("Subagents · 4 active · 1 retained") + 6;
    for (const width of [0, 1, 2, 3, 4, exactFit, 40, 80]) {
      const themed = fakeTheme();
      const { lines, calls } = renderFactory(factory, width, themed);
      if (width <= 0) {
        assert.deepEqual(lines, []);
        assert.deepEqual(calls, []);
        continue;
      }
      if (width <= 3) {
        assert.deepEqual(lines.map(plain), ["─".repeat(width)]);
        assert.deepEqual(calls, [{ token: "border", text: "─".repeat(width) }]);
        continue;
      }
      assert.ok(lines.every((line) => visibleWidth(line) === width), `width ${width}`);
      const unstyled = lines.map(plain);
      assert.match(unstyled[0]!, /^╭.*╮$/);
      assert.match(unstyled.at(-1)!, /^╰─+╯$/);
      assert.ok(unstyled.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
    }

    const themed = fakeTheme();
    const rendered = renderFactory(factory, 80, themed);
    assert.doesNotMatch(rendered.lines.join("\n"), /DO-NOT-DISPLAY/);
    assert.match(rendered.lines.map(plain).join("\n"), /● scout\s+starting/);
    assert.match(rendered.lines.map(plain).join("\n"), /● scout\s+queued · g2 result queued/);
    assert.match(rendered.lines.map(plain).join("\n"), /● scout\s+blocked · g2 blocked/);
    assert.match(rendered.lines.map(plain).join("\n"), /● scout\s+retained · retained/);
    assert.match(rendered.lines.map(plain).join("\n"), /● scout\s+stopping · stopping/);
    assert.deepEqual(rendered.calls.filter(({ token }) => token !== "border"), [
      { token: "accent", text: "●" }, { token: "dim", text: "starting · " }, { token: "accent", text: "starting" },
      { token: "success", text: "●" }, { token: "dim", text: "queued · g2 " }, { token: "success", text: "result queued" },
      { token: "warning", text: "●" }, { token: "dim", text: "blocked · g2 " }, { token: "warning", text: "blocked" },
      { token: "error", text: "●" }, { token: "dim", text: "retained · " }, { token: "error", text: "retained" },
      { token: "muted", text: "●" }, { token: "dim", text: "stopping · " }, { token: "muted", text: "stopping" },
    ]);
    assert.equal(rendered.calls.filter(({ token }) => token === "border").length, 12);
    assert.ok(rendered.calls.filter(({ token }) => token === "border").every(({ text }) => /^[╭╮╰╯─│].*[╭╮╰╯─│]$|^│$/.test(text)));
    assert.ok(rendered.calls.every(({ text }) => !text.includes("scout")), "profile text must remain unthemed");

    runtime.runs.clear();
    const remainingPhases = [
      mockRun({ id: "run-working", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, status: "working", generation: pending }),
      mockRun({ id: "run-result-ready", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, generation: { ...pending, delivery: "ready" } }),
      mockRun({ id: "run-delivered", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, generation: { ...pending, delivery: "delivered" } }),
      mockRun({ id: "run-no-generation", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId }),
      mockRun({ id: "run-waiting", parentSessionId: "render-parent", parentInstanceId: runtime.instanceId, generation: pending }),
    ];
    for (const run of remainingPhases) runtime.runs.set(run.id, run as any);
    await event(fixture.registered, "session_start")({ reason: "reload" }, ctx);
    const remaining = renderFactory(mockedUI.calls.at(-1)?.content, 80);
    assert.deepEqual(remaining.calls.filter(({ token }) => token !== "border"), [
      { token: "accent", text: "●" }, { token: "dim", text: "working · g2 " }, { token: "accent", text: "working" },
      { token: "success", text: "●" }, { token: "dim", text: "result-r · g2 " }, { token: "success", text: "result ready" },
      { token: "success", text: "●" }, { token: "dim", text: "delivere · g2 " }, { token: "success", text: "ready" },
      { token: "success", text: "●" }, { token: "dim", text: "no-gener · " }, { token: "success", text: "ready" },
      { token: "muted", text: "●" }, { token: "dim", text: "waiting · g2 " }, { token: "muted", text: "waiting for result" },
    ]);
    assert.match(remaining.lines.map(plain).join("\n"), /working.*result ready.*ready.*ready.*waiting for result/s);
  } finally {
    fixture.restore();
  }
});

test("TUI overflow is muted text without a status dot", async () => {
  const fixture = extensionWithRuntimeCapture();
  const mockedUI = mockUI();
  const ctx = mockContext("overflow-parent", true, mockedUI.ui);
  try {
    await event(fixture.registered, "session_start")({ reason: "startup" }, ctx);
    const runtime = fixture.runtime();
    fixture.restore();
    for (let index = 0; index < 6; index++) {
      const run = mockRun({ id: `run-row${index}`, parentSessionId: "overflow-parent", parentInstanceId: runtime.instanceId });
      runtime.runs.set(run.id, run as any);
    }
    await event(fixture.registered, "session_start")({ reason: "reload" }, ctx);
    const rendered = renderFactory(mockedUI.calls.at(-1)?.content, 40);
    assert.match(rendered.lines.map(plain).join("\n"), /\+2 more/);
    assert.equal(rendered.lines.map(plain).filter((line) => line.includes("●")).length, 4);
    assert.deepEqual(rendered.calls.filter(({ token, text }) => token === "muted" && text.includes("more")), [
      { token: "muted", text: "+2 more" },
    ]);
  } finally {
    fixture.restore();
  }
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
    assert.equal(firstUI.calls.at(-1)?.key, "herdr-subagents");
    assert.equal(firstUI.calls.at(-1)?.options, undefined);
    assert.match(renderFactory(firstUI.calls.at(-1)?.content, 80).lines.map(plain).join("\n"), /old12345 · g3 ready/);
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
    assert.match(renderFactory(secondUI.calls.at(-1)?.content, 80).lines.map(plain).join("\n"), /new12345 · g3 ready/);
    assert.equal(firstUI.calls.length, staleShutdownCallCount);

    runtime.runs.delete(currentRun.id);
    const closedRun = queuedRun(runtime, "parent-two", "run-closed12", "closed");
    runtime.runs.set(closedRun.id, closedRun as any);
    event(fixture.registered, "message_end")({ message: deliveryMessage(closedRun) }, secondCtx);
    assert.equal(secondUI.calls.at(-1)?.content, undefined);

    await event(fixture.registered, "session_shutdown")({ reason: "quit" }, secondCtx);
    assert.equal(secondUI.calls.at(-1)?.content, undefined);
    assert.ok(secondUI.calls.every(({ key, options }) => key === "herdr-subagents" && options === undefined));
    assert.ok(secondUI.calls.every(({ content }) => content === undefined || typeof content === "function"));
    assert.equal(firstUI.calls.length, staleShutdownCallCount);
    assert.equal(staleCallCount + 1, staleShutdownCallCount);
  } finally {
    fixture.restore();
  }
});

test("RPC mode keeps the exact plain widget arrays", async () => {
  const fixture = extensionWithRuntimeCapture();
  const mockedUI = mockUI();
  const ctx = mockContext("rpc-parent", true, mockedUI.ui, "rpc");
  try {
    await event(fixture.registered, "session_start")({ reason: "startup" }, ctx);
    const runtime = fixture.runtime();
    fixture.restore();
    const run = queuedRun(runtime, "rpc-parent", "run-rpc123456");
    runtime.runs.set(run.id, run as any);
    event(fixture.registered, "message_end")({ message: deliveryMessage(run) }, ctx);
    assert.deepEqual(mockedUI.calls.at(-1), {
      key: "herdr-subagents",
      content: ["Subagents · 1 active", "  scout      rpc12345 · g3 ready"],
      options: undefined,
    });
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
    const stoppingIndex = contents.findIndex((content) => typeof content === "function"
      && renderFactory(content, 80).lines.map(plain).some((line) => line.includes(" · stopping")));
    assert.notEqual(stoppingIndex, -1);
    assert.ok(contents.slice(stoppingIndex + 1).some((content) => content === undefined));
    assert.equal(contents.at(-1), undefined);
  } finally {
    fixture.restore();
    SocketHerdrClient.prototype.closePane = originalClosePane;
    SocketHerdrClient.prototype.closeTab = originalCloseTab;
  }
});

test("print and JSON no-UI lifecycles leave widget handling as a no-op", async () => {
  for (const mode of ["print", "json"]) {
    const fixture = extensionWithRuntimeCapture();
    const mockedUI = mockUI();
    const ctx = mockContext(`headless-${mode}`, false, mockedUI.ui, mode);
    const originalClosePane = SocketHerdrClient.prototype.closePane;
    const originalCloseTab = SocketHerdrClient.prototype.closeTab;

    try {
      await event(fixture.registered, "session_start")({ reason: "startup" }, ctx);
      const runtime = fixture.runtime();
      fixture.restore();
      const active = mockRun({
        id: `run-headless-${mode}`,
        parentSessionId: `headless-${mode}`,
        parentInstanceId: runtime.instanceId,
        childSessionDir: "/path-that-does-not-exist/herdr-headless-test",
      });
      runtime.runs.set(active.id, active as any);
      SocketHerdrClient.prototype.closePane = async () => {};
      SocketHerdrClient.prototype.closeTab = async () => {};
      await event(fixture.registered, "session_shutdown")({ reason: "quit" }, ctx);
      assert.deepEqual(mockedUI.calls, [], mode);
    } finally {
      fixture.restore();
      SocketHerdrClient.prototype.closePane = originalClosePane;
      SocketHerdrClient.prototype.closeTab = originalCloseTab;
    }
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
