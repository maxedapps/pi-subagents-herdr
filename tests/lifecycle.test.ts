import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveArtifactLocation } from "../src/artifact.ts";
import { HerdrError } from "../src/herdr.ts";
import type { ProfileCatalog } from "../src/profiles.ts";
import { SubagentRuntime, type ResultDelivery, type RuntimeOptions } from "../src/runtime.ts";
import { HERDR_STATE_CUSTOM_TYPE, type HerdrStateRecord } from "../src/session.ts";
import { FakeHerdr } from "./fake-herdr.ts";
import { TEST_PROFILES } from "./profile-fixtures.ts";

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

async function createParent(sessionId = "parent-session"): Promise<ParentFixture> {
  const root = await mkdtemp(join(tmpdir(), "herdr-parent-"));
  const sessionDir = join(root, "parent-sessions");
  const agentDir = join(root, "agent");
  await mkdir(sessionDir, { recursive: true });
  const manager = SessionManager.create(root, sessionDir, { id: sessionId });
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
    onRunsChanged?: () => void;
    appendState?: NonNullable<RuntimeOptions["appendState"]>;
    gitStatus?: NonNullable<RuntimeOptions["gitStatus"]>;
    ids?: string[];
    profileCatalog?: ProfileCatalog;
  } = {},
): SubagentRuntime {
  const ids = [...(options.ids ?? ["run-lifecycle"])];
  return new SubagentRuntime(client, { workspaceId: "w-parent", agentDir: parent.agentDir }, options.profileCatalog ?? TEST_PROFILES, {
    idFactory: () => ids.shift() ?? "run-lifecycle-extra",
    instanceIdFactory: () => options.instanceId ?? "instance-current",
    parentProcessId: options.processId ?? 200,
    readinessTimeoutMs: 40,
    pollIntervalMs: 1,
    quietPeriodMs: 1,
    cleanupTimeoutMs: 40,
    gitStatus: options.gitStatus ?? (async () => ""),
    appendState: options.appendState
      ?? ((customType, record) => { parent.manager.appendCustomEntry(customType, record); }),
    deliverResult: (message) => options.deliveries?.push(message),
    isProcessAlive: options.isProcessAlive,
    onRunsChanged: options.onRunsChanged,
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
    const ephemeral = new SubagentRuntime(ephemeralClient, { workspaceId: "w-parent" }, TEST_PROFILES, {
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

test("cleanup-only reconciliation requires dead ownership, durable stop proof, and exact worker identity", async (context) => {
  function stoppedWorker(parent: ParentFixture, path: string, overrides: Partial<HerdrStateRecord> = {}): HerdrStateRecord {
    return priorRecord(parent, {
      state: "retained",
      childStopped: true,
      profile: "worker",
      childCwd: path,
      workspaceId: "w-worker",
      worktree: {
        workspaceId: "w-worker",
        path,
        branch: "herdr-subagents/run-prior",
      },
      retained: [`branch=herdr-subagents/run-prior`, `worktree=${path}`],
      ...overrides,
    });
  }

  await context.test("custom worktree cleanup follows persisted topology after profile removal or override", async () => {
    for (const currentDefinition of ["removed", "shared-checkout"] as const) {
      const parent = await createParent();
      try {
        const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
        await mkdir(path, { recursive: true });
        parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, stoppedWorker(parent, path, {
          profile: "custom-isolated",
        }));
        const client = new FakeHerdr();
        client.workspace = { workspaceId: "w-worker", worktree: { checkoutPath: path, isLinkedWorktree: true } };
        const profileCatalog = currentDefinition === "removed"
          ? TEST_PROFILES
          : Object.freeze({
            ...TEST_PROFILES,
            "custom-isolated": Object.freeze({
              name: "custom-isolated",
              description: "Now uses the shared checkout",
              useWorktree: false,
              systemPrompt: "Changed profile",
              filePath: "/profiles/custom-isolated.md",
            }),
          });
        const runtime = runtimeFor(parent, client, {
          isProcessAlive: () => false,
          profileCatalog,
        });
        const diagnostics = await bind(runtime, parent);
        assert.equal(diagnostics[0]?.outcome, "cleaned", currentDefinition);
        assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "worktree.remove"], currentDefinition);
        assert.equal(client.calls.some(({ method }) => method === "pane.close" || method === "tab.close"), false);
      } finally {
        await rm(parent.root, { recursive: true, force: true });
      }
    }
  });

  await context.test("shared-checkout history is not reclassified by a worktree override", async () => {
    const parent = await createParent();
    try {
      const record = priorRecord(parent, { profile: "custom-shared" });
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
      await mkdir(record.childSessionDir, { recursive: true });
      const client = new FakeHerdr();
      exactPriorAgent(client);
      const runtime = runtimeFor(parent, client, {
        isProcessAlive: () => false,
        profileCatalog: Object.freeze({
          ...TEST_PROFILES,
          "custom-shared": Object.freeze({
            name: "custom-shared",
            description: "Now requests a worktree",
            useWorktree: true,
            systemPrompt: "Changed profile",
            filePath: "/profiles/custom-shared.md",
          }),
        }),
      });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["agent.get", "pane.close", "tab.close"]);
      assert.equal(client.calls.some(({ method }) => method === "worktree.remove"), false);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("present clean exact residue", async () => {
    const parent = await createParent();
    try {
      const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
      await mkdir(path, { recursive: true });
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, stoppedWorker(parent, path));
      const client = new FakeHerdr();
      client.workspace = { workspaceId: "w-worker", worktree: { checkoutPath: path, isLinkedWorktree: true } };
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "worktree.remove"]);
      assert.equal(client.calls.some(({ method }) => method === "pane.close"), false);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("externally absent exact residue", async () => {
    const parent = await createParent();
    try {
      const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, stoppedWorker(parent, path));
      const client = new FakeHerdr();
      client.workspace = { workspaceId: "w-worker", worktree: { checkoutPath: path, isLinkedWorktree: true } };
      const runtime = runtimeFor(parent, client, {
        isProcessAlive: () => false,
        gitStatus: async () => { throw new Error("checkout absent"); },
      });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "workspace.get", "workspace.close"]);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  for (const scenario of ["live owner", "missing milestone", "branch mismatch", "workspace mismatch", "dirty"] as const) {
    await context.test(scenario, async () => {
      const parent = await createParent();
      try {
        const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
        await mkdir(path, { recursive: true });
        const record = stoppedWorker(parent, path, scenario === "missing milestone" ? { childStopped: undefined } : scenario === "branch mismatch" ? {
          worktree: { workspaceId: "w-worker", path, branch: "wrong-branch" },
        } : {});
        parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
        const client = new FakeHerdr();
        client.workspace = scenario === "workspace mismatch"
          ? { workspaceId: "w-other", worktree: { checkoutPath: path, isLinkedWorktree: true } }
          : { workspaceId: "w-worker", worktree: { checkoutPath: path, isLinkedWorktree: true } };
        const runtime = runtimeFor(parent, client, {
          isProcessAlive: () => scenario === "live owner",
          gitStatus: async () => scenario === "dirty" ? " M file.ts\n" : "",
        });
        const diagnostics = await bind(runtime, parent);
        assert.notEqual(diagnostics[0]?.outcome, "cleaned");
        assert.equal(client.calls.some(({ method }) => method === "worktree.remove" || method === "workspace.close"), false);
        if (scenario === "dirty") {
          assert.equal(diagnostics[0]?.outcome, "identity_mismatch");
          assert.equal(runtime.list().length, 0);
        }
      } finally {
        await rm(parent.root, { recursive: true, force: true });
      }
    });
  }

  await context.test("structured absence finalizes only when the checkout is absent", async () => {
    const parent = await createParent();
    try {
      const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, stoppedWorker(parent, path));
      const client = new FakeHerdr();
      client.failGetWorkspace = new HerdrError("missing", { code: "workspace_not_found" });
      const runtime = runtimeFor(parent, client, {
        isProcessAlive: () => false,
        gitStatus: async () => { throw new Error("checkout absent"); },
      });
      assert.equal((await bind(runtime, parent))[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "workspace.get"]);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });
});

test("aborted cleanup-only replay requires dead ownership, stop proof, and exact reader or worker residue", async (context) => {
  function aborted(parent: ParentFixture, overrides: Partial<HerdrStateRecord> = {}): HerdrStateRecord {
    return priorRecord(parent, {
      state: "stopping",
      artifactPath: resolveArtifactLocation({
        agentDir: parent.agentDir,
        parentSessionId: "parent-session",
        runId: "run-prior",
      }).path,
      childStopped: true,
      generation: {
        number: 1,
        baselineEntryId: null,
        delivery: "pending",
        outcome: "aborted",
        artifactParentPersisted: true,
      },
      ...overrides,
    });
  }

  await context.test("dead exact reader residue", async () => {
    const parent = await createParent();
    try {
      const record = aborted(parent);
      await mkdir(record.childSessionDir, { recursive: true });
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
      const client = new FakeHerdr();
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls, []);
      assert.equal(existsSync(record.childSessionDir), false);
      assert.deepEqual(records(parent.manager).slice(-2).map(({ state }) => state), ["stopping", "closed"]);
      assert.deepEqual(runtime.list(), []);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("dead exact worker residue", async () => {
    const parent = await createParent();
    try {
      const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
      await mkdir(path, { recursive: true });
      const record = aborted(parent, {
        profile: "worker",
        childCwd: path,
        workspaceId: "w-worker",
        worktree: { workspaceId: "w-worker", path, branch: "herdr-subagents/run-prior" },
      });
      await mkdir(record.childSessionDir, { recursive: true });
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
      const client = new FakeHerdr();
      client.workspace = { workspaceId: "w-worker", worktree: { checkoutPath: path, isLinkedWorktree: true } };
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false, gitStatus: async () => "" });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "worktree.remove"]);
      assert.equal(existsSync(record.childSessionDir), false);
      assert.equal(client.calls.some(({ method }) => method === "pane.close"), false);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("already-finalized aborted worker residue", async () => {
    const parent = await createParent();
    try {
      const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
      const record = aborted(parent, {
        profile: "worker",
        childCwd: path,
        workspaceId: "w-worker",
        worktree: { workspaceId: "w-worker", path, branch: "herdr-subagents/run-prior" },
      });
      await mkdir(record.childSessionDir, { recursive: true });
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
      const client = new FakeHerdr();
      client.failGetWorkspace = new HerdrError("missing", { code: "workspace_not_found" });
      const runtime = runtimeFor(parent, client, {
        isProcessAlive: () => false,
        gitStatus: async () => { throw new Error("checkout absent"); },
      });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "cleaned");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "workspace.get"]);
      assert.equal(existsSync(record.childSessionDir), false);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  for (const scenario of ["live owner", "missing stop", "missing abort", "wrong path"] as const) {
    await context.test(scenario, async () => {
      const parent = await createParent();
      try {
        const record = aborted(parent, scenario === "missing stop"
          ? { childStopped: undefined }
          : scenario === "missing abort"
            ? { generation: { number: 1, baselineEntryId: null, delivery: "pending", artifactParentPersisted: true } }
            : scenario === "wrong path"
              ? { childSessionPath: join(parent.root, "wrong", "session.jsonl") }
              : {});
        await mkdir(record.childSessionDir, { recursive: true });
        parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
        const client = new FakeHerdr();
        const runtime = runtimeFor(parent, client, { isProcessAlive: () => scenario === "live owner" });
        const diagnostics = await bind(runtime, parent);
        assert.notEqual(diagnostics[0]?.outcome, "cleaned");
        assert.equal(client.calls.length, 0);
        assert.equal(existsSync(record.childSessionDir), true);
        assert.equal(records(parent.manager).length, 1);
      } finally {
        await rm(parent.root, { recursive: true, force: true });
      }
    });
  }

  await context.test("symlinked reader session directory", async () => {
    const parent = await createParent();
    try {
      const record = aborted(parent);
      const external = join(parent.root, "external-session");
      await mkdir(external, { recursive: true });
      await mkdir(join(record.childSessionDir, ".."), { recursive: true });
      await symlink(external, record.childSessionDir, "dir");
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
      const client = new FakeHerdr();
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "identity_mismatch");
      assert.equal(client.calls.length, 0);
      assert.equal(existsSync(external), true);
      assert.equal(records(parent.manager).length, 1);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("dirty aborted worker is untouched", async () => {
    const parent = await createParent();
    try {
      const path = join(parent.root, ".herdr-subagents-worktrees", "run-prior");
      await mkdir(path, { recursive: true });
      const record = aborted(parent, {
        profile: "worker",
        childCwd: path,
        workspaceId: "w-worker",
        worktree: { workspaceId: "w-worker", path, branch: "herdr-subagents/run-prior" },
      });
      await mkdir(record.childSessionDir, { recursive: true });
      parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
      const client = new FakeHerdr();
      client.workspace = { workspaceId: "w-worker", worktree: { checkoutPath: path, isLinkedWorktree: true } };
      const runtime = runtimeFor(parent, client, { isProcessAlive: () => false, gitStatus: async () => " M file.ts\n" });
      const diagnostics = await bind(runtime, parent);
      assert.equal(diagnostics[0]?.outcome, "identity_mismatch");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get"]);
      assert.equal(existsSync(record.childSessionDir), true);
      assert.equal(client.calls.some(({ method }) => method === "worktree.remove"), false);
      assert.equal(records(parent.manager).length, 1);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  });

  await context.test("reload and closed abortion are non-mutating terminal states", async () => {
    for (const [reason, state] of [["reload", "stopping"], ["startup", "closed"]] as const) {
      const parent = await createParent();
      try {
        const record = aborted(parent, { state });
        await mkdir(record.childSessionDir, { recursive: true });
        parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, record);
        const client = new FakeHerdr();
        const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
        const diagnostics = await bind(runtime, parent, reason);
        assert.equal(client.calls.length, 0);
        assert.equal(existsSync(record.childSessionDir), true);
        assert.deepEqual(runtime.list(), []);
        if (state === "closed") {
          assert.equal(diagnostics[0]?.outcome, "closed");
          assert.match(diagnostics[0]?.message ?? "", /left run run-prior closed/);
        } else {
          assert.deepEqual(diagnostics, []);
        }
      } finally {
        await rm(parent.root, { recursive: true, force: true });
      }
    }
  });
});

test("dead-owner archive retention is rebound only for exact subagent_stop recovery", async () => {
  const parent = await createParent();
  try {
    const artifactPath = resolveArtifactLocation({
      agentDir: parent.agentDir,
      parentSessionId: "parent-session",
      runId: "run-prior",
    }).path;
    const retained = priorRecord(parent, {
      state: "retained",
      artifactPath,
      archivePending: true,
      generation: {
        number: 1,
        baselineEntryId: null,
        delivery: "pending",
        artifactParentPersisted: true,
      },
      retained: ["pane=pane-prior", `sessionDir=${join(parent.agentDir, "herdr-subagents", "parent-session", "run-prior")}`],
    });
    parent.manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, retained);
    await mkdir(retained.childSessionDir, { recursive: true });
    const child = SessionManager.create(parent.root, retained.childSessionDir, { id: retained.childSessionId });
    child.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
    child.appendMessage(assistant("recovered exact result"));

    const client = new FakeHerdr();
    exactPriorAgent(client);
    const runtime = runtimeFor(parent, client, { isProcessAlive: () => false });
    const diagnostics = await bind(runtime, parent);
    assert.equal(diagnostics[0]?.outcome, "retained");
    assert.equal(runtime.status("run-prior").archivePending, true);
    await assert.rejects(runtime.send("run-prior", "must not adopt"), /Run is not live/);

    const stopped = await runtime.stop("run-prior");
    assert.equal(stopped.run.lifecycle, "closed");
    assert.equal(stopped.run.latestResult?.text, "recovered exact result");
    assert.equal(stopped.run.generation?.returned, true);
    assert.equal(existsSync(retained.childSessionDir), false);
    assert.match(await readFile(artifactPath, "utf8"), /recovered exact result/);
    assert.deepEqual(client.calls.map(({ method }) => method), ["agent.get", "pane.close", "tab.close"]);
    assert.equal((await runtime.stop("run-prior")).run.latestResult?.text, "recovered exact result");
  } finally {
    await rm(parent.root, { recursive: true, force: true });
  }
});

test("settlement waits for delivery confirmation, blocks tree while open, and retains partial cleanup without retry", async () => {
  const parent = await createParent();
  try {
    const deliveries: ResultDelivery[] = [];
    const client = new FakeHerdr();
    client.statuses = ["idle"];
    const changes: string[][] = [];
    let runtime!: SubagentRuntime;
    runtime = runtimeFor(parent, client, {
      deliveries,
      onRunsChanged: () => {
        changes.push(runtime.list().map(({ lifecycle }) => lifecycle));
        throw new Error("widget failed");
      },
    });
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
    client.statusSubscriptions[0]!.emit("idle");
    await eventually(() => deliveries.length === 1);
    assert.equal(runtime.status(started.id).generation?.delivery, "queued");
    assert.deepEqual(await runtime.settle(request), []);
    const delivery = deliveries[0]!;
    assert.equal(runtime.confirmDelivery({ role: "custom", ...delivery }), true);

    client.failCloseTab = true;
    changes.length = 0;
    const [settled] = await runtime.settle(request);
    assert.equal(settled?.run.lifecycle, "retained");
    assert.equal(settled?.retained.includes(`tab=${started.tabId}`), true);
    assert.equal(runtime.hasOpenRuns(request), false);
    assert.equal(records(parent.manager).at(-1)?.state, "retained");
    assert.deepEqual(changes, [["stopping"], ["retained"]]);
    const destructiveCalls = client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close").length;
    const [shutdownResult] = await runtime.shutdown("quit");
    assert.equal(shutdownResult?.run.lifecycle, "retained");
    assert.equal(shutdownResult?.retained.includes(`tab=${started.tabId}`), true);
    // Shutdown retries retained runs with a fresh deadline instead of skipping them.
    assert.equal(
      client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close").length > destructiveCalls,
      true,
    );
  } finally {
    await rm(parent.root, { recursive: true, force: true });
  }
});

test("bulk settlement cleans every run when one stopping journal write fails", async () => {
  const parent = await createParent();
  try {
    const client = new FakeHerdr();
    const changes: string[][] = [];
    let failedStopping = false;
    let runtime!: SubagentRuntime;
    runtime = runtimeFor(parent, client, {
      ids: ["run-one", "run-two"],
      appendState: (customType, record) => {
        if (record.state === "stopping" && record.runId === "run-one" && !failedStopping) {
          failedStopping = true;
          throw new Error("stopping journal failed");
        }
        parent.manager.appendCustomEntry(customType, record);
      },
      onRunsChanged: () => {
        changes.push(runtime.list().map(({ id, lifecycle }) => `${id}:${lifecycle}`));
        throw new Error("widget failed");
      },
    });
    await bind(runtime, parent);

    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => appendChildResult(client, "first");
    await runtime.start("scout", "one", parent.root, { wait: true, timeoutMs: 100 });
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => appendChildResult(client, "second");
    await runtime.start("researcher", "two", parent.root, { wait: true, timeoutMs: 100 });

    const request = runtime.requestFor({
      parentSessionId: "parent-session",
      parentSessionFile: parent.parentSessionFile,
      parentEntryId: parent.parentEntryId,
    });
    changes.length = 0;
    const monitorSignals = client.calls
      .filter(({ method }) => method === "events.subscribe")
      .map(({ signal }) => signal);
    const cleanupStart = client.calls.length;
    const settled = await runtime.settle(request);

    assert.equal(failedStopping, true);
    assert.equal(monitorSignals.filter((signal) => signal?.aborted).length >= 2, true);
    assert.deepEqual(settled.map(({ run }) => [run.id, run.lifecycle]), [
      ["run-one", "closed"],
      ["run-two", "closed"],
    ]);
    assert.deepEqual(changes, [
      ["run-one:stopping", "run-two:live"],
      ["run-two:live"],
      ["run-two:stopping"],
      [],
    ]);
    assert.deepEqual(runtime.list(), []);
    const cleanup = client.calls.slice(cleanupStart)
      .filter(({ method }) => method === "pane.close" || method === "tab.close");
    assert.deepEqual(cleanup.map(({ method }) => method), [
      "pane.close", "tab.close", "pane.close", "tab.close",
    ]);
    assert.equal(cleanup[0]?.signal, cleanup[1]?.signal);
    assert.equal(cleanup[2]?.signal, cleanup[3]?.signal);
    assert.notEqual(cleanup[0]?.signal, cleanup[2]?.signal);
    assert.deepEqual(records(parent.manager)
      .filter(({ state }) => state === "stopping" || state === "closed")
      .map(({ runId, state }) => `${runId}:${state}`), [
      "run-one:stopping",
      "run-one:closed",
      "run-two:stopping",
      "run-two:stopping",
      "run-two:closed",
    ]);
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
      const changes: string[][] = [];
      let runtime!: SubagentRuntime;
      runtime = runtimeFor(parent, client, {
        instanceId: `instance-${reason}`,
        onRunsChanged: () => {
          changes.push(runtime.list().map(({ lifecycle }) => lifecycle));
          throw new Error("widget failed");
        },
      });
      await bind(runtime, parent);
      await runtime.start("scout", "pending", parent.root);
      await eventually(() => client.calls.some(({ method }) => method === "events.subscribe"));
      const monitorSignals = client.calls.filter(({ method }) => method === "events.subscribe").map(({ signal }) => signal);
      changes.length = 0;
      const [stopped] = await runtime.shutdown(reason);
      assert.equal(stopped?.run.lifecycle, "retained", reason);
      assert.equal(monitorSignals.some((signal) => signal?.aborted), true, reason);
      const cleanup = client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close");
      assert.deepEqual(cleanup.map(({ method }) => method), ["pane.close", "tab.close"]);
      assert.equal(cleanup[0]?.signal, cleanup[1]?.signal);
      assert.equal(monitorSignals.includes(cleanup[0]?.signal), false);
      assert.deepEqual(records(parent.manager).slice(-2).map(({ state }) => state), ["stopping", "retained"]);
      assert.deepEqual(changes, [["stopping"], ["retained"]], reason);
    } finally {
      await rm(parent.root, { recursive: true, force: true });
    }
  }
});

test("cross-session recovery writes only the original journal and refuses live unreleased owners", async () => {
  const oldParent = await createParent("parent-session");
  const newParent = await createParent("replacement-session");
  // Share one agentDir so locators are globally visible to the replacement session.
  const sharedAgentDir = oldParent.agentDir;
  newParent.agentDir = sharedAgentDir;
  try {
    const client = new FakeHerdr();
    client.statuses = ["idle"];
    const danglingRuntime = runtimeFor(oldParent, client, {
      instanceId: "instance-dangling",
      processId: 4242,
      ids: ["run-dangling"],
      isProcessAlive: () => false,
    });
    await bind(danglingRuntime, oldParent);
    const dangling = await danglingRuntime.start("scout", "left behind", oldParent.root);
    await mkdir(dangling.childSessionDir, { recursive: true });
    const retained = await danglingRuntime.stop(dangling.id);
    assert.equal(retained.run.lifecycle, "retained");
    await danglingRuntime.releaseCurrentOwnerLocators();
    const beforeNew = records(oldParent.manager).length;

    const freshClient = new FakeHerdr();
    const newRuntime = runtimeFor(newParent, freshClient, {
      instanceId: "instance-new",
      processId: 9999,
      // 4242 is the dangling dead owner; 7777 is the later live owner under test.
      isProcessAlive: (pid) => pid === 7777,
    });
    await bind(newRuntime, newParent);
    const listed = await newRuntime.listRecoverable();
    assert.equal(listed.candidates.some((candidate) =>
      candidate.runId === dangling.id
      && candidate.parentSessionId === "parent-session"
      && candidate.actionable),
    true);

    const recovered = await newRuntime.recover({
      parentSessionId: "parent-session",
      id: dangling.id,
      discardIncompleteResult: true,
    });
    assert.equal(recovered.run.lifecycle, "closed");
    assert.equal(newRuntime.list().some((run) => run.id === dangling.id), false);
    assert.equal(records(newParent.manager).length, 0);
    const reopenedOld = SessionManager.open(oldParent.parentSessionFile);
    const oldAfter = records(reopenedOld);
    assert.equal(oldAfter.length > beforeNew, true);
    assert.equal(oldAfter.at(-1)?.state, "closed");
    assert.equal(oldAfter.at(-1)?.parentInstanceId, "instance-dangling");
    assert.equal(oldAfter.at(-1)?.parentProcessId, 4242);
    assert.equal(oldAfter.at(-1)?.parentSessionFile, oldParent.parentSessionFile);

    // Live unreleased owner must not mutate.
    client.statuses = ["idle"];
    const liveRuntime = runtimeFor(oldParent, client, {
      instanceId: "instance-live",
      processId: 7777,
      ids: ["run-live"],
      isProcessAlive: (pid) => pid === 7777,
    });
    await bind(liveRuntime, oldParent);
    const live = await liveRuntime.start("scout", "still owned", oldParent.root);
    const liveList = await newRuntime.listRecoverable();
    const liveCandidate = liveList.candidates.find((candidate) => candidate.runId === live.id);
    assert.equal(liveCandidate?.classification, "live_unreleased_owner");
    assert.equal(liveCandidate?.actionable, false);
    await assert.rejects(newRuntime.recover({
      parentSessionId: "parent-session",
      id: live.id,
    }), /live unreleased owner/);
    await liveRuntime.stop(live.id, { discardIncompleteResult: true });
  } finally {
    await rm(oldParent.root, { recursive: true, force: true });
    await rm(newParent.root, { recursive: true, force: true });
  }
});
