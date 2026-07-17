import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActionFacts } from "../results/action-notices.ts";
import type { WorktreeRecord } from "./contracts.ts";
import { identifyCheckout } from "./writer-locks.ts";

const execFileAsync = promisify(execFile);

async function git(checkout: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 1_000_000 });
  return result.stdout.trim();
}

export interface WorktreeInspection extends ActionFacts {
  readonly checkoutPath: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly clean: boolean;
  readonly commitsAhead: number;
  readonly noChanges: boolean;
  readonly parentCheckoutPath: string;
  readonly workspaceId: string;
}

export async function inspectWriterWorktree(record: WorktreeRecord): Promise<WorktreeInspection> {
  const identity = await identifyCheckout(record.checkoutPath);
  if (identity.repositoryId !== record.repositoryId || identity.commonGitDir !== record.commonGitDir || identity.checkoutPath !== record.checkoutPath) {
    throw new Error("Writer checkout identity no longer matches its durable worktree record");
  }
  const [head, status, commitsAhead] = await Promise.all([
    git(record.checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(record.checkoutPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(record.checkoutPath, ["rev-list", "--count", `${record.base}..HEAD`]),
  ]);
  const count = Number(commitsAhead);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Writer commits-ahead count is malformed");
  const clean = status.length === 0;
  return {
    checkoutPath: record.checkoutPath,
    branch: record.branch,
    base: record.base,
    head,
    clean,
    commitsAhead: count,
    noChanges: clean && head === record.base,
    parentCheckoutPath: record.sourceCheckoutPath,
    workspaceId: record.workspaceId,
    ...(record.tab === undefined ? {} : { tabId: record.tab.tabId }),
    ...(record.writer === undefined ? {} : { terminalId: record.writer.terminalId }),
  };
}
