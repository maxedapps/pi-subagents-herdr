import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Diagnostic } from "../contracts/result.ts";

export const SUBAGENTS_EXCLUDE_RULE = "/.subagents/";
export const PROGRESS_EXCLUDE_RULE = "/.progress/";

export interface EnsureGitIgnoreOptions {
  readonly checkout: string;
  readonly requestProgress?: boolean;
  readonly confirmIgnoreExistingProgress?: boolean;
  readonly lockTimeoutMs?: number;
}

export interface GitIgnoreReport {
  readonly applicable: boolean;
  readonly protected: boolean;
  readonly gitRoot?: string;
  readonly excludePath?: string;
  readonly appliedRules: readonly string[];
  readonly existingRules: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => fulfill({ code: code ?? 1, stdout, stderr }));
  });
}

async function git(checkout: string, args: readonly string[], allowedCodes: readonly number[] = [0]): Promise<CommandResult> {
  const result = await run("git", ["-C", checkout, ...args], checkout);
  if (!allowedCodes.includes(result.code)) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireLock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring Git exclude lock: ${path}`);
      await new Promise((fulfill) => setTimeout(fulfill, 15 + Math.floor(Math.random() * 20)));
    }
  }
}

async function isIgnored(gitRoot: string, relativeProbe: string): Promise<boolean> {
  const result = await git(gitRoot, ["check-ignore", "--no-index", "-q", "--", relativeProbe], [0, 1]);
  return result.code === 0;
}

async function trackedPaths(gitRoot: string, requestProgress: boolean): Promise<string[]> {
  const paths = [".subagents", ...(requestProgress ? [".progress"] : [])];
  const result = await git(gitRoot, ["ls-files", "--", ...paths]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function hasUntrackedProgress(gitRoot: string): Promise<boolean> {
  const result = await git(gitRoot, ["ls-files", "--others", "--exclude-standard", "--", ".progress"]);
  return result.stdout.trim().length > 0;
}

async function appendRulesAtomically(excludePath: string, rules: readonly string[]): Promise<void> {
  if (rules.length === 0) return;
  const info = await lstat(dirname(excludePath));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Git info directory is unsafe: ${dirname(excludePath)}`);
  if (await exists(excludePath)) {
    const excludeInfo = await lstat(excludePath);
    if (!excludeInfo.isFile() || excludeInfo.isSymbolicLink()) throw new Error(`Git exclude path is not a regular file: ${excludePath}`);
  }
  const current = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const addition = `${prefix}${rules.join("\n")}\n`;
  const handle = await open(excludePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    // One append write while holding the cross-process lock prevents torn or
    // interleaved extension updates without rewriting user-owned content.
    await handle.write(addition);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureRuntimeGitExcludes(options: EnsureGitIgnoreOptions): Promise<GitIgnoreReport> {
  const checkout = await realpath(resolve(options.checkout));
  const probe = await git(checkout, ["rev-parse", "--show-toplevel"], [0, 128]);
  if (probe.code !== 0) {
    return {
      applicable: false,
      protected: false,
      appliedRules: [],
      existingRules: [],
      diagnostics: [{
        code: "git-ignore-not-applicable",
        message: `Runtime artifacts can be created, but Git-ignore protection is not applicable because ${checkout} is not Git-backed`,
        path: checkout,
        severity: "info",
      }],
    };
  }
  const gitRoot = await realpath(probe.stdout.trim());
  if (checkout !== gitRoot) {
    throw new Error(
      `Git-backed artifact checkout must be the repository/worktree root so anchored runtime excludes protect the actual checkout: ${checkout} (root: ${gitRoot})`,
    );
  }
  const gitPathResult = await git(gitRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const rawExcludePath = gitPathResult.stdout.trim();
  const excludePath = resolve(gitRoot, isAbsolute(rawExcludePath) ? rawExcludePath : rawExcludePath);
  const diagnostics: Diagnostic[] = [];
  const tracked = await trackedPaths(gitRoot, options.requestProgress === true);
  if (tracked.length > 0) {
    diagnostics.push({
      code: "runtime-paths-already-tracked",
      message: `Runtime path contains tracked files that local excludes cannot hide: ${tracked.join(", ")}`,
      path: gitRoot,
      severity: "warning",
    });
  }

  const lockPath = `${excludePath}.herdr-subagents.lock`;
  const release = await acquireLock(lockPath, options.lockTimeoutMs ?? 10_000);
  const appliedRules: string[] = [];
  const existingRules: string[] = [];
  try {
    if (await isIgnored(gitRoot, ".subagents/.pi-herdr-ignore-probe")) existingRules.push(SUBAGENTS_EXCLUDE_RULE);
    else appliedRules.push(SUBAGENTS_EXCLUDE_RULE);

    if (options.requestProgress === true) {
      if (await isIgnored(gitRoot, ".progress/.pi-herdr-ignore-probe")) {
        existingRules.push(PROGRESS_EXCLUDE_RULE);
      } else {
        const progressExists = await exists(resolve(gitRoot, ".progress"));
        const untrackedProgress = progressExists && await hasUntrackedProgress(gitRoot);
        if (untrackedProgress && options.confirmIgnoreExistingProgress !== true) {
          diagnostics.push({
            code: "progress-ignore-confirmation-required",
            message: "Did not add /.progress/: a pre-existing untracked .progress tree requires explicit confirmation before it is hidden wholesale",
            path: resolve(gitRoot, ".progress"),
            severity: "warning",
          });
        } else {
          appliedRules.push(PROGRESS_EXCLUDE_RULE);
        }
      }
    }
    await appendRulesAtomically(excludePath, appliedRules);
  } finally {
    await release();
  }

  const subagentsProtected = await isIgnored(gitRoot, ".subagents/.pi-herdr-ignore-probe");
  const progressProtected = options.requestProgress !== true || await isIgnored(gitRoot, ".progress/.pi-herdr-ignore-probe");
  if (!subagentsProtected || !progressProtected) {
    diagnostics.push({
      code: "git-ignore-protection-incomplete",
      message: "Runtime artifact Git-ignore protection is incomplete; launch may continue only with this diagnostic surfaced",
      path: excludePath,
      severity: "warning",
    });
  }
  const excludeParent = await stat(dirname(excludePath));
  if (!excludeParent.isDirectory()) throw new Error(`Invalid Git exclude parent: ${dirname(excludePath)}`);
  return {
    applicable: true,
    protected: subagentsProtected && progressProtected,
    gitRoot,
    excludePath,
    appliedRules,
    existingRules,
    diagnostics,
  };
}
