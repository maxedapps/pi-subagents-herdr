import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import {
  captureWorktreeArtifactsBeforeRemoval,
  materializeHandoff,
  parentHandoffWrapperPath,
  resolveArtifactWriter,
} from "../../src/artifacts/handoff.ts";
import { resolveArtifactPath, resolveArtifactRoots } from "../../src/artifacts/paths.ts";
import { writeArtifactAtomic } from "../../src/artifacts/store.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}

function profile(permission: "read-only" | "write", writer?: "parent" | "child"): AgentProfile {
  return {
    name: permission === "write" ? "worker" : "scout",
    description: "Fixture",
    body: "Fixture body",
    permissions: permission,
    ...(writer === undefined ? {} : { artifacts: { writer } }),
    source: { path: "/profiles/fixture.md", scope: "user", namespace: "shared", priority: 1 },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-handoff-"));
  const parent = join(root, "parent");
  const worktree = join(root, "worktree");
  await mkdir(parent);
  await mkdir(worktree);
  return {
    root,
    parent,
    worktree,
    parentRoots: await resolveArtifactRoots({ checkout: parent, allowProgress: false }),
    worktreeRoots: await resolveArtifactRoots({ checkout: worktree, allowProgress: false }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("artifact writer defaults to parent and child writer requires effective mutation capability", () => {
  assert.equal(resolveArtifactWriter(profile("read-only"), false).writer, "parent");
  assert.throws(() => resolveArtifactWriter(profile("read-only", "child"), false), /without effective mutation capability/);
  assert.throws(() => resolveArtifactWriter(profile("write", "child"), false), /without effective mutation capability/);
  assert.equal(resolveArtifactWriter(profile("write", "child"), true).writer, "child");
});

test("parent materializes full assignment and final output for read-only handoffs", async () => {
  const fx = await fixture();
  try {
    const parentPath = join(fx.parentRoots.checkout, ".subagents", "scout-run.handoff.md");
    const parent = await materializeHandoff({
      profile: profile("read-only"), effectiveMutationCapable: false, handoffPath: parentPath, roots: fx.parentRoots,
      assignment: "Full delegated scout assignment", finalOutput: "Parent-captured scout evidence.",
    });
    assert.equal(parent.writer, "parent");
    const content = await readFile(parent.path, "utf8");
    assert.match(content, /Full delegated scout assignment/);
    assert.match(content, /Parent-captured scout evidence/);
  } finally { await fx.cleanup(); }
});

test("valid child handoff is preserved and wrapped by a deterministic parent-owned final handoff", async () => {
  const fx = await fixture();
  try {
    const childPath = join(fx.parentRoots.checkout, ".subagents", "worker-run.handoff.md");
    await writeArtifactAtomic(childPath, "Child-provided evidence.", fx.parentRoots);
    const wrapped = await materializeHandoff({
      profile: profile("write", "child"), effectiveMutationCapable: true, handoffPath: childPath, roots: fx.parentRoots,
      assignment: "Full delegated writer assignment", finalOutput: "not used",
    });
    assert.equal(wrapped.writer, "parent-wrapper");
    assert.equal(wrapped.path, parentHandoffWrapperPath(childPath));
    assert.equal(await readFile(childPath, "utf8"), "Child-provided evidence.");
    const content = await readFile(wrapped.path, "utf8");
    assert.match(content, /Full delegated writer assignment/);
    assert.match(content, /Validated child handoff/);
    assert.match(content, /Child-provided evidence/);
  } finally { await fx.cleanup(); }
});

test("run-scoped child wrappers never consume stale cross-run evidence", async () => {
  const fx = await fixture();
  try {
    const firstValues = { id: "first-run", groupId: "group-1", profile: "worker", harness: "pi" as const };
    const secondValues = { ...firstValues, id: "second-run" };
    assert.throws(() => resolveArtifactPath(".subagents/{id}/../handoff.md", secondValues, fx.parentRoots), /must not contain '\.' or '\.\.' path components/);
    const template = ".subagents/runs/{id}/handoff.md";
    const firstPath = resolveArtifactPath(template, firstValues, fx.parentRoots);
    const secondPath = resolveArtifactPath(template, secondValues, fx.parentRoots);
    await writeArtifactAtomic(firstPath, "First-run child evidence.", fx.parentRoots);
    await writeArtifactAtomic(secondPath, "Second-run child evidence.", fx.parentRoots);
    const second = await materializeHandoff({
      profile: profile("write", "child"), effectiveMutationCapable: true, handoffPath: secondPath, roots: fx.parentRoots,
      assignment: "Second full assignment", finalOutput: "unused for child writer",
    });
    assert.equal(second.path, parentHandoffWrapperPath(secondPath));
    assert.equal(await readFile(firstPath, "utf8"), "First-run child evidence.");
    assert.match(await readFile(second.path, "utf8"), /Second-run child evidence/);
    assert.doesNotMatch(await readFile(second.path, "utf8"), /First-run child evidence/);
  } finally { await fx.cleanup(); }
});

test("missing or invalid child handoff fails closed without inventing wrapper body", async (t) => {
  for (const mode of ["missing", "empty", "conflict"] as const) await t.test(mode, async () => {
    const fx = await fixture();
    try {
      const childPath = join(fx.parentRoots.checkout, ".subagents", `${mode}-run.handoff.md`);
      if (mode === "empty") await writeArtifactAtomic(childPath, "  \n", fx.parentRoots);
      if (mode === "conflict") await mkdir(childPath, { recursive: true });
      const input = {
        profile: profile("write", "child"), effectiveMutationCapable: true, handoffPath: childPath, roots: fx.parentRoots,
        assignment: `Full ${mode} assignment`, finalOutput: `Must not be used for ${mode} child handoff.`,
      } as const;
      await assert.rejects(materializeHandoff(input), /Child handoff|not a regular file|ENOENT|must contain non-whitespace/i);
      if (mode === "empty") assert.equal(await readFile(childPath, "utf8"), "  \n");
      if (mode === "conflict") assert.equal((await lstat(childPath)).isDirectory(), true);
    } finally { await fx.cleanup(); }
  });
});

test("parent writer rejects empty final output", async () => {
  const fx = await fixture();
  try {
    const parentPath = join(fx.parentRoots.checkout, ".subagents", "empty-output-run.handoff.md");
    await assert.rejects(materializeHandoff({
      profile: profile("read-only"), effectiveMutationCapable: false, handoffPath: parentPath, roots: fx.parentRoots,
      assignment: "Full assignment", finalOutput: "  \n",
    }), /non-empty text/);
  } finally { await fx.cleanup(); }
});

test("required worktree outputs are copied into parent-owned storage and byte/hash verified before cleanup", async () => {
  const fx = await fixture();
  try {
    const handoff = join(fx.worktree, ".subagents", "handoff.md");
    const progress = join(fx.worktree, ".subagents", "progress.md");
    await writeArtifactAtomic(handoff, "handoff evidence", fx.worktreeRoots);
    await writeArtifactAtomic(progress, "progress evidence", fx.worktreeRoots);
    const result = await captureWorktreeArtifactsBeforeRemoval({
      artifacts: [
        { kind: "handoff", sourcePath: handoff, required: true },
        { kind: "progress", sourcePath: progress, required: true },
      ],
      sourceRoots: fx.worktreeRoots,
      parentRoots: fx.parentRoots,
      runId: "run-1",
    });
    assert.equal(result.verifiedForRemoval, true);
    assert.equal(result.references.length, 2);
    for (const reference of result.references) {
      assert.equal(reference.absolutePath.startsWith(fx.parentRoots.checkout), true);
      assert.equal(typeof reference.byteLength, "number");
      assert.match(reference.sha256 ?? "", /^[a-f0-9]{64}$/);
    }
    const repeated = await captureWorktreeArtifactsBeforeRemoval({
      artifacts: [
        { kind: "handoff", sourcePath: handoff, required: true },
        { kind: "progress", sourcePath: progress, required: true },
      ],
      sourceRoots: fx.worktreeRoots,
      parentRoots: fx.parentRoots,
      runId: "run-1",
    });
    assert.equal(repeated.verifiedForRemoval, true);
    assert.equal(repeated.references.length, 2);

    await rm(fx.worktree, { recursive: true, force: true });
    for (const reference of result.references) assert.equal((await readFile(reference.absolutePath, "utf8")).includes("evidence"), true);
  } finally {
    await fx.cleanup();
  }
});

test("missing or empty required worktree evidence blocks removal verification", async () => {
  const fx = await fixture();
  try {
    const missing = join(fx.worktree, ".subagents", "missing.md");
    const result = await captureWorktreeArtifactsBeforeRemoval({
      artifacts: [{ kind: "handoff", sourcePath: missing, required: true }],
      sourceRoots: fx.worktreeRoots,
      parentRoots: fx.parentRoots,
      runId: "run-2",
    });
    assert.equal(result.verifiedForRemoval, false);
    assert.equal(result.references.length, 0);
    assert.equal(result.diagnostics[0]?.severity, "error");
  } finally {
    await fx.cleanup();
  }
});

test("pre-removal capture rejects same checkouts and additional-root destinations", async () => {
  const fx = await fixture();
  const additional = join(fx.root, "additional");
  await mkdir(additional);
  try {
    await assert.rejects(
      captureWorktreeArtifactsBeforeRemoval({
        artifacts: [],
        sourceRoots: fx.worktreeRoots,
        parentRoots: fx.worktreeRoots,
        runId: "same-root",
      }),
      /distinct, and non-overlapping/,
    );

    const nestedParent = join(fx.worktree, "nested-parent");
    await mkdir(nestedParent);
    const nestedParentRoots = await resolveArtifactRoots({ checkout: nestedParent, allowProgress: false });
    await assert.rejects(
      captureWorktreeArtifactsBeforeRemoval({
        artifacts: [],
        sourceRoots: fx.worktreeRoots,
        parentRoots: nestedParentRoots,
        runId: "overlapping-root",
      }),
      /distinct, and non-overlapping/,
    );

    await assert.rejects(
      captureWorktreeArtifactsBeforeRemoval({
        artifacts: [],
        sourceRoots: fx.worktreeRoots,
        parentRoots: { ...fx.parentRoots, subagents: additional, additional: [additional] },
        runId: "additional-root",
      }),
      /parent checkout's \.subagents/,
    );

    const sourceRootsWithAdditional = await resolveArtifactRoots({
      checkout: fx.worktree,
      allowProgress: false,
      trustedAdditionalRoots: [additional],
    });
    const additionalSource = join(additional, "handoff.md");
    await writeArtifactAtomic(additionalSource, "not checkout-owned", sourceRootsWithAdditional);
    const sourceRejected = await captureWorktreeArtifactsBeforeRemoval({
      artifacts: [{ kind: "handoff", sourcePath: additionalSource, required: true }],
      sourceRoots: sourceRootsWithAdditional,
      parentRoots: fx.parentRoots,
      runId: "additional-source",
    });
    assert.equal(sourceRejected.verifiedForRemoval, false);
    assert.equal(sourceRejected.references.length, 0);
    assert.match(sourceRejected.diagnostics[0]?.message ?? "", /not owned by the disposable checkout/);
  } finally {
    await fx.cleanup();
  }
});

test("capture collision preserves retained evidence and blocks removal", async () => {
  const fx = await fixture();
  try {
    const sourcePath = join(fx.worktree, ".subagents", "handoff.md");
    await writeArtifactAtomic(sourcePath, "new evidence", fx.worktreeRoots);
    const destination = join(
      fx.parent,
      ".subagents",
      "runs",
      "collision-run",
      "captured",
      "handoff-handoff.md",
    );
    await writeArtifactAtomic(destination, "retained evidence", fx.parentRoots);

    const result = await captureWorktreeArtifactsBeforeRemoval({
      artifacts: [{ kind: "handoff", sourcePath, required: true }],
      sourceRoots: fx.worktreeRoots,
      parentRoots: fx.parentRoots,
      runId: "collision-run",
    });
    assert.equal(result.verifiedForRemoval, false);
    assert.equal(result.references.length, 0);
    assert.equal(result.diagnostics.some((item) => item.code === "worktree-artifact-destination-collision"), true);
    assert.equal(await readFile(destination, "utf8"), "retained evidence");
  } finally {
    await fx.cleanup();
  }
});

test("parent handoff materialization never overwrites tracked evidence", async () => {
  const fx = await fixture();
  try {
    await git(fx.parent, "init", "-q");
    const path = join(fx.parent, ".subagents", "runs", "tracked-run", "handoff.md");
    await mkdir(join(fx.parent, ".subagents", "runs", "tracked-run"), { recursive: true });
    await writeFile(path, "tracked retained evidence", "utf8");
    await git(fx.parent, "add", "-f", ".subagents/runs/tracked-run/handoff.md");
    assert.equal(await git(fx.parent, "ls-files", "--", ".subagents/runs/tracked-run/handoff.md"), ".subagents/runs/tracked-run/handoff.md");

    await assert.rejects(
      materializeHandoff({
        profile: profile("read-only"),
        effectiveMutationCapable: false,
        handoffPath: path,
        roots: fx.parentRoots,
        assignment: "tracked assignment",
        finalOutput: "replacement evidence",
      }),
      /Artifact collision/,
    );
    assert.equal(await readFile(path, "utf8"), "tracked retained evidence");
  } finally {
    await fx.cleanup();
  }
});
