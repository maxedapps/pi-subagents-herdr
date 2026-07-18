import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import type { HerdrClient } from "./herdr.ts";

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
  signal?: AbortSignal,
): Promise<WorkerTopology> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: parentCwd,
    encoding: "utf8",
    signal,
  });
  const checkoutRoot = stdout.trim();
  if (!checkoutRoot) throw new Error("Unable to resolve the parent Git checkout root");
  const path = resolve(join(dirname(checkoutRoot), ".herdr-subagents-worktrees", runId));
  const branch = `herdr-subagents/${runId}`;
  await mkdir(dirname(path), { recursive: true });
  const created = await client.createWorktree({
    workspace_id: parentWorkspaceId,
    branch,
    base: "HEAD",
    path,
    label: `subagent:${runId}`,
    focus: false,
  }, signal);
  return {
    worktree: { workspaceId: created.workspaceId, path: created.path, branch: created.branch },
    tabId: created.tabId,
    rootPaneId: created.rootPaneId,
  };
}

export type GitStatus = (cwd: string) => Promise<string>;

export async function readGitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return stdout;
}

export type WorkerCleanup =
  | { removed: true; branch: string }
  | { removed: false; branch: string; path: string; reason: string };

export async function cleanupWorkerWorktree(
  client: HerdrClient,
  worktree: WorktreeFacts,
  signal?: AbortSignal,
  gitStatus: GitStatus = readGitStatus,
): Promise<WorkerCleanup> {
  let porcelain: string;
  try {
    porcelain = await gitStatus(worktree.path);
  } catch (error) {
    return {
      removed: false,
      branch: worktree.branch,
      path: worktree.path,
      reason: `git status failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (porcelain.trim()) {
    return { removed: false, branch: worktree.branch, path: worktree.path, reason: "worktree is dirty" };
  }
  try {
    await client.removeWorktree(worktree.workspaceId, signal);
    return { removed: true, branch: worktree.branch };
  } catch (error) {
    return {
      removed: false,
      branch: worktree.branch,
      path: worktree.path,
      reason: `worktree.remove failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
