import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HerdrError, type WorkspaceInfo } from "../src/herdr.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import { cleanupWorkerWorktree, type WorktreeFacts } from "../src/worktree.ts";
import { FakeHerdr } from "./fake-herdr.ts";

const facts: WorktreeFacts = {
  workspaceId: "w-worker",
  path: "/repo/.herdr-subagents-worktrees/run-worker",
  branch: "herdr-subagents/run-worker",
};

test("nested cwd resolves one sibling worktree and concurrent worker start is refused", async () => {
  const client = new FakeHerdr();
  client.startStatus = "idle";
  client.statuses = ["idle"];
  const subject = new SubagentRuntime(client, { workspaceId: "w-parent" }, {
    idFactory: () => "run-worker",
    instanceIdFactory: () => "instance-worker",
    pollIntervalMs: 1,
    gitStatus: async () => "",
    appendState: () => {},
  });
  await subject.bindParent({
    parentSessionId: "parent",
    parentSessionFile: "/tmp/parent-session.jsonl",
    parentEntryId: "parent-leaf",
  }, [], "startup");
  const checkoutRoot = process.cwd();
  const parentCwd = join(checkoutRoot, "src");
  const workerPath = join(dirname(checkoutRoot), ".herdr-subagents-worktrees", "run-worker");
  const outcomes = await Promise.allSettled([
    subject.start("worker", "change one file", parentCwd),
    subject.start("worker", "second", parentCwd),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  const started = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<SubagentRuntime["start"]>>> => outcome.status === "fulfilled")?.value;
  assert.equal(started?.worktree?.path, workerPath);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  assert.match(String(rejected?.reason), /Only one worker/);
  const launch = client.calls.find(({ method }) => method === "agent.start")?.input as Record<string, unknown>;
  assert.equal(launch.cwd, workerPath);
  assert.equal(client.calls.filter(({ method }) => method === "worktree.create").length, 1);
  assert.equal((client.calls.find(({ method }) => method === "worktree.create")?.input as Record<string, unknown>).label, "subagent:parent:run-worker");
  assert.equal(client.calls.some(({ method }) => method === "tab.create"), false);
  assert.match(started?.warning ?? "", /Generated branch: herdr-subagents\/run-worker/);
  assert.match(started?.warning ?? "", /Parent owner: parent/);
  assert.match(started?.warning ?? "", /dirty or uncheckable worktree is also retained/);
  if (started) await subject.stop(started.id);
  await rm(workerPath, { recursive: true, force: true });
});

test("clean worker removal is bounded, non-force, and retains the branch", async () => {
  const client = new FakeHerdr();
  const controller = new AbortController();
  let statusSignal: AbortSignal | undefined;
  const cleanup = await cleanupWorkerWorktree(client, facts, controller.signal, async (_cwd, signal) => {
    statusSignal = signal;
    return "";
  });
  assert.equal(statusSignal, controller.signal);
  assert.deepEqual(cleanup, { action: "removed", removed: true, branch: "herdr-subagents/run-worker" });
  assert.deepEqual(client.calls, [{ method: "worktree.remove", input: { workspaceId: "w-worker", force: false }, signal: controller.signal }]);
});

test("dirty worker is retained with exact path and branch", async () => {
  const client = new FakeHerdr();
  const cleanup = await cleanupWorkerWorktree(client, facts, undefined, async () => " M file.ts\n");
  assert.deepEqual(cleanup, {
    action: "retained",
    removed: false,
    branch: "herdr-subagents/run-worker",
    path: "/repo/.herdr-subagents-worktrees/run-worker",
    reason: "worktree is dirty",
  });
  assert.equal(client.calls.length, 0);
});

test("failed dirtiness check retains a path-present worker for manual handling", async () => {
  const path = await mkdtemp(join(tmpdir(), "worker-status-failure-"));
  const presentFacts = { ...facts, path };
  try {
    const client = new FakeHerdr();
    const cleanup = await cleanupWorkerWorktree(client, presentFacts, undefined, async () => { throw new Error("git unavailable"); });
    assert.equal(cleanup.removed, false);
    if (!cleanup.removed) {
      assert.equal(cleanup.action, "retained");
      assert.equal(cleanup.path, path);
      assert.equal(cleanup.branch, facts.branch);
      assert.match(cleanup.reason, /git status failed: git unavailable/);
    }
    assert.equal(client.calls.length, 0);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("an absent checkout closes only the exact linked workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-orphan-"));
  const absentFacts = { ...facts, path: join(root, "missing") };
  const client = new FakeHerdr();
  client.workspace = {
    workspaceId: facts.workspaceId,
    worktree: { checkoutPath: join(root, "other", "..", "missing"), isLinkedWorktree: true },
  };
  const controller = new AbortController();
  try {
    const cleanup = await cleanupWorkerWorktree(client, absentFacts, controller.signal, async () => {
      throw new Error("fatal: cannot change to missing checkout");
    });
    assert.deepEqual(cleanup, { action: "finalized", removed: true, branch: facts.branch });
    assert.deepEqual(client.calls, [
      { method: "workspace.get", input: { workspaceId: facts.workspaceId }, signal: controller.signal },
      { method: "workspace.close", input: { workspaceId: facts.workspaceId }, signal: controller.signal },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured workspace absence is already finalized without parsing its message", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-absent-workspace-"));
  const absentFacts = { ...facts, path: join(root, "missing") };
  const client = new FakeHerdr();
  client.failGetWorkspace = new HerdrError("unrelated text", { code: "workspace_not_found" });
  try {
    const cleanup = await cleanupWorkerWorktree(client, absentFacts, undefined, async () => { throw new Error("status failed"); });
    assert.deepEqual(cleanup, { action: "already-finalized", removed: true, branch: facts.branch });
    assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absent checkout lookup mismatches and null worktrees are retained untouched", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "worker-mismatch-"));
  const absentFacts = { ...facts, path: join(root, "missing") };
  const cases: Array<{ name: string; workspace: WorkspaceInfo }> = [
    {
      name: "workspace id",
      workspace: { workspaceId: "w-other", worktree: { checkoutPath: absentFacts.path, isLinkedWorktree: true } },
    },
    {
      name: "checkout path",
      workspace: { workspaceId: facts.workspaceId, worktree: { checkoutPath: join(root, "other"), isLinkedWorktree: true } },
    },
    {
      name: "linked-worktree flag",
      workspace: { workspaceId: facts.workspaceId, worktree: { checkoutPath: absentFacts.path, isLinkedWorktree: false } },
    },
    {
      name: "null worktree",
      workspace: { workspaceId: facts.workspaceId, worktree: null },
    },
  ];
  try {
    for (const entry of cases) {
      await context.test(entry.name, async () => {
        const client = new FakeHerdr();
        client.workspace = entry.workspace;
        const cleanup = await cleanupWorkerWorktree(client, absentFacts, undefined, async () => { throw new Error("status failed"); });
        assert.equal(cleanup.action, "retained");
        assert.equal(cleanup.removed, false);
        assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get"]);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lookup errors, message-only absence, and close failure retain an absent checkout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "worker-errors-"));
  const absentFacts = { ...facts, path: join(root, "missing") };
  try {
    await context.test("lookup error", async () => {
      const client = new FakeHerdr();
      client.failGetWorkspace = new Error("lookup failed");
      const cleanup = await cleanupWorkerWorktree(client, absentFacts, undefined, async () => { throw new Error("status failed"); });
      assert.equal(cleanup.action, "retained");
      assert.match(cleanup.removed ? "" : cleanup.reason, /workspace.get failed: lookup failed/);
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get"]);
    });
    await context.test("message-only absence", async () => {
      const client = new FakeHerdr();
      client.failGetWorkspace = new Error("Herdr workspace_not_found: gone");
      const cleanup = await cleanupWorkerWorktree(client, absentFacts, undefined, async () => { throw new Error("status failed"); });
      assert.equal(cleanup.action, "retained");
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get"]);
    });
    await context.test("close failure", async () => {
      const client = new FakeHerdr();
      client.workspace = {
        workspaceId: facts.workspaceId,
        worktree: { checkoutPath: absentFacts.path, isLinkedWorktree: true },
      };
      client.failCloseWorkspace = true;
      const cleanup = await cleanupWorkerWorktree(client, absentFacts, undefined, async () => { throw new Error("status failed"); });
      assert.equal(cleanup.action, "retained");
      assert.match(cleanup.removed ? "" : cleanup.reason, /workspace.close failed/);
      assert.deepEqual(client.calls.map(({ method }) => method), ["workspace.get", "workspace.close"]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
