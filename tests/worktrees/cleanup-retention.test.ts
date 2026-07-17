import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { materializeHandoff, parentHandoffWrapperPath } from "../../src/artifacts/handoff.ts";
import { resolveArtifactRoots } from "../../src/artifacts/paths.ts";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../src/herdr/protocol.ts";
import { captureWriterArtifacts } from "../../src/worktrees/artifacts.ts";
import {
  requestHumanDiscardAuthorization,
  WorktreeCleanupManager,
  type HumanDiscardAuthorization,
} from "../../src/worktrees/cleanup.ts";
import type { WorktreeRecord } from "../../src/worktrees/contracts.ts";
import { WorktreeRegistry } from "../../src/worktrees/manager.ts";
import { identifyCheckout } from "../../src/worktrees/writer-locks.ts";
import { pane, snapshot, workspace } from "../herdr/fixtures.ts";
import { processBaseline } from "../../src/runtime/groups.ts";

const anchorProcess = { pane_id: "anchor", shell_pid: 10, tty: "/dev/tty-anchor", foreground_process_group_id: 10, foreground_processes: [] };
function newRegistry() { return new WorktreeRegistry({ appendEntry() {} }); }

async function fixture() {
  const container = await mkdtemp(join(tmpdir(), "pi-herdr-cleanup-")); let parent = join(container, "repo"); let child = join(container, "writer");
  execFileSync("git", ["init", "-q", parent]); execFileSync("git", ["-C", parent, "config", "user.email", "test@example.invalid"]); execFileSync("git", ["-C", parent, "config", "user.name", "Test"]);
  await writeFile(join(parent, "tracked.txt"), "base\n"); execFileSync("git", ["-C", parent, "add", "tracked.txt"]); execFileSync("git", ["-C", parent, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", parent, "worktree", "add", "-q", "-b", "writer-branch", child]);
  const excludeText = execFileSync("git", ["-C", parent, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim(); const exclude = isAbsolute(excludeText) ? excludeText : resolve(parent, excludeText); await writeFile(exclude, "/.subagents/\n", { flag: "a" });
  const parentIdentity = await identifyCheckout(parent); const identity = await identifyCheckout(child); parent = parentIdentity.checkoutPath; child = identity.checkoutPath;
  const parentRoots = await resolveArtifactRoots({ checkout: parent, allowProgress: false }); const sourceRoots = await resolveArtifactRoots({ checkout: child, allowProgress: false });
  const artifactDirectory = join(child, ".subagents", "runs", "run-1"); await mkdir(artifactDirectory, { recursive: true });
  const childHandoff = join(artifactDirectory, "handoff.md"); const handoff = parentHandoffWrapperPath(childHandoff); const progress = join(artifactDirectory, "progress.md"); await writeFile(handoff, "verified parent wrapper\n"); await writeFile(progress, "verified progress\n");
  const base = execFileSync("git", ["-C", parent, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const record: WorktreeRecord = {
    schemaVersion: 1, id: "run-1", repositoryId: identity.repositoryId, commonGitDir: identity.commonGitDir, herdrRepositoryKey: "repo-key", sourceWorkspaceId: "w1", sourceCheckoutPath: parent,
    workspaceId: "w2", checkoutPath: child, branch: "writer-branch", base, state: "created", createdRoot: { tabId: "w2:t1", rootPaneId: "w2:p1", rootTerminalId: "term-root", rootProcessBaseline: processBaseline(anchorProcess) },
    tab: { tabId: "w2:t2", rootPaneId: "w2:p2", rootTerminalId: "term-group", rootProcessBaseline: processBaseline(anchorProcess) }, owner: { runId: "run-1", runNonce: "nonce-1", parent: { sessionId: "parent", branchEntryId: "entry" } },
    artifactPaths: [{ kind: "handoff", path: handoff, absolutePath: handoff, writer: "parent", required: true }, { kind: "progress", path: progress, absolutePath: progress, writer: "child", required: false }],
    artifactsCaptured: false, capturedArtifacts: [], parentVerification: { review: "pending", integration: "pending" }, createdAt: 1, updatedAt: 1,
  };
  const capture = { artifacts: [{ kind: "handoff" as const, sourcePath: handoff, required: true }, { kind: "progress" as const, sourcePath: progress, required: false }], sourceRoots, parentRoots, runId: "run-1" };
  return { container, parent, child, childHandoff, handoff, parentRoots, sourceRoots, record, capture, async dispose() { await rm(container, { recursive: true, force: true }); } };
}
function authorization(record: WorktreeRecord) { return { runId: record.owner.runId, runNonce: record.owner.runNonce, parent: record.owner.parent, activeBranchState: "owned" as const }; }
function childWriterProfile(): AgentProfile {
  return { name: "worker", description: "writer", body: "bounded", permissions: "write", artifacts: { writer: "child" }, source: { path: "/worker.md", scope: "bundled", namespace: "shared", priority: 0 } };
}

function fakeHerdr(record: WorktreeRecord, options: { unavailable?: boolean; mismatch?: boolean; writerPane?: PaneInfo; changedAnchor?: string; moveBranchOnRemove?: boolean; gone?: boolean } = {}) {
  const anchors = [
    { ...pane, pane_id: record.createdRoot.rootPaneId, terminal_id: record.createdRoot.rootTerminalId, workspace_id: record.workspaceId, tab_id: record.createdRoot.tabId, focused: false },
    ...(record.tab ? [{ ...pane, pane_id: record.tab.rootPaneId, terminal_id: record.tab.rootTerminalId, workspace_id: record.workspaceId, tab_id: record.tab.tabId, focused: false }] : []),
    ...(options.writerPane ? [options.writerPane] : []),
  ];
  const childWorkspace: WorkspaceInfo = { ...workspace, workspace_id: record.workspaceId, active_tab_id: record.createdRoot.tabId, focused: false, pane_count: anchors.length, tab_count: record.tab ? 2 : 1, worktree: { repo_key: "repo-key", repo_name: "repo", repo_root: record.sourceCheckoutPath, checkout_path: record.checkoutPath, is_linked_worktree: true } };
  const value: SessionSnapshot = options.gone ? snapshot : { ...snapshot, workspaces: [...snapshot.workspaces, childWorkspace], panes: [...snapshot.panes, ...anchors], agents: snapshot.agents };
  let removeCalls = 0; let forceValue: boolean | undefined;
  const client = {
    async ping() { if (options.unavailable) throw new Error("Herdr unavailable"); return { version: "0.7.3", protocol: 16 }; },
    async snapshot() { return value; },
    async getPaneProcessInfo(paneId: string) { return options.changedAnchor === paneId ? { ...anchorProcess, pane_id: paneId, foreground_process_group_id: 99, foreground_processes: [{ pid: 99, name: "active-command" }] } : { ...anchorProcess, pane_id: paneId }; },
    async getWorkspace() { return childWorkspace; },
    async listWorktrees() { return { source: { repo_key: "repo-key", repo_name: "repo", repo_root: record.sourceCheckoutPath, source_checkout_path: record.sourceCheckoutPath, source_workspace_id: "w1" }, worktrees: options.gone ? [] : [{ path: options.mismatch ? `${record.checkoutPath}-other` : record.checkoutPath, branch: record.branch, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: "writer", open_workspace_id: record.workspaceId }] }; },
    async removeWorktree(workspaceId: string, force: boolean) { removeCalls += 1; forceValue = force; execFileSync("git", ["-C", record.sourceCheckoutPath, "worktree", "remove", ...(force ? ["--force"] : []), record.checkoutPath]); if (options.moveBranchOnRemove) { const moved = execFileSync("git", ["-C", record.sourceCheckoutPath, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "moved ref"], { encoding: "utf8" }).trim(); execFileSync("git", ["-C", record.sourceCheckoutPath, "update-ref", `refs/heads/${record.branch}`, moved]); } return { workspaceId, path: record.checkoutPath, forced: force }; },
  } as unknown as HerdrRequestClient;
  return { client, get removeCalls() { return removeCalls; }, get forceValue() { return forceValue; } };
}

test("explicit retain preserves the writer while review remains optional audit state", async () => {
  const value = await fixture();
  try {
    const registry = newRegistry(); registry.register(value.record); const fake = fakeHerdr(value.record); const cleanup = new WorktreeCleanupManager(fake.client, registry);
    const retained = await cleanup.cleanup({ id: "run-1", cleanup: "retain", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots });
    assert.equal(retained.state, "retained"); assert.equal(fake.removeCalls, 0); assert.equal(registry.getState("run-1")?.parentVerification.integration, "pending");
    registry.setParentReviewed("run-1", "parent inspected diff/tests"); assert.equal(registry.getState("run-1")?.parentVerification.review, "reviewed"); assert.equal(registry.getState("run-1")?.state, "retained", "review alone never declares integration");
    assert.throws(() => registry.markRemoved("run-1"), /objective safe-cleanup evidence/);
  } finally { await value.dispose(); }
});

test("cleanup retains until parent result or failure evidence is persisted", async () => {
  const value = await fixture();
  try {
    const registry = newRegistry(); registry.register(value.record); const fake = fakeHerdr(value.record);
    const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: value.record.id, ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, resultEvidencePersisted: false });
    assert.equal(result.retained, true); assert.match(result.reason, /not yet persisted/); assert.equal(fake.removeCalls, 0);
  } finally { await value.dispose(); }
});

test("remove_if_safe captures artifacts, verifies no-change objective evidence, removes identity match, and leaves branch", async () => {
  const value = await fixture();
  try {
    const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1", "reviewed empty checkout"); const fake = fakeHerdr(value.record); const cleanup = new WorktreeCleanupManager(fake.client, registry);
    const result = await cleanup.cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
    assert.equal(result.removed, true); assert.equal(result.record.artifactsCaptured, true); assert.equal(result.record.capturedArtifacts.length, 2); assert.equal(fake.forceValue, false);
    assert.equal(execFileSync("git", ["-C", value.parent, "branch", "--list", "writer-branch"], { encoding: "utf8" }).trim().endsWith("writer-branch"), true, "worktree removal must never delete its branch");
  } finally { await value.dispose(); }
});

test("safe removal compare-deletes only an exact extension-generated branch", async () => {
  const value = await fixture();
  try {
    const branch = "herdr-subagents/run-1-aaaaaaaaaaaa";
    execFileSync("git", ["-C", value.child, "branch", "-m", branch]);
    const record: WorktreeRecord = { ...value.record, branch, generatedBranch: true };
    const registry = newRegistry(); registry.register(record); const fake = fakeHerdr(record);
    const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: record.id, ownership: authorization(record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
    assert.equal(result.removed, true); assert.equal(result.retained, false);
    assert.equal(result.record.finalization?.branchDisposition, "deleted");
    assert.equal(execFileSync("git", ["-C", value.parent, "branch", "--list", branch], { encoding: "utf8" }).trim(), "");
  } finally { await value.dispose(); }
});

test("a generated branch moved after workspace removal is retained and retry remains actionable", async () => {
  const value = await fixture();
  try {
    const branch = "herdr-subagents/run-1-bbbbbbbbbbbb";
    execFileSync("git", ["-C", value.child, "branch", "-m", branch]);
    const record: WorktreeRecord = { ...value.record, branch, generatedBranch: true };
    const registry = newRegistry(); registry.register(record); const fake = fakeHerdr(record, { moveBranchOnRemove: true });
    const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: record.id, ownership: authorization(record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
    assert.equal(result.removed, true); assert.equal(result.retained, true); assert.equal(result.record.state, "removed");
    assert.match(result.reason, /Generated branch moved/);
    assert.notEqual(execFileSync("git", ["-C", value.parent, "branch", "--list", branch], { encoding: "utf8" }).trim(), "");
  } finally { await value.dispose(); }
});

test("cleanup resumes after a crash once a write-ahead Herdr removal is proven complete", async () => {
  const value = await fixture();
  try {
    const branch = "herdr-subagents/run-1-cccccccccccc";
    execFileSync("git", ["-C", value.child, "branch", "-m", branch]);
    const record: WorktreeRecord = { ...value.record, branch, generatedBranch: true };
    const registry = newRegistry(); registry.register(record);
    const capture = await captureWriterArtifacts(value.capture); registry.setCapturedArtifacts(record.id, capture.references);
    const cleanup = new WorktreeCleanupManager(fakeHerdr(record, { gone: true }).client, registry);
    const integrated = await cleanup.verifyAndRecordIntegration(record.id, { kind: "no_changes" });
    const childHead = execFileSync("git", ["-C", value.child, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    registry.beginRemoval(record.id, false, childHead);
    execFileSync("git", ["-C", value.parent, "worktree", "remove", value.child]);
    const result = await cleanup.cleanup({ id: record.id, ownership: authorization(record), artifactCapture: value.capture, parentRoots: value.parentRoots });
    assert.equal(integrated.parentVerification.integration, "not_required");
    assert.equal(result.removed, true); assert.equal(result.retained, false);
    assert.equal(result.record.finalization?.branchDisposition, "deleted");
  } finally { await value.dispose(); }
});

test("crash recovery preserves the generated branch when current parent integration no longer proves the removed child", async () => {
  const value = await fixture();
  try {
    const branch = "herdr-subagents/run-1-eeeeeeeeeeee"; execFileSync("git", ["-C", value.child, "branch", "-m", branch]); await writeFile(join(value.child, "tracked.txt"), "child\n"); execFileSync("git", ["-C", value.child, "add", "tracked.txt"]); execFileSync("git", ["-C", value.child, "commit", "-qm", "child"]);
    const record: WorktreeRecord = { ...value.record, branch, generatedBranch: true }; const registry = newRegistry(); registry.register(record); const capture = await captureWriterArtifacts(value.capture); registry.setCapturedArtifacts(record.id, capture.references);
    execFileSync("git", ["-C", value.parent, "merge", "--no-edit", "--no-ff", branch], { stdio: "ignore" }); await new WorktreeCleanupManager(fakeHerdr(record).client, registry).verifyAndRecordIntegration(record.id, { kind: "commit_contained", parentCheckoutPath: value.parent });
    const childHead = execFileSync("git", ["-C", value.child, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); registry.beginRemoval(record.id, false, childHead); execFileSync("git", ["-C", value.parent, "worktree", "remove", value.child]); execFileSync("git", ["-C", value.parent, "reset", "--hard", record.base], { stdio: "ignore" });
    await assert.rejects(new WorktreeCleanupManager(fakeHerdr(record, { gone: true }).client, registry).cleanup({ id: record.id, ownership: authorization(record), artifactCapture: value.capture, parentRoots: value.parentRoots }), /no longer contains/);
    assert.notEqual(execFileSync("git", ["-C", value.parent, "branch", "--list", branch], { encoding: "utf8" }).trim(), "");
  } finally { await value.dispose(); }
});

test("safe removal captures the deterministic parent wrapper for a valid child handoff", async () => {
  const value = await fixture();
  try {
    await rm(value.handoff);
    await writeFile(value.childHandoff, "validated child result\n");
    const final = await materializeHandoff({ profile: childWriterProfile(), effectiveMutationCapable: true, handoffPath: value.childHandoff, roots: value.sourceRoots, assignment: "full delegated assignment", finalOutput: "unused for child writer" });
    assert.equal(final.path, value.handoff);
    assert.equal(final.writer, "parent-wrapper");
    const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1", "reviewed");
    const fake = fakeHerdr(value.record);
    const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
    assert.equal(result.removed, true);
    assert.match(String(result.record.capturedArtifacts.find((artifact) => artifact.kind === "handoff")?.absolutePath), /handoff-handoff\.parent\.md$/);
  } finally { await value.dispose(); }
});

test("invalid or missing child handoffs fail closed and block handoff materialization", async (t) => {
  for (const mode of ["invalid", "missing"] as const) await t.test(mode, async () => {
    const value = await fixture();
    try {
      await rm(value.handoff);
      if (mode === "invalid") await writeFile(value.childHandoff, " \n");
      if (mode === "missing") await rm(value.childHandoff, { force: true });
      await assert.rejects(
        materializeHandoff({
          profile: childWriterProfile(),
          effectiveMutationCapable: true,
          handoffPath: value.childHandoff,
          roots: value.sourceRoots,
          assignment: `full ${mode} assignment`,
          finalOutput: "must not substitute for child handoff",
        }),
        /Child handoff|not a regular file|ENOENT|must contain non-whitespace/i,
      );
    } finally { await value.dispose(); }
  });
});

test("remove_if_safe does not require configured optional progress evidence", async () => {
  const value = await fixture();
  try {
    await rm(value.capture.artifacts.find((artifact) => artifact.kind === "progress")!.sourcePath);
    const registry = newRegistry();
    registry.register(value.record);
    registry.setParentReviewed("run-1", "reviewed empty checkout");
    const fake = fakeHerdr(value.record);
    const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({
      id: "run-1",
      cleanup: "remove_if_safe",
      ownership: authorization(value.record),
      artifactCapture: value.capture,
      parentRoots: value.parentRoots,
      integrationEvidence: { kind: "no_changes" },
    });
    assert.equal(result.removed, true);
    assert.deepEqual(result.record.capturedArtifacts.map((artifact) => artifact.kind), ["handoff"]);
  } finally { await value.dispose(); }
});

test("dirty/unintegrated, unavailable Herdr, mismatched provenance, and active writer all retain without remove", async (t) => {
  await t.test("dirty and unintegrated", async () => {
    const value = await fixture(); try {
      await writeFile(join(value.child, "dirty.txt"), "unintegrated\n"); const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1"); const fake = fakeHerdr(value.record); const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
      assert.equal(result.retained, true); assert.match(result.reason, /checkout is dirty/); assert.match(result.record.retentionReason ?? "", /dirty/); assert.equal(fake.removeCalls, 0);
    } finally { await value.dispose(); }
  });
  await t.test("Herdr unavailable", async () => {
    const value = await fixture(); try { const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1"); const fake = fakeHerdr(value.record, { unavailable: true }); const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } }); assert.equal(result.retained, true); assert.match(result.reason, /unavailable/); assert.equal(fake.removeCalls, 0); } finally { await value.dispose(); }
  });
  await t.test("Herdr provenance mismatch", async () => {
    const value = await fixture(); try { const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1"); const fake = fakeHerdr(value.record, { mismatch: true }); const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } }); assert.equal(result.retained, true); assert.match(result.reason, /identity-match/); assert.equal(fake.removeCalls, 0); } finally { await value.dispose(); }
  });
  await t.test("active writer", async () => {
    const value = await fixture(); try {
      const writer = { terminalId: "term-writer", nativeSession: { kind: "id" as const, value: "native-writer", source: "herdr:pi" } }; const active = { ...value.record, state: "active" as const, writer };
      const writerPane = { ...pane, pane_id: "w2:p3", terminal_id: writer.terminalId, workspace_id: "w2", tab_id: "w2:t2", agent_session: { ...writer.nativeSession, agent: "pi" } };
      const registry = newRegistry(); registry.register(active); registry.setParentReviewed("run-1"); const fake = fakeHerdr(active, { writerPane }); const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(active), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } }); assert.equal(result.retained, true); assert.match(result.reason, /still live or uncertain/); assert.equal(fake.removeCalls, 0);
    } finally { await value.dispose(); }
  });
});

test("artifact capture is record/run/checkout bound and explicit supplemental files are optional", async (t) => {
  await t.test("optional explicit references are captured without becoming cleanup prerequisites", async () => {
    const value = await fixture(); try {
      const optionalRecord = { ...value.record, artifactPaths: value.record.artifactPaths.map((artifact) => ({ ...artifact, required: false })) };
      const optionalCapture = { ...value.capture, artifacts: value.capture.artifacts.map((artifact) => ({ ...artifact, required: false })) };
      const registry = newRegistry(); registry.register(optionalRecord); registry.setParentReviewed(optionalRecord.id); const fake = fakeHerdr(optionalRecord);
      const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: optionalRecord.id, cleanup: "remove_if_safe", ownership: authorization(optionalRecord), artifactCapture: optionalCapture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
      assert.equal(result.removed, true); assert.equal(result.record.capturedArtifacts.length, 2); assert.equal(fake.removeCalls, 1);
    } finally { await value.dispose(); }
  });
  await t.test("empty required files fail closed", async () => {
    const value = await fixture(); try {
      await Promise.all(value.capture.artifacts.map((artifact) => writeFile(artifact.sourcePath, " \n")));
      const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed(value.record.id); const fake = fakeHerdr(value.record);
      const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: value.record.id, cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
      assert.equal(result.retained, true); assert.match(result.reason, /required artifact is empty|required non-empty/i); assert.equal(fake.removeCalls, 0);
    } finally { await value.dispose(); }
  });
  await t.test("different run or source checkout cannot supply evidence", async () => {
    const value = await fixture(); try {
      const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed(value.record.id); const fake = fakeHerdr(value.record); const cleanup = new WorktreeCleanupManager(fake.client, registry);
      const wrongRun = await cleanup.cleanup({ id: value.record.id, cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: { ...value.capture, runId: "other-run" }, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
      assert.match(wrongRun.reason, /run id is not bound/); assert.equal(fake.removeCalls, 0);
    } finally { await value.dispose(); }
    const value2 = await fixture(); try {
      const registry = newRegistry(); registry.register(value2.record); registry.setParentReviewed(value2.record.id); const fake = fakeHerdr(value2.record);
      const wrongSource = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: value2.record.id, cleanup: "remove_if_safe", ownership: authorization(value2.record), artifactCapture: { ...value2.capture, sourceRoots: value2.parentRoots }, parentRoots: value2.parentRoots, integrationEvidence: { kind: "no_changes" } });
      assert.match(wrongSource.reason, /source checkout is not bound/); assert.equal(fake.removeCalls, 0);
    } finally { await value2.dispose(); }
  });
});

test("initial and group anchors retain when a current non-shell foreground process is active", async (t) => {
  for (const target of ["initial", "group"] as const) await t.test(target, async () => {
    const value = await fixture();
    try {
      const changedAnchor = target === "initial" ? value.record.createdRoot.rootPaneId : value.record.tab!.rootPaneId;
      const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed(value.record.id); const fake = fakeHerdr(value.record, { changedAnchor });
      const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: value.record.id, cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
      assert.equal(result.retained, true); assert.match(result.reason, /not a known idle shell/); assert.equal(fake.removeCalls, 0);
    } finally { await value.dispose(); }
  });
});

test("cleanup automatically derives direct containment and exact current-tree integration", async (t) => {
  for (const mode of ["contained", "tree"] as const) await t.test(mode, async () => {
    const value = await fixture();
    try {
      await writeFile(join(value.child, "tracked.txt"), `${mode}\n`); execFileSync("git", ["-C", value.child, "add", "tracked.txt"]); execFileSync("git", ["-C", value.child, "commit", "-qm", `${mode} child change`]);
      if (mode === "contained") execFileSync("git", ["-C", value.parent, "merge", "--no-edit", "--no-ff", "writer-branch"], { stdio: "ignore" });
      else {
        const tree = execFileSync("git", ["-C", value.child, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
        const parentHead = execFileSync("git", ["-C", value.parent, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const equivalent = execFileSync("git", ["-C", value.parent, "commit-tree", tree, "-p", parentHead, "-m", "equivalent parent tree"], { encoding: "utf8" }).trim();
        execFileSync("git", ["-C", value.parent, "reset", "--hard", equivalent], { stdio: "ignore" });
      }
      const registry = newRegistry(); registry.register(value.record); const fake = fakeHerdr(value.record);
      const result = await new WorktreeCleanupManager(fake.client, registry).cleanup({ id: value.record.id, ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots });
      assert.equal(result.removed, true); assert.equal(result.retained, false);
      assert.equal(result.record.parentVerification.integrationEvidence?.kind, mode === "contained" ? "commit_contained" : "tree_matches");
    } finally { await value.dispose(); }
  });
});

test("objective commit containment is derived from Git before integration becomes verified", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.child, "tracked.txt"), "child\n"); execFileSync("git", ["-C", value.child, "add", "tracked.txt"]); execFileSync("git", ["-C", value.child, "commit", "-qm", "child change"]);
    execFileSync("git", ["-C", value.parent, "merge", "--no-edit", "--no-ff", "writer-branch"], { stdio: "ignore" });
    const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1"); const cleanup = new WorktreeCleanupManager(fakeHerdr(value.record).client, registry);
    const integrated = await cleanup.verifyAndRecordIntegration("run-1", { kind: "commit_contained", parentCheckoutPath: value.parent });
    assert.equal(integrated.state, "integrated"); assert.equal(integrated.parentVerification.integration, "verified"); assert.equal(integrated.parentVerification.integrationEvidence?.kind, "commit_contained");
  } finally { await value.dispose(); }
});

test("saved integration evidence is revalidated against current child and parent state immediately before removal", async (t) => {
  async function integratedFixture() {
    const value = await fixture();
    await writeFile(join(value.child, "tracked.txt"), "child\n"); execFileSync("git", ["-C", value.child, "add", "tracked.txt"]); execFileSync("git", ["-C", value.child, "commit", "-qm", "child change"]);
    execFileSync("git", ["-C", value.parent, "merge", "--no-edit", "--no-ff", "writer-branch"], { stdio: "ignore" });
    const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed(value.record.id); const fake = fakeHerdr(value.record); const cleanup = new WorktreeCleanupManager(fake.client, registry);
    await cleanup.verifyAndRecordIntegration(value.record.id, { kind: "commit_contained", parentCheckoutPath: value.parent });
    return { value, registry, fake, cleanup };
  }
  await t.test("parent reset invalidates containment", async () => {
    const fixtureValue = await integratedFixture(); try {
      execFileSync("git", ["-C", fixtureValue.value.parent, "reset", "--hard", fixtureValue.value.record.base], { stdio: "ignore" });
      const result = await fixtureValue.cleanup.cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(fixtureValue.value.record), artifactCapture: fixtureValue.value.capture, parentRoots: fixtureValue.value.parentRoots });
      assert.equal(result.retained, true); assert.match(result.reason, /does not contain/); assert.equal(fixtureValue.fake.removeCalls, 0);
    } finally { await fixtureValue.value.dispose(); }
  });
  await t.test("child advance invalidates prior containment", async () => {
    const fixtureValue = await integratedFixture(); try {
      await writeFile(join(fixtureValue.value.child, "later.txt"), "later\n"); execFileSync("git", ["-C", fixtureValue.value.child, "add", "later.txt"]); execFileSync("git", ["-C", fixtureValue.value.child, "commit", "-qm", "later child change"]);
      const result = await fixtureValue.cleanup.cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(fixtureValue.value.record), artifactCapture: fixtureValue.value.capture, parentRoots: fixtureValue.value.parentRoots });
      assert.equal(result.retained, true); assert.match(result.reason, /does not contain/); assert.equal(fixtureValue.fake.removeCalls, 0);
    } finally { await fixtureValue.value.dispose(); }
  });
});

test("discard refuses forged/LLM-only assertions and force-removes only after interactive human confirmation", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.child, "dirty.txt"), "discard me\n"); const registry = newRegistry(); registry.register(value.record); const fake = fakeHerdr(value.record); const cleanup = new WorktreeCleanupManager(fake.client, registry);
    const forged = { decisionId: "fake", worktreeId: "run-1", runNonce: "nonce-1", workspaceId: "w2", checkoutPath: value.child, confirmedAt: Date.now(), consequences: [] } as HumanDiscardAuthorization;
    const refused = await cleanup.discardWithHumanConfirmation({ id: "run-1", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, authorization: forged });
    assert.equal(refused.retained, true); assert.equal(fake.removeCalls, 0);
    const cancelled = await requestHumanDiscardAuthorization({ record: refused.record, confirm: async () => false }); assert.equal(cancelled, undefined);
    let preview = ""; const approved = await requestHumanDiscardAuthorization({ record: refused.record, confirm: async (value) => { preview = value.consequences.join(" "); return true; } });
    assert.ok(approved); assert.match(preview, /permanently discarded/); assert.match(preview, /leave branch/);
    const removed = await cleanup.discardWithHumanConfirmation({ id: "run-1", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, authorization: approved! });
    assert.equal(removed.removed, true); assert.equal(fake.forceValue, true); assert.ok(removed.record.humanDiscard?.decisionId); assert.equal(execFileSync("git", ["-C", value.parent, "branch", "--list", "writer-branch"], { encoding: "utf8" }).trim().endsWith("writer-branch"), true);
  } finally { await value.dispose(); }
});

test("tampered active-branch ownership and stale captured artifacts fail closed", async () => {
  const value = await fixture();
  try {
    const registry = newRegistry(); registry.register(value.record); registry.setParentReviewed("run-1"); const fake = fakeHerdr(value.record); const cleanup = new WorktreeCleanupManager(fake.client, registry);
    await assert.rejects(cleanup.cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: { ...authorization(value.record), runNonce: "tampered" }, artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } }), /ownership proof/);
    const captured = await captureWriterArtifacts(value.capture); assert.equal(captured.verifiedForRemoval, true); registry.setCapturedArtifacts("run-1", captured.references);
    await writeFile(captured.references[0]!.absolutePath, "tampered after verified capture\n");
    const result = await cleanup.cleanup({ id: "run-1", cleanup: "remove_if_safe", ownership: authorization(value.record), artifactCapture: value.capture, parentRoots: value.parentRoots, integrationEvidence: { kind: "no_changes" } });
    assert.equal(result.retained, true); assert.match(result.reason, /no longer matches/); assert.equal(fake.removeCalls, 0);
  } finally { await value.dispose(); }
});
