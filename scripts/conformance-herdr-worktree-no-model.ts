#!/usr/bin/env -S node --throw-deprecation --import tsx
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { HerdrClient } from "../src/herdr/client.ts";
import { HerdrNdjsonTransport } from "../src/herdr/transport.ts";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run conformance:herdr:worktree:no-model -- --confirm-create [--source-workspace ID | --source-cwd ABSOLUTE_PATH]");
  console.log("Without --confirm-create this command is a no-side-effect dry run. It never starts a model and never deletes a branch.");
  process.exit(0);
}
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
const confirmed = args.includes("--confirm-create");
const workspaceId = option("--source-workspace") ?? (option("--source-cwd") === undefined ? process.env.HERDR_WORKSPACE_ID : undefined);
const cwd = option("--source-cwd");
if (Number(workspaceId !== undefined) + Number(cwd !== undefined) !== 1) throw new Error("Select exactly one explicit source workspace or absolute cwd");
const selector = workspaceId === undefined ? { cwd: cwd! } : { workspace_id: workspaceId };
if (!confirmed) {
  console.log(JSON.stringify({ ok: true, dry_run: true, no_model: true, source: selector, would_create_focus: false, branch_deletion: false, instruction: "Re-run with --confirm-create to create and safely remove one empty disposable Herdr worktree" }, null, 2));
  process.exit(0);
}
if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) throw new Error("Confirmed conformance must run inside Herdr with HERDR_ENV=1 and HERDR_SOCKET_PATH");
const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: process.env.HERDR_SOCKET_PATH, connectTimeoutMs: 2_000, responseTimeoutMs: 8_000 }));
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const branch = `herdr-subagents/conformance-${suffix}`;
const path = join(tmpdir(), `pi-herdr-worktree-conformance-${suffix}`);
const report: Record<string, unknown> = { started_at: new Date().toISOString(), no_model: true, source: selector, requested: { branch, path, focus: false }, created: [], closed: [], retained: [], checks: [] };
let created: Awaited<ReturnType<HerdrClient["createWorktree"]>> | undefined;
let group: Awaited<ReturnType<HerdrClient["createTab"]>> | undefined;
async function git(checkout: string, values: readonly string[]): Promise<string> { return (await execFileAsync("git", ["-C", checkout, ...values], { encoding: "utf8", maxBuffer: 1_000_000 })).stdout.trim(); }
async function safeRemove(): Promise<void> {
  if (!created) return;
  try {
    const canonical = await realpath(created.worktree.path);
    const listed = await client.listWorktrees({ cwd: (report.source_checkout_path as string) });
    const match = listed.worktrees.find((candidate) => candidate.open_workspace_id === created!.workspace.workspace_id && candidate.branch === branch && candidate.path === canonical);
    const [workspace, snapshot] = await Promise.all([client.getWorkspace(created.workspace.workspace_id), client.snapshot()]);
    const clean = await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const allowedTerminals = new Set([created.rootPane.terminal_id, ...(group ? [group.rootPane.terminal_id] : [])]);
    const unknownPanes = snapshot.panes.filter((pane) => pane.workspace_id === created!.workspace.workspace_id && !allowedTerminals.has(pane.terminal_id));
    const liveAgents = snapshot.agents.filter((agent) => agent.workspace_id === created!.workspace.workspace_id);
    if (!match || workspace.worktree?.checkout_path !== canonical || workspace.worktree.repo_key !== listed.source.repo_key || clean !== "" || unknownPanes.length !== 0 || liveAgents.length !== 0) throw new Error("live Herdr/Git identity, empty-workspace, or clean-checkout proof failed");
    const removed = await client.removeWorktree(created.workspace.workspace_id, false);
    if (removed.workspaceId !== created.workspace.workspace_id || removed.path !== canonical || removed.forced) throw new Error("non-force removal response did not match created identity");
    (report.closed as unknown[]).push({ workspace_id: removed.workspaceId, path: removed.path, forced: removed.forced });
    const branchStillExists = (await git(listed.source.source_checkout_path, ["branch", "--list", branch])).endsWith(branch);
    if (!branchStillExists) throw new Error("Herdr removal unexpectedly deleted the branch");
    (report.checks as unknown[]).push({ branch_retained: branch, safe_non_force_removal: true });
  } catch (error) {
    (report.retained as unknown[]).push({ workspace_id: created.workspace.workspace_id, path: created.worktree.path, branch, reason: error instanceof Error ? error.message : String(error) });
  }
}
try {
  await access(path).then(() => { throw new Error(`Refusing existing conformance path ${path}`); }, () => undefined);
  const ping = await client.assertCompatible(); (report.checks as unknown[]).push({ ping });
  const listed = await client.listWorktrees(selector); report.source_checkout_path = listed.source.source_checkout_path;
  const base = await git(listed.source.source_checkout_path, ["rev-parse", "--verify", "HEAD^{commit}"]); report.requested = { branch, base, path, focus: false };
  created = await client.createWorktree({ ...selector, branch, base, path, label: `no-model-conformance:${suffix}`, focus: false });
  (report.created as unknown[]).push({ workspace_id: created.workspace.workspace_id, tab_id: created.tab.tab_id, root_pane_id: created.rootPane.pane_id, root_terminal_id: created.rootPane.terminal_id, path: created.worktree.path, branch: created.worktree.branch });
  if (created.workspace.focused || created.tab.focused || created.rootPane.focused || created.worktree.branch !== branch || !created.worktree.is_linked_worktree) throw new Error("Created worktree focus/provenance did not match the request");
  group = await client.createTab({ workspace_id: created.workspace.workspace_id, label: `no-model-group:${suffix}`, focus: false });
  (report.created as unknown[]).push({ group_tab_id: group.tab.tab_id, root_pane_id: group.rootPane.pane_id, root_terminal_id: group.rootPane.terminal_id });
  if (group.tab.focused || group.rootPane.focused) throw new Error("Dedicated group tab unexpectedly took focus");
  (report.checks as unknown[]).push({ no_focus_workspace: true, returned_provenance_recorded: true, dedicated_group_tab: true });
  await safeRemove(); report.ok = (report.retained as unknown[]).length === 0;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); await safeRemove(); report.ok = false;
} finally { report.finished_at = new Date().toISOString(); }
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
