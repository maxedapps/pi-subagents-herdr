import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureRuntimeGitExcludes, PROGRESS_EXCLUDE_RULE, SUBAGENTS_EXCLUDE_RULE } from "../../src/artifacts/git-ignore.ts";
import { strictTsxArgs } from "../support/strict-node.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}

async function repository(prefix = "pi-herdr-git-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "tests@example.invalid");
  await git(root, "config", "user.name", "Tests");
  await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  await git(root, "add", ".gitignore", "README.md");
  await git(root, "commit", "-qm", "fixture");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function excludePath(root: string): Promise<string> {
  const raw = await git(root, "rev-parse", "--git-path", "info/exclude");
  return resolve(root, raw);
}

test("Git ignore protection appends anchored local rules without changing tracked .gitignore and warns for tracked runtime files", async () => {
  const fx = await repository();
  try {
    await mkdir(join(fx.root, ".subagents"));
    await writeFile(join(fx.root, ".subagents", "tracked.md"), "tracked", "utf8");
    await git(fx.root, "add", "-f", ".subagents/tracked.md");
    await git(fx.root, "commit", "-qm", "tracked runtime fixture");
    const before = await readFile(join(fx.root, ".gitignore"));
    const report = await ensureRuntimeGitExcludes({ checkout: fx.root });
    assert.equal(report.applicable, true);
    assert.equal(report.protected, true);
    assert.deepEqual(report.appliedRules, [SUBAGENTS_EXCLUDE_RULE]);
    assert.equal(report.diagnostics.some((item) => item.code === "runtime-paths-already-tracked"), true);
    assert.deepEqual(await readFile(join(fx.root, ".gitignore")), before);
    const exclude = await readFile(await excludePath(fx.root), "utf8");
    assert.match(exclude, /^|\n\/\.subagents\/\n/);
    assert.equal((exclude.match(/^\/\.subagents\/$/gm) ?? []).length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("pre-existing untracked .progress is not hidden without confirmation", async () => {
  const fx = await repository();
  try {
    await mkdir(join(fx.root, ".progress"));
    await writeFile(join(fx.root, ".progress", "user-notes.md"), "do not hide silently", "utf8");
    const denied = await ensureRuntimeGitExcludes({ checkout: fx.root, requestProgress: true });
    assert.equal(denied.protected, false);
    assert.equal(denied.diagnostics.some((item) => item.code === "progress-ignore-confirmation-required"), true);
    assert.equal((await readFile(await excludePath(fx.root), "utf8")).includes(PROGRESS_EXCLUDE_RULE), false);

    const confirmed = await ensureRuntimeGitExcludes({
      checkout: fx.root,
      requestProgress: true,
      confirmIgnoreExistingProgress: true,
    });
    assert.equal(confirmed.protected, true);
    const exclude = await readFile(await excludePath(fx.root), "utf8");
    assert.equal((exclude.match(/^\/\.progress\/$/gm) ?? []).length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("cross-process lock prevents duplicate or torn exclude rules", async () => {
  const fx = await repository();
  try {
    const helper = resolve("tests/support/git-ignore-child.ts");
    await Promise.all(Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      strictTsxArgs(helper, fx.root),
      { cwd: process.cwd(), timeout: 30_000 },
    )));
    const exclude = await readFile(await excludePath(fx.root), "utf8");
    assert.equal((exclude.match(/^\/\.subagents\/$/gm) ?? []).length, 1);
    assert.equal(exclude.includes("undefined"), false);
  } finally {
    await fx.cleanup();
  }
});

test("nested Git roots and linked worktrees use Git-reported real roots/info-exclude paths", async () => {
  const outer = await repository("pi-herdr-outer-");
  const nestedRoot = join(outer.root, "nested");
  await mkdir(nestedRoot);
  await git(nestedRoot, "init", "-q");
  await git(nestedRoot, "config", "user.email", "tests@example.invalid");
  await git(nestedRoot, "config", "user.name", "Tests");
  await writeFile(join(nestedRoot, "file"), "nested", "utf8");
  await git(nestedRoot, "add", "file");
  await git(nestedRoot, "commit", "-qm", "nested");
  const linked = join(outer.root, "..", `${outer.root.split("/").at(-1)}-linked`);
  try {
    const nested = await ensureRuntimeGitExcludes({ checkout: nestedRoot });
    assert.equal(nested.gitRoot, await git(nestedRoot, "rev-parse", "--show-toplevel"));
    assert.notEqual(nested.excludePath, await excludePath(outer.root));

    await git(outer.root, "worktree", "add", "-q", "-b", "linked-test", linked);
    const linkedReport = await ensureRuntimeGitExcludes({ checkout: linked });
    assert.equal(linkedReport.protected, true);
    assert.equal(linkedReport.excludePath, resolve(linked, await git(linked, "rev-parse", "--git-path", "info/exclude")));
    assert.equal(await git(linked, "check-ignore", "--no-index", ".subagents/probe"), ".subagents/probe");
  } finally {
    await rm(linked, { recursive: true, force: true });
    await outer.cleanup();
  }
});

test("repository-subdirectory checkouts fail closed instead of reporting protection for the wrong root", async () => {
  const fx = await repository();
  const checkout = join(fx.root, "packages", "child");
  await mkdir(checkout, { recursive: true });
  try {
    const before = await readFile(await excludePath(fx.root), "utf8");
    await assert.rejects(
      ensureRuntimeGitExcludes({ checkout }),
      /checkout must be the repository\/worktree root/,
    );
    assert.equal(await readFile(await excludePath(fx.root), "utf8"), before);
  } finally {
    await fx.cleanup();
  }
});

test("non-Git directories succeed with a truthful not-applicable diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-nongit-"));
  try {
    const report = await ensureRuntimeGitExcludes({ checkout: root });
    assert.equal(report.applicable, false);
    assert.equal(report.protected, false);
    assert.equal(report.diagnostics[0]?.code, "git-ignore-not-applicable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
