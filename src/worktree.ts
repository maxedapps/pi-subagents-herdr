import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, normalize, resolve } from "node:path";
import { HerdrError, type HerdrClient } from "./herdr.ts";

const execFileAsync = promisify(execFile);

export interface WorktreeFacts {
  workspaceId: string;
  path: string;
  branch: string;
}

export interface WorkerTopology {
  worktree: WorktreeFacts;
  tabId: string;
  rootPaneId: string;
}

export async function createWorkerWorktree(
  client: HerdrClient,
  parentWorkspaceId: string,
  parentCwd: string,
  runId: string,
  parentSessionId: string,
  signal?: AbortSignal,
): Promise<WorkerTopology> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: parentCwd,
    encoding: "utf8",
    signal,
  });
  const checkoutRoot = stdout.trim();
  if (!checkoutRoot) throw new Error("Unable to resolve the parent Git checkout root");
  const source = await client.getWorktreeSource({ workspace_id: parentWorkspaceId }, signal);
  const [canonicalCheckoutRoot, canonicalWorkspaceCheckout] = await Promise.all([
    realpath(checkoutRoot),
    realpath(source.sourceCheckoutPath),
  ]);
  if (canonicalCheckoutRoot !== canonicalWorkspaceCheckout) {
    throw new Error(
      `Parent Pi checkout ${canonicalCheckoutRoot} does not match Herdr workspace ${parentWorkspaceId} checkout ${canonicalWorkspaceCheckout}. Start Pi in a Herdr workspace for the intended repository.`,
    );
  }
  const path = resolve(join(dirname(canonicalCheckoutRoot), ".herdr-subagents-worktrees", runId));
  const branch = `herdr-subagents/${runId}`;
  await mkdir(dirname(path), { recursive: true });
  const created = await client.createWorktree({
    cwd: canonicalCheckoutRoot,
    branch,
    base: "HEAD",
    path,
    label: `subagent:${parentSessionId.slice(0, 8)}:${runId}`,
    focus: false,
  }, signal);
  return {
    worktree: { workspaceId: created.workspaceId, path: created.path, branch: created.branch },
    tabId: created.tabId,
    rootPaneId: created.rootPaneId,
  };
}

export type GitStatus = (cwd: string, signal?: AbortSignal) => Promise<string>;

export async function readGitStatus(cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", signal });
  return stdout;
}

export type WorkerCleanup =
  | { action: "removed" | "finalized" | "already-finalized"; removed: true; branch: string }
  | { action: "retained"; removed: false; branch: string; path: string; reason: string };

function retained(worktree: WorktreeFacts, reason: string): WorkerCleanup {
  return { action: "retained", removed: false, branch: worktree.branch, path: worktree.path, reason };
}

async function checkoutIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function finalizeAbsentWorker(
  client: HerdrClient,
  worktree: WorktreeFacts,
  signal?: AbortSignal,
): Promise<WorkerCleanup> {
  let workspace;
  try {
    workspace = await client.getWorkspace(worktree.workspaceId, signal);
  } catch (error) {
    if (error instanceof HerdrError && error.code === "workspace_not_found") {
      return { action: "already-finalized", removed: true, branch: worktree.branch };
    }
    return retained(worktree, `workspace.get failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    workspace.workspaceId !== worktree.workspaceId
    || workspace.worktree === null
    || normalize(workspace.worktree.checkoutPath) !== normalize(worktree.path)
    || workspace.worktree.isLinkedWorktree !== true
  ) {
    return retained(worktree, "workspace lookup did not exactly match the linked worker worktree");
  }
  try {
    await client.closeWorkspace(worktree.workspaceId, signal);
    return { action: "finalized", removed: true, branch: worktree.branch };
  } catch (error) {
    return retained(worktree, `workspace.close failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function cleanupWorkerWorktree(
  client: HerdrClient,
  worktree: WorktreeFacts,
  signal?: AbortSignal,
  gitStatus: GitStatus = readGitStatus,
): Promise<WorkerCleanup> {
  let porcelain: string;
  try {
    porcelain = await gitStatus(worktree.path, signal);
  } catch (error) {
    try {
      if (await checkoutIsAbsent(worktree.path)) return finalizeAbsentWorker(client, worktree, signal);
    } catch (pathError) {
      return retained(worktree, `checkout path check failed: ${pathError instanceof Error ? pathError.message : String(pathError)}`);
    }
    return retained(worktree, `git status failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (porcelain.trim()) return retained(worktree, "worktree is dirty");
  try {
    await client.removeWorktree(worktree.workspaceId, signal);
    return { action: "removed", removed: true, branch: worktree.branch };
  } catch (error) {
    return retained(worktree, `worktree.remove failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
