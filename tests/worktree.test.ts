import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
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
    pollIntervalMs: 1,
    gitStatus: async () => "",
  });
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
  assert.equal(client.calls.some(({ method }) => method === "tab.create"), false);
});

test("clean worker removal is non-force and retains the branch", async () => {
  const client = new FakeHerdr();
  const cleanup = await cleanupWorkerWorktree(client, facts, undefined, async () => "");
  assert.deepEqual(cleanup, { removed: true, branch: "herdr-subagents/run-worker" });
  assert.deepEqual(client.calls, [{ method: "worktree.remove", input: { workspaceId: "w-worker", force: false } }]);
});

test("dirty worker is retained with exact path and branch", async () => {
  const client = new FakeHerdr();
  const cleanup = await cleanupWorkerWorktree(client, facts, undefined, async () => " M file.ts\n");
  assert.deepEqual(cleanup, {
    removed: false,
    branch: "herdr-subagents/run-worker",
    path: "/repo/.herdr-subagents-worktrees/run-worker",
    reason: "worktree is dirty",
  });
  assert.equal(client.calls.length, 0);
});

test("failed dirtiness check retains the worker for manual handling", async () => {
  const client = new FakeHerdr();
  const cleanup = await cleanupWorkerWorktree(client, facts, undefined, async () => { throw new Error("git unavailable"); });
  assert.equal(cleanup.removed, false);
  if (!cleanup.removed) {
    assert.equal(cleanup.path, facts.path);
    assert.equal(cleanup.branch, facts.branch);
    assert.match(cleanup.reason, /git status failed: git unavailable/);
  }
  assert.equal(client.calls.length, 0);
});
