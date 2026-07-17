#!/usr/bin/env -S node --throw-deprecation --import tsx
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { purgeRuntimeRunArtifacts } from "../src/artifacts/purge.ts";
import { resolveArtifactRoots } from "../src/artifacts/paths.ts";
import { HerdrClient } from "../src/herdr/client.ts";
import { HerdrNdjsonTransport } from "../src/herdr/transport.ts";
import { DelegationGroupManager } from "../src/runtime/groups.ts";
import { WorktreeCleanupManager } from "../src/worktrees/cleanup.ts";
import { WorktreeManager, WorktreeRegistry } from "../src/worktrees/manager.ts";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run conformance:herdr:worktree:no-model -- --confirm-create [--source-workspace ID | --source-cwd ABSOLUTE_PATH]");
  console.log("Without --confirm-create this command is a no-side-effect dry run. It never starts a model and finalization deletes only its exact generated branch.");
  process.exit(0);
}
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
const confirmed = args.includes("--confirm-create");
const workspaceId = option("--source-workspace") ?? (option("--source-cwd") === undefined ? process.env.HERDR_WORKSPACE_ID : undefined);
const cwd = option("--source-cwd");
if (Number(workspaceId !== undefined) + Number(cwd !== undefined) !== 1) throw new Error("Select exactly one explicit source workspace or absolute cwd");
const selector = workspaceId === undefined ? { cwd: cwd! } : { workspace_id: workspaceId };
if (!confirmed) {
  console.log(JSON.stringify({ ok: true, dry_run: true, no_model: true, source: selector, would_create_focus: false, branch_deletion: true, instruction: "Re-run with --confirm-create to create and fully finalize one empty disposable Herdr worktree" }, null, 2));
  process.exit(0);
}
if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) throw new Error("Confirmed conformance must run inside Herdr with HERDR_ENV=1 and HERDR_SOCKET_PATH");

const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: process.env.HERDR_SOCKET_PATH, connectTimeoutMs: 2_000, responseTimeoutMs: 8_000 }));
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const runId = `conformance-${suffix}`;
const requestedPath = join(tmpdir(), `pi-herdr-worktree-conformance-${suffix}`);
const report: Record<string, unknown> = { started_at: new Date().toISOString(), no_model: true, source: selector, requested: { run_id: runId, path: requestedPath, focus: false }, created: [], finalized: [], retained: [], checks: [] };
const registry = new WorktreeRegistry({ appendEntry() {} });
const manager = new WorktreeManager(client, new DelegationGroupManager(client), registry);
const cleanup = new WorktreeCleanupManager(client, registry);
let sourceCheckout = "";
let childHead: string | undefined;

async function git(checkout: string, values: readonly string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", checkout, ...values], { encoding: "utf8", maxBuffer: 1_000_000 })).stdout.trim();
}
async function refExists(branch: string): Promise<boolean> {
  try { await git(sourceCheckout, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); return true; }
  catch { return false; }
}
async function emergencyCleanup(): Promise<void> {
  const record = registry.get(runId);
  if (!record || !sourceCheckout) return;
  try {
    const listed = await client.listWorktrees({ cwd: sourceCheckout });
    const live = listed.worktrees.find((candidate) => candidate.path === record.checkoutPath && candidate.branch === record.branch && candidate.open_workspace_id === record.workspaceId);
    if (live) {
      const clean = await git(record.checkoutPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (clean !== "") throw new Error("emergency cleanup refused a dirty checkout");
      const removed = await client.removeWorktree(record.workspaceId, false);
      if (removed.workspaceId !== record.workspaceId || removed.path !== record.checkoutPath || removed.forced) throw new Error("emergency non-force removal identity mismatch");
    }
    if (record.generatedBranch && childHead && await refExists(record.branch)) {
      const current = await git(sourceCheckout, ["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`]);
      if (current !== childHead) throw new Error("emergency branch compare-delete refused a moved ref");
      await git(sourceCheckout, ["update-ref", "-d", `refs/heads/${record.branch}`, childHead]);
    }
  } catch (error) {
    (report.retained as unknown[]).push({ workspace_id: record.workspaceId, path: record.checkoutPath, branch: record.branch, reason: error instanceof Error ? error.message : String(error) });
  }
}

try {
  await access(requestedPath).then(() => { throw new Error(`Refusing existing conformance path ${requestedPath}`); }, () => undefined);
  const ping = await client.assertCompatible(); (report.checks as unknown[]).push({ ping });
  const listed = await client.listWorktrees(selector); sourceCheckout = listed.source.source_checkout_path;
  const record = await manager.createForWriter({
    id: runId,
    owner: { runId, runNonce: `nonce-${suffix}`, parent: { sessionId: `conformance-${suffix}`, branchEntryId: `conformance-entry-${suffix}` } },
    source: selector,
    group: "default",
    path: requestedPath,
    artifacts: [],
    label: `no-model-conformance:${suffix}`,
  });
  childHead = await git(record.checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  (report.created as unknown[]).push({ workspace_id: record.workspaceId, path: record.checkoutPath, branch: record.branch, tab_ids: [record.createdRoot.tabId, record.tab?.tabId].filter(Boolean) });
  const parentRoots = await resolveArtifactRoots({ checkout: sourceCheckout, allowProgress: false });
  const sourceRoots = await resolveArtifactRoots({ checkout: record.checkoutPath, allowProgress: false });
  const finalized = await cleanup.cleanup({
    id: runId,
    ownership: { runId, runNonce: record.owner.runNonce, parent: record.owner.parent, activeBranchState: "owned" },
    artifactCapture: { artifacts: [], sourceRoots, parentRoots, runId },
    parentRoots,
    resultEvidencePersisted: true,
  });
  if (!finalized.removed || finalized.retained || finalized.record.finalization?.branchDisposition !== "deleted") throw new Error(`Production finalizer retained the conformance worktree: ${finalized.reason}`);
  const purge = await purgeRuntimeRunArtifacts(parentRoots, runId);
  registry.markRuntimeArtifactsPurged(runId);
  (report.finalized as unknown[]).push({ reason: finalized.reason, branch: finalized.record.branch, purge });

  const [afterWorktrees, afterSnapshot] = await Promise.all([client.listWorktrees({ cwd: sourceCheckout }), client.snapshot()]);
  const residue = {
    workspace: afterSnapshot.workspaces.some((item) => item.workspace_id === record.workspaceId),
    tabs: afterSnapshot.tabs.filter((item) => item.workspace_id === record.workspaceId).length,
    panes: afterSnapshot.panes.filter((item) => item.workspace_id === record.workspaceId).length,
    agents: afterSnapshot.agents.filter((item) => item.workspace_id === record.workspaceId).length,
    worktree: afterWorktrees.worktrees.some((item) => item.path === record.checkoutPath),
    branch: await refExists(record.branch),
    path: await access(record.checkoutPath).then(() => true, () => false),
    run_artifacts: await access(join(sourceCheckout, ".subagents", "runs", runId)).then(() => true, () => false),
  };
  (report.checks as unknown[]).push({ zero_residue: residue });
  if (Object.values(residue).some((value) => typeof value === "boolean" ? value : value !== 0)) throw new Error(`Conformance residue remains: ${JSON.stringify(residue)}`);
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await emergencyCleanup();
  report.ok = false;
} finally { report.finished_at = new Date().toISOString(); }
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
