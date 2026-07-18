import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentRuntime, type ResultDelivery } from "../src/runtime.ts";
import { HERDR_STATE_CUSTOM_TYPE, type HerdrStateRecord } from "../src/session.ts";
import { FakeHerdr } from "./fake-herdr.ts";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "model",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function eventually(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface ParentFixture {
  root: string;
  agentDir: string;
  manager: SessionManager;
  parentSessionFile: string;
  parentEntryId: string;
}

async function createParent(): Promise<ParentFixture> {
  const root = await mkdtemp(join(tmpdir(), "herdr-parent-"));
  const sessionDir = join(root, "parent-sessions");
  const agentDir = join(root, "agent");
  await mkdir(sessionDir, { recursive: true });
  const manager = SessionManager.create(root, sessionDir, { id: "parent-session" });
  manager.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
  const parentEntryId = manager.appendMessage(assistant("ready"));
  return {
    root,
    agentDir,
    manager,
    parentSessionFile: manager.getSessionFile()!,
    parentEntryId,
  };
}

function records(manager: SessionManager): HerdrStateRecord[] {
  return manager.getBranch().flatMap((entry) =>
    entry.type === "custom" && entry.customType === HERDR_STATE_CUSTOM_TYPE
      ? [entry.data as HerdrStateRecord]
      : []);
}

function launch(client: FakeHerdr): { cwd: string; sessionDir: string; sessionId: string } {
  const input = [...client.calls].reverse().find(({ method }) => method === "agent.start")?.input as Record<string, unknown>;
  const argv = input.argv as string[];
  return {
    cwd: String(input.cwd),
    sessionDir: argv[argv.indexOf("--session-dir") + 1]!,
    sessionId: argv[argv.indexOf("--session-id") + 1]!,
  };
}

async function appendChildResult(client: FakeHerdr, text: string): Promise<void> {
  const child = launch(client);
  await mkdir(child.sessionDir, { recursive: true });
  const manager = SessionManager.create(child.cwd, child.sessionDir, { id: child.sessionId });
  manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
  manager.appendMessage(assistant(text));
}

function runtimeFor(
  parent: ParentFixture,
  client: FakeHerdr,
  options: {
    deliveries?: ResultDelivery[];
    instanceId?: string;
    processId?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): SubagentRuntime {
  return new SubagentRuntime(client, { workspaceId: "w-parent", agentDir: parent.agentDir }, {
    idFactory: () => "run-lifecycle",
    instanceIdFactory: () => options.instanceId ?? "instance-current",
    parentProcessId: options.processId ?? 200,
    readinessTimeoutMs: 40,
    pollIntervalMs: 1,
    cleanupTimeoutMs: 40,
    gitStatus: async () => "",
    appendState: (customType, record) => { parent.manager.appendCustomEntry(customType, record); },
    deliverResult: (message) => options.deliveries?.push(message),
    isProcessAlive: options.isProcessAlive,
  });
}

async function bind(runtime: SubagentRuntime, parent: ParentFixture, reason: "startup" | "reload" = "startup") {
  return runtime.bindParent({
    parentSessionId: parent.manager.getSessionId(),
    parentSessionFile: parent.parentSessionFile,
    parentEntryId: parent.parentEntryId,
  }, parent.manager.getBranch(), reason);
}

function priorRecord(parent: ParentFixture, overrides: Partial<HerdrStateRecord> = {}): HerdrStateRecord {
  return {
    state: "generation_pending",
    at: 1,
    parentSessionId: "parent-session",
    parentSessionFile: parent.parentSessionFile,
    parentEntryId: parent.parentEntryId,
    parentInstanceId: "instance-prior",
    parentProcessId: 100,
    runId: "run-prior",
    childSessionId: "herdr-run-prior",
    childSessionDir: join(parent.agentDir, "herdr-subagents", "parent-session", "run-prior"),
    childCwd: parent.root,
    terminalId: "term-prior",
    paneId: "pane-prior",
    tabId: "tab-prior",
    workspaceId: "w-parent",
    profile: "scout",
    generation: { number: 1, baselineEntryId: null, delivery: "pending" },
    ...overrides,
  };
}

function exactPriorAgent(client: FakeHerdr): void {
  client.agent = {
    agent: "pi",
    agentSession: { agent: "pi", kind: "id", value: "herdr-run-prior" },
    terminalId: "term-prior",
    paneId: "pane-prior",
    tabId: "tab-prior",
    workspaceId: "w-parent",
    status: "idle",
  };
}

test("durable ownership journals compact active-branch transitions and rejects ephemeral or foreign starts", async () => {
  const parent = await createParent();
  try {
    const client = new FakeHerdr();
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => appendChildResult(client, "structured result");
    const runtime = runtimeFor(parent, client);
    await bind(runtime, parent);

    const result = await runtime.start("scout", "inspect", parent.root, { wait: true, timeoutMs: 100 });
    assert.equal(result.latestResult?.text, "structured result");
    const journal = records(parent.manager);
    assert.deepEqual(journal.map(({ state }) => state), [
      "starting", "live", "generation_pending", "result_ready", "result_delivered",
    ]);
    assert.equal(journal.filter(({ result }) => result !== undefined).length, 1);
    assert.equal(journal.find(({ result: value }) => value !== undefined)?.result?.text, "structured result");
    assert.equal(journal.every(({ parentSessionId, parentSessionFile, parentInstanceId, parentProcessId }) =>
      parentSessionId === "parent-session"
      && parentSessionFile === parent.parentSessionFile
      && parentInstanceId === "instance-current"
      && parentProcessId === 200), true);
    assert.equal(parent.manager.buildSessionContext().messages.some((message) =>
      message.role === "custom" && message.customType === HERDR_STATE_CUSTOM_TYPE), false);

    const callsBefore = client.calls.length;
    assert.throws(() => runtime.status(result.id, {
      parentSessionId: "parent-session",
      parentSessionFile: parent.parentSessionFile,
      parentEntryId: parent.parentEntryId,
      parentInstanceId: "instance-foreign",
    }), /extension instance/);
    assert.equal(client.calls.length, callsBefore);
    assert.throws(() => runtime.status(result.id, {
      parentSessionId: "parent-session",
      parentSessionFile: undefined,
      parentEntryId: parent.parentEntryId,
      parentInstanceId: "instance-current",
    }), /session file/);
    assert.equal(client.calls.length, callsBefore);
    const currentRequest = runtime.requestFor({
      parentSessionId: "parent-session",
      parentSessionFile: parent.parentSessionFile,
      parentEntryId: parent.parentEntryId,
    });
    const [returnedSettlement] = await runtime.settle(currentRequest);
    assert.equal(returnedSettlement?.run.lifecycle, "closed");

    const ephemeralClient = new FakeHerdr();
    const ephemeral = new SubagentRuntime(ephemeralClient, { workspaceId: "w-parent" }, {
      instanceIdFactory: () => "instance-ephemeral",
      appendState: () => {},
    });
    await ephemeral.bindParent({ parentSessionId: "ephemeral", parentEntryId: null }, [], "startup");
    await assert.rejects(ephemeral.start("scout", "task", parent.root), /ephemeral parent session/);
    assert.equal(ephemeralClient.calls.length, 0);
  } finally {
    await rm(parent.root, { recursive: true, force: true });
  }
});

test("startup reconciliation cleans only exact dead-owner residue and never adopts live or mismatched runs", async (context) => {
  await context.test("dead exact residue", async () => {
    const parent = await createParent();
    try {
      const stale = priorRecord(parent);
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, stale);
      await mkdir(stale.childSessionDir, { recursive: true });
      const client = new FakeHerdr();
      exactPriorAgent(client);
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["agent.get", "pane.close", "tab.close"]);
      assert.equal(existsSync(stale.childSessionDir), false);
      assert.deepEqual(records(parent.manager).slice(-2).map(({ state }) => state), ["stopping", "closed"]);
      assert.deepEqual(runtime.list(), []);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("live owner", async () => {
    const parent = await createParent();
    try {
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, priorRecord(parent));
      const client = new FakeHerdr();
      exactPriorAgent(client);
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => true });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "live_owner");
      assert.equal(client.calls.length, 0);
      assert.equal(records(parent.manager).length, 1);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  for (const mismatch of ["topology", "child", "storage"] as const) {
    await context.test(`${mismatch} mismatch`, async () => {
      const parent = await createParent();
      try {
        const record = priorRecord(parent, mismatch === "storage" ? { childSessionDir: join(parent.root, "not-owned") } : {});
        parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
        const client = new FakeHerdr();
        exactPriorAgent(client);
        if (mismatch === "topology") client.agent!.paneId = "different-pane";
        if (mismatch === "child") client.agent!.agentSession = { agent: "pi", kind: "id", value: "different-session" };
        const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
        const diagnostics = await bind(runtime, parent);
        assert.equal(diagnostics[0]?.outcome, "identity_mismatch");
        assert.deepEqual(client.calls.map(({ method }) => method), mismatch === "storage" ? [] : ["agent.get"]);
        assert.equal(records(parent.manager).length, 1);
      } finally {
        await rm(parent.root, { recursive: true, force: true });
      }
    });
  }

  await context.test("malformed active residue is reported without mutation", async () => {
    const parent = await createParent();
    try {
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { state: "live", runId: "run-broken" });
      const client = new FakeHerdr();
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "identity_mismatch");
      assert.match(diagnostics[0]?.message ?? "", /malformed/);
      assert.equal(client.calls.length, 0);
      assert.equal(records(parent.manager).length, 1);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("inactive branch residue is ignored", async () => {
    const parent = await createParent();
    try {
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, priorRecord(parent));
      parent.manager.branch(parent.parentEntryId);
      parent.manager.appendCustomEntry("active-marker", { active: true });
      const client = new FakeHerdr();
      exactPriorAgent(client);
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent);
      assert.deepEqual(diagnostics, []);
      assert.equal(client.calls.length, 0);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("reload reports terminal diagnostics without retry", async () => {
    const parent = await createParent();
    try {
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, priorRecord(parent, {
        state: "retained",
        retained: ["tab=tab-prior"],
      }));
      const client = new FakeHerdr();
      exactPriorAgent(client);
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent, "reload");
      assert.equal(diagnostics[0]?.outcome, "retained");
      assert.equal(client.calls.length, 0);
      assert.equal(records(parent.manager).length, 1);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });
});

test("settlement waits for delivery confirmation, blocks tree while open, and retains partial cleanup without retry", async () => {
  const parent = await createParent();
  try {
    const deliveries: ResultDelivery[] = [];
    const client = new FakeHerdr();
    client.statuses = ["idle"];
    const runtime = runtimeFor(parent, client, { deliveries });
    await bind(runtime, parent);
    const started = await runtime.start("scout", "slow", parent.root);
    const request = runtime.requestFor({
      parentSessionId: "parent-session",
      parentSessionFile: parent.parentSessionFile,
      parentEntryId: parent.parentEntryId,
    });
    assert.equal(runtime.hasOpenRuns(request), true);
    assert.deepEqual(await runtime.settle(request), []);
    assert.equal(client.calls.some(({ method }) => method === "pane.close"), false);

    await appendChildResult(client, "background");
    await eventually(() => deliveries.length === 1);
    assert.equal(runtime.status(started.id).generation?.delivery, "queued");
    assert.deepEqual(await runtime.settle(request), []);
    const delivery = deliveries[0]!;
    assert.equal(runtime.confirmDelivery({ role: "custom", ...delivery }), true);

    client.failCloseTab = true;
    const [settled] = await runtime.settle(request);
    assert.equal(settled?.run.lifecycle, "retained");
    assert.equal(settled?.retained.includes(`tab=${started.tabId}`), true);
    assert.equal(runtime.hasOpenRuns(request), false);
    assert.equal(records(parent.manager).at(-1)?.state, "retained");
    const destructiveCalls = client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close").length;
    assert.deepEqual(await runtime.shutdown("quit"), []);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close").length, destructiveCalls);
  } finally {
    await rm(parent.root, { recursive: true, force: true });
  }
});

test("every shutdown reason aborts monitors before one fresh bounded reader cleanup", async () => {
  for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
    const parent = await createParent();
    try {
      const client = new FakeHerdr();
      client.statuses = ["idle"];
      const runtime = runtimeFor(parent, client, { instanceId: `instance-${reason}` });
      await bind(runtime, parent);
      await runtime.start("scout", "pending", parent.root);
      await eventually(() => client.calls.filter(({ method }) => method === "agent.get").length >= 2);
      const monitorSignals = client.calls.filter(({ method }) => method === "agent.get").map(({ signal }) => signal);
      const [stopped] = await runtime.shutdown(reason);
      assert.equal(stopped?.run.lifecycle, "closed", reason);
      assert.equal(monitorSignals.some((signal) => signal?.aborted), true, reason);
      const cleanup = client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close");
      assert.deepEqual(cleanup.map(({ method }) => method), ["pane.close", "tab.close"]);
      assert.equal(cleanup[0]?.signal, cleanup[1]?.signal);
      assert.equal(monitorSignals.includes(cleanup[0]?.signal), false);
      assert.deepEqual(records(parent.manager).slice(-2).map(({ state }) => state), ["stopping", "closed"]);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  }
});
