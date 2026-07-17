import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import type { PaneInfo, WorktreeCreateInput, WorkspaceInfo } from "../../src/herdr/protocol.ts";
import { DelegationGroupManager } from "../../src/runtime/groups.ts";
import { ActiveBranchOwnershipJournal, type PiBranchEntry } from "../../src/runtime/ownership.ts";
import { PartialStartRecorder } from "../../src/runtime/reconcile.ts";
import { WorktreeManager, WorktreeProvisionError, WorktreeRegistry } from "../../src/worktrees/manager.ts";
import { pane, tab, workspace } from "../herdr/fixtures.ts";

async function repository() {
  const container = await mkdtemp(join(tmpdir(), "pi-herdr-manager-")); const root = join(container, "repo");
  execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);
  return { root, container, dispose: () => rm(container, { recursive: true, force: true }) };
}
function newRegistry() { return new WorktreeRegistry({ appendEntry() {} }); }
function artifacts(path: string) { return [{ kind: "handoff" as const, sourcePath: join(path, ".subagents", "runs", "run-1", "handoff.parent.md"), writer: "parent" as const, required: true }, { kind: "progress" as const, sourcePath: join(path, ".subagents", "runs", "run-1", "progress.md"), writer: "child" as const, required: false }]; }
function owner(runId = "run-1") { return { runId, runNonce: `nonce-${runId}`, parent: { sessionId: "parent", branchEntryId: "branch-entry" } }; }

function fakeHerdr(root: string, failGroupBaseline = false) {
  let sequence = 1; const creates: WorktreeCreateInput[] = []; let childWorkspace: WorkspaceInfo | undefined;
  let createdTab: typeof tab | undefined; let createdRoot: PaneInfo | undefined; let groupTab: typeof tab | undefined; let groupRoot: PaneInfo | undefined;
  const client = {
    async listWorktrees() { return { source: { repo_key: "repo-key", repo_name: "repo", repo_root: root, source_checkout_path: root, source_workspace_id: "w1" }, worktrees: [] }; },
    async createWorktree(input: WorktreeCreateInput) {
      creates.push(input); assert.equal(input.focus, false); assert.ok(input.path && input.branch && input.base);
      execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", input.branch!, input.path!, input.base!]);
      const workspaceId = "w2"; const tabId = "w2:t1"; const rootPane = { ...pane, pane_id: "w2:p1", terminal_id: "term-wt-root", workspace_id: workspaceId, tab_id: tabId, focused: false };
      childWorkspace = { ...workspace, workspace_id: workspaceId, active_tab_id: tabId, focused: false, worktree: { repo_key: "repo-key", repo_name: "repo", repo_root: root, checkout_path: input.path!, is_linked_worktree: true } };
      createdTab = { ...tab, workspace_id: workspaceId, tab_id: tabId, focused: false }; createdRoot = rootPane;
      return { workspace: childWorkspace, tab: createdTab, rootPane, worktree: { path: input.path!, branch: input.branch!, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: input.label ?? "", open_workspace_id: workspaceId } };
    },
    async createTab(input: { workspace_id?: string; focus?: boolean }) {
      assert.equal(input.workspace_id, "w2"); assert.equal(input.focus, false); sequence += 1;
      groupTab = { ...tab, workspace_id: "w2", tab_id: `w2:t${sequence}`, focused: false };
      groupRoot = { ...pane, workspace_id: "w2", tab_id: `w2:t${sequence}`, pane_id: `w2:p${sequence}`, terminal_id: `term-group-${sequence}`, focused: false };
      return { tab: groupTab, rootPane: groupRoot };
    },
    async snapshot() { return { version: "0.7.3", protocol: 16, workspaces: childWorkspace ? [childWorkspace] : [], tabs: [createdTab, groupTab].filter(Boolean), panes: [createdRoot, groupRoot].filter(Boolean), layouts: [], agents: [] }; },
    async getPaneProcessInfo(paneId: string) { if (failGroupBaseline) throw new Error("baseline unavailable"); return { pane_id: paneId, shell_pid: 10, tty: "/dev/tty", foreground_process_group_id: 10, foreground_processes: [] }; },
  } as unknown as HerdrRequestClient;
  return { client, creates, get workspace() { return childWorkspace; } };
}

test("writer worktree creation records canonical Git/Herdr provenance and a separate no-focus group tab", async () => {
  const repo = await repository(); const path = join(repo.container, "writer-checkout");
  try {
    const fake = fakeHerdr(repo.root); const registry = newRegistry(); const manager = new WorktreeManager(fake.client, new DelegationGroupManager(fake.client), registry);
    const callbacks: string[] = [];
    const record = await manager.createForWriter({ id: "run-1", owner: owner(), source: { workspace_id: "w1" }, group: "implementation", path, artifacts: artifacts(path), onWorktreeCreated(value) { callbacks.push(`created:${value.workspaceId}`); }, onGroupReady(value) { callbacks.push(`group:${value.tab?.tabId}`); } });
    assert.deepEqual(callbacks, ["created:w2", "group:w2:t2"]); assert.equal(record.state, "created"); assert.equal(record.sourceWorkspaceId, "w1"); assert.equal(record.herdrRepositoryKey, "repo-key");
    assert.equal(record.checkoutPath, await realpath(path)); assert.equal(record.tab?.tabId, "w2:t2"); assert.notEqual(record.tab?.tabId, record.createdRoot.tabId); assert.match(record.createdRoot.rootProcessBaseline!, /^[a-f0-9]{64}$/); assert.match(record.tab!.rootProcessBaseline, /^[a-f0-9]{64}$/);
    assert.equal(fake.creates[0]?.focus, false); assert.match(record.branch, /^herdr-subagents\/run-1-/); assert.match(record.base, /^[a-f0-9]{40}$/);
    assert.deepEqual(registry.getState("run-1")?.parentVerification, { review: "pending", integration: "pending" });
  } finally { if (existsSync(path)) execFileSync("git", ["-C", repo.root, "worktree", "remove", "--force", path], { stdio: "ignore" }); await repo.dispose(); }
});

test("worktree provenance is appended before group failure and partial resources are retained", async () => {
  const repo = await repository(); const path = join(repo.container, "partial-checkout");
  try {
    const fake = fakeHerdr(repo.root, true); const registry = newRegistry(); const manager = new WorktreeManager(fake.client, new DelegationGroupManager(fake.client), registry);
    const entries: PiBranchEntry[] = [{ type: "message", id: "leaf", parentId: null }];
    const journal = new ActiveBranchOwnershipJournal({ appendEntry(customType, data) { entries.push({ type: "custom", id: `e${entries.length}`, parentId: entries.at(-1)?.id ?? null, customType, data }); } });
    const recorder = new PartialStartRecorder(journal, journal.begin({ runId: "run-1", runNonce: "nonce-run-1", branchEntryId: "leaf", sessionId: "parent", intended: { workspaceId: "w1", group: "implementation", worktreeRequested: true } }));
    await assert.rejects(manager.createForWriter({ id: "run-1", owner: owner(), source: { cwd: repo.root }, group: "implementation", path, artifacts: artifacts(path), onWorktreeCreated(record) { recorder.recordWorktree(record); } }), (error: unknown) => error instanceof WorktreeProvisionError && error.retained.state === "retained");
    assert.equal(recorder.current.phase, "worktree_created"); assert.equal(recorder.current.resources.repositoryId, registry.get("run-1")?.repositoryId); assert.equal(recorder.current.resources.worktreeWorkspaceId, "w2"); assert.equal(recorder.current.resources.worktreeInitialTabId, "w2:t1"); assert.equal(recorder.current.resources.worktreeInitialRootTerminalId, "term-wt-root");
    assert.equal(execFileSync("git", ["-C", repo.root, "worktree", "list", "--porcelain"], { encoding: "utf8" }).includes(path), true);
    assert.match(registry.get("run-1")?.retentionReason ?? "", /partial.*baseline unavailable/i);
  } finally { if (existsSync(path)) execFileSync("git", ["-C", repo.root, "worktree", "remove", "--force", path], { stdio: "ignore" }); await repo.dispose(); }
});

test("durable worktree snapshots recover artifact paths and transitions; malformed later state is retained uncertain", async () => {
  const repo = await repository(); const path = join(repo.container, "durable-checkout");
  try {
    const entries: PiBranchEntry[] = [{ type: "message", id: "branch-entry", parentId: null }];
    const append = { appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: `d${entries.length}`, parentId: entries.at(-1)?.id ?? null, customType, data }); } };
    const registry = new WorktreeRegistry(append); const fake = fakeHerdr(repo.root);
    const created = await new WorktreeManager(fake.client, new DelegationGroupManager(fake.client), registry).createForWriter({ id: "run-1", owner: owner(), source: { cwd: repo.root }, group: "implementation", path, artifacts: artifacts(path) });
    registry.setParentReviewed(created.id, "reviewed");
    registry.setCapturedArtifacts(created.id, created.artifactPaths.map((artifact) => ({ ...artifact, writer: "parent", absolutePath: join(repo.root, ".subagents", "captured", `${artifact.kind}.md`), byteLength: 12, sha256: "a".repeat(64), capturedAt: 2 })));
    registry.retain(created.id, "operator retained");
    const recovered = WorktreeRegistry.recover(entries, append).get(created.id)!;
    assert.equal(recovered.state, "retained"); assert.equal(recovered.parentVerification.review, "reviewed"); assert.equal(recovered.artifactsCaptured, true);
    assert.deepEqual(recovered.artifactPaths, registry.get(created.id)?.artifactPaths); assert.deepEqual(recovered.capturedArtifacts, registry.get(created.id)?.capturedArtifacts);

    const latest = entries.at(-1)!; entries.push({ type: "custom", id: "tampered", parentId: latest.id, customType: latest.customType!, data: { ...(latest.data as object), sequence: 999 } });
    const uncertain = WorktreeRegistry.recover(entries, append).get(created.id)!;
    assert.equal(uncertain.state, "retained"); assert.match(uncertain.recoveryIssue ?? "", /non-contiguous/);
    assert.throws(() => WorktreeRegistry.recover(entries, append).setParentReviewed(created.id), /uncertain/);
  } finally { if (existsSync(path)) execFileSync("git", ["-C", repo.root, "worktree", "remove", "--force", path], { stdio: "ignore" }); await repo.dispose(); }
});

test("registry persistence failure leaves the prior cleanup-critical state unchanged", async () => {
  const repo = await repository(); const path = join(repo.container, "failed-persist-checkout"); let fail = false;
  try {
    const registry = new WorktreeRegistry({ appendEntry() { if (fail) throw new Error("journal unavailable"); } }); const fake = fakeHerdr(repo.root);
    const created = await new WorktreeManager(fake.client, new DelegationGroupManager(fake.client), registry).createForWriter({ id: "run-1", owner: owner(), source: { cwd: repo.root }, group: "implementation", path, artifacts: artifacts(path) });
    fail = true; assert.throws(() => registry.setParentReviewed(created.id), /journal unavailable/);
    assert.equal(registry.get(created.id)?.parentVerification.review, "pending");
  } finally { if (existsSync(path)) execFileSync("git", ["-C", repo.root, "worktree", "remove", "--force", path], { stdio: "ignore" }); await repo.dispose(); }
});

test("manager rejects overlapping paths before asking Herdr to create anything", async () => {
  const repo = await repository();
  try {
    const fake = fakeHerdr(repo.root); const manager = new WorktreeManager(fake.client, new DelegationGroupManager(fake.client), newRegistry());
    await assert.rejects(manager.createForWriter({ id: "run-1", owner: owner(), source: { cwd: repo.root }, group: "g", path: join(repo.root, "nested"), artifacts: artifacts(join(repo.root, "nested")) }), /non-overlapping/);
    assert.equal(fake.creates.length, 0);
  } finally { await repo.dispose(); }
});
