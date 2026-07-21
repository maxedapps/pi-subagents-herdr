import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  appendArtifactSection,
  enumerateRunArtifacts,
  renderAbortedGenerationSection,
  renderArtifactHeader,
  renderCleanupSection,
  renderGenerationSection,
  resolveArtifactLocation,
  type ArtifactIdentity,
  type ArtifactUpdateOperations,
} from "../src/artifact.ts";

async function fixture(run: (root: string, identity: ArtifactIdentity) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "herdr-artifact-"));
  const identity = { agentDir: join(root, "agent"), parentSessionId: "parent-session", runId: "run-01" };
  try {
    await run(root, identity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("artifact locations are deterministic, contained, and reject invalid identifiers", () => {
  const identity = { agentDir: "/agent", parentSessionId: "parent-123", runId: "run_456" };
  assert.deepEqual(resolveArtifactLocation(identity), {
    directory: resolve("/agent/herdr-subagent-artifacts/parent-123"),
    path: resolve("/agent/herdr-subagent-artifacts/parent-123/run_456.md"),
  });

  for (const parentSessionId of ["", ".", "..", "../escape", "nested/session", "nested\\session", "line\nbreak"]) {
    assert.throws(() => resolveArtifactLocation({ ...identity, parentSessionId }), /Invalid parent session ID/);
  }
  for (const runId of ["", ".", "..", "../escape", "/absolute", "nested/run", "nested\\run", "nul\0byte"]) {
    assert.throws(() => resolveArtifactLocation({ ...identity, runId }), /Invalid run ID/);
  }
});

test("artifact enumeration returns only sorted regular deterministic Markdown files", async () => {
  await fixture(async (root, identity) => {
    assert.deepEqual(await enumerateRunArtifacts(identity.agentDir, identity.parentSessionId), []);
    const directory = resolveArtifactLocation(identity).directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "run-b.md"), "## fake completion heading\n");
    await writeFile(join(directory, "run-a.md"), "artifact\n");
    await writeFile(join(directory, ".hidden.md"), "hidden\n");
    await writeFile(join(directory, "run-c.txt"), "text\n");
    await writeFile(join(directory, ".run-a.1.tmp"), "temp\n");
    await mkdir(join(directory, "run-dir.md"));
    const outside = join(root, "outside.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(directory, "run-link.md"));

    assert.deepEqual(await enumerateRunArtifacts(identity.agentDir, identity.parentSessionId), [
      { runId: "run-a", path: join(directory, "run-a.md") },
      { runId: "run-b", path: join(directory, "run-b.md") },
    ]);
  });
});

test("headers and cleanup sections contain only concise supplied facts", () => {
  assert.equal(renderArtifactHeader({ runId: "run-01", profile: "scout" }), [
    "# Herdr subagent run-01",
    "- Profile: scout",
    "",
  ].join("\n"));
  assert.equal(renderArtifactHeader({
    runId: "run-02",
    profile: "worker",
    worker: { path: "/repo/worktree", branch: "herdr-subagents/run-02", workspaceId: "workspace-2" },
  }), [
    "# Herdr subagent run-02",
    "- Profile: worker",
    "- Worktree: /repo/worktree",
    "- Branch: herdr-subagents/run-02",
    "- Workspace: workspace-2",
    "",
  ].join("\n"));
  assert.throws(
    () => renderArtifactHeader({ runId: "run-03", profile: "researcher", worker: { path: "/not-relevant" } }),
    /require the worker profile/,
  );
  assert.equal(renderCleanupSection({
    state: "action required",
    reason: "worktree is dirty",
    retained: ["worktree /repo/worktree", "branch herdr-subagents/run-02"],
    next: "Preserve the work, then retry subagent_stop.",
  }), [
    "",
    "## Cleanup",
    "- State: action required",
    "- Reason: worktree is dirty",
    "- Retained: worktree /repo/worktree",
    "- Retained: branch herdr-subagents/run-02",
    "- Next: Preserve the work, then retry subagent_stop.",
    "",
  ].join("\n"));
});

test("aborted generation sections are concise and validate their generation", () => {
  assert.equal(renderAbortedGenerationSection({ generation: 2 }), [
    "",
    "## Generation 2 — Aborted",
    "- Explicitly stopped before a final result.",
    "",
  ].join("\n"));
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => renderAbortedGenerationSection({ generation }), /Invalid generation number/);
  }
});

test("generation bodies remain verbatim inside a minimally longer backtick fence", () => {
  const body = "first line\n## generated heading\n`````\nlast line";
  assert.equal(renderGenerationSection({ generation: 2, speaker: "Subagent", body }), [
    "",
    "## Generation 2 — Subagent",
    "``````text",
    "first line",
    "## generated heading",
    "`````",
    "last line",
    "``````",
    "",
  ].join("\n"));

  const withoutTrailingNewline = renderGenerationSection({ generation: 1, speaker: "Parent", body: "task" });
  const withTrailingNewline = renderGenerationSection({ generation: 1, speaker: "Parent", body: "task\n" });
  assert.match(withoutTrailingNewline, /```text\ntask\n```\n$/);
  assert.match(withTrailingNewline, /```text\ntask\n\n```\n$/);
  assert.notEqual(withoutTrailingNewline, withTrailingNewline);
  assert.equal(renderGenerationSection({ generation: 3, speaker: "Subagent", body: "" }),
    "\n## Generation 3 — Subagent\n```text\n\n```\n");
});

test("serialized updates preserve call order and create private files and directories", async () => {
  await fixture(async (_root, identity) => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const release = new Promise<void>((resolveRelease) => { releaseFirst = resolveRelease; });
    const delayedOperations: ArtifactUpdateOperations = {
      async writeFile(path, contents, options) {
        markStarted();
        await release;
        await writeFile(path, contents, options);
      },
      rename,
    };

    const header = renderArtifactHeader({ runId: identity.runId, profile: "worker" });
    const parent = renderGenerationSection({ generation: 1, speaker: "Parent", body: "exact task" });
    const result = renderGenerationSection({ generation: 1, speaker: "Subagent", body: "exact result" });
    const first = appendArtifactSection(identity, header, delayedOperations);
    await started;
    const second = appendArtifactSection(identity, parent);
    const third = appendArtifactSection(identity, result);
    releaseFirst();
    await Promise.all([first, second, third]);

    const location = resolveArtifactLocation(identity);
    assert.equal(await readFile(location.path, "utf8"), header + parent + result);
    assert.equal((await stat(join(identity.agentDir, "herdr-subagent-artifacts"))).mode & 0o777, 0o700);
    assert.equal((await stat(location.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(location.path)).mode & 0o777, 0o600);
  });
});

test("only an exact artifact tail suppresses a repeated section", async () => {
  await fixture(async (_root, identity) => {
    const aborted = renderAbortedGenerationSection({ generation: 1 });
    const cleanup = renderCleanupSection({ state: "finalized" });
    await appendArtifactSection(identity, aborted);
    await appendArtifactSection(identity, aborted);
    assert.equal(await readFile(resolveArtifactLocation(identity).path, "utf8"), aborted);

    await appendArtifactSection(identity, cleanup);
    await appendArtifactSection(identity, aborted);
    assert.equal(await readFile(resolveArtifactLocation(identity).path, "utf8"), aborted + cleanup + aborted);
  });
});

test("temp-write and rename failures preserve the prior complete artifact", async () => {
  await fixture(async (_root, identity) => {
    const initial = renderArtifactHeader({ runId: identity.runId, profile: "scout" });
    await appendArtifactSection(identity, initial);
    const location = resolveArtifactLocation(identity);

    await assert.rejects(appendArtifactSection(identity, "must not appear", {
      async writeFile() { throw new Error("injected temp write failure"); },
      async rename() { throw new Error("unexpected rename"); },
    }), /injected temp write failure/);
    assert.equal(await readFile(location.path, "utf8"), initial);

    let observedTempPath = "";
    await assert.rejects(appendArtifactSection(identity, "also absent", {
      async writeFile(path, contents, options) {
        observedTempPath = path;
        assert.equal(dirname(path), location.directory);
        assert.deepEqual(options, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await writeFile(path, contents, options);
      },
      async rename() { throw new Error("injected rename failure"); },
    }), /injected rename failure/);
    assert.equal(await readFile(location.path, "utf8"), initial);
    assert.equal(dirname(observedTempPath), location.directory);
    assert.deepEqual(await readdir(location.directory), [`${identity.runId}.md`]);

    await appendArtifactSection(identity, "after failure");
    assert.equal(await readFile(location.path, "utf8"), `${initial}after failure`);
  });
});

test("symlinked artifact directories and targets are rejected without external writes", async () => {
  await fixture(async (root, identity) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(identity.agentDir);
    await symlink(outside, join(identity.agentDir, "herdr-subagent-artifacts"), "dir");

    await assert.rejects(appendArtifactSection(identity, "escaped"), /not a real directory/);
    await assert.rejects(
      enumerateRunArtifacts(identity.agentDir, identity.parentSessionId),
      /Artifact root is not a real directory/,
    );
    assert.deepEqual(await readdir(outside), []);
  });

  await fixture(async (root, identity) => {
    await appendArtifactSection(identity, "complete");
    const location = resolveArtifactLocation(identity);
    const outsideFile = join(root, "outside.md");
    await writeFile(outsideFile, "outside remains complete", { mode: 0o600 });
    await rm(location.path);
    await symlink(outsideFile, location.path);

    await assert.rejects(appendArtifactSection(identity, "escaped"), /symbolic link/);
    assert.equal(await readFile(outsideFile, "utf8"), "outside remains complete");
  });
});
