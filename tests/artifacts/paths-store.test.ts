import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRunArtifactPaths,
  resolveArtifactPath,
  resolveArtifactRoots,
} from "../../src/artifacts/paths.ts";
import { readArtifactSafe, writeArtifactAtomic } from "../../src/artifacts/store.ts";

async function fixture(allowProgress = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-artifacts-"));
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  const additional = join(root, "additional");
  await mkdir(checkout);
  await mkdir(outside);
  await mkdir(additional);
  const roots = await resolveArtifactRoots({ checkout, allowProgress, trustedAdditionalRoots: [additional] });
  return { root, checkout, outside, additional, roots, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const values = { id: "run-1", groupId: "group-1", profile: "worker", harness: "pi" as const };

test("artifact paths are canonical absolute registry paths with a documented placeholder set", async () => {
  const fx = await fixture(true);
  try {
    const canonical = canonicalRunArtifactPaths(fx.roots, values);
    for (const path of Object.values(canonical)) assert.equal(path.startsWith(fx.roots.checkout), true);
    assert.deepEqual(Object.keys(canonical).sort(), ["groupMetadata", "handoff", "progress", "root", "runDirectory", "runMetadata"]);
    const secondRunValues = { ...values, id: "run-2" };
    const firstRunPath = resolveArtifactPath(".subagents/{id}.{profile}.{harness}.md", values, fx.roots);
    const secondRunPath = resolveArtifactPath(".subagents/{id}.{profile}.{harness}.md", secondRunValues, fx.roots);
    assert.equal(firstRunPath, join(fx.roots.checkout, ".subagents", "run-1.worker.pi.md"));
    assert.notEqual(firstRunPath, secondRunPath);
    assert.equal(resolveArtifactPath(".progress/{groupId}.md", values, fx.roots), join(fx.roots.checkout, ".progress", "group-1.md"));
    const firstAbsolute = resolveArtifactPath(join(fx.additional, "{id}.md"), values, fx.roots);
    const secondAbsolute = resolveArtifactPath(join(fx.additional, "{id}.md"), secondRunValues, fx.roots);
    assert.equal(firstAbsolute, join(fx.roots.additional[0]!, "run-1.md"));
    assert.notEqual(firstAbsolute, secondAbsolute);
    assert.throws(
      () => resolveArtifactPath(join(fx.checkout, ".subagents", "{id}.md"), values, fx.roots),
      /Absolute artifact templates require a trusted additional root/,
    );
    assert.throws(() => resolveArtifactPath(".subagents/{unknown}.md", values, fx.roots), /Unknown artifact placeholder/);
    for (const template of [
      ".subagents/{id}/../handoff.md",
      ".subagents/./{id}.handoff.md",
      ".subagents/{id}/../../../escape",
      `${fx.additional}/{id}/../handoff.md`,
    ]) {
      assert.throws(
        () => resolveArtifactPath(template, values, fx.roots),
        /must not contain '\.' or '\.\.' path components/,
      );
    }
    assert.throws(() => resolveArtifactPath(join(fx.outside, "escape.md"), values, fx.roots), /outside allowed roots/);
    assert.throws(() => resolveArtifactPath(".subagents/{id}.md", { ...values, id: "../escape" }, fx.roots), /unsafe path component/);
  } finally {
    await fx.cleanup();
  }
});

test(".progress is allowed only when explicitly requested by profile artifact policy", async () => {
  const fx = await fixture(false);
  try {
    assert.throws(() => resolveArtifactPath(".progress/{id}.md", values, fx.roots), /outside allowed roots/);
  } finally {
    await fx.cleanup();
  }
});

test("artifact writes use exclusive creation, atomic replacement, and safe reads", async () => {
  const fx = await fixture();
  try {
    const path = resolveArtifactPath(".subagents/{id}.handoff.md", values, fx.roots);
    await writeArtifactAtomic(path, "first", fx.roots);
    await assert.rejects(writeArtifactAtomic(path, "unexpected", fx.roots), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
    await writeArtifactAtomic(path, "second", fx.roots, { replace: true });
    assert.equal((await readArtifactSafe(path, fx.roots)).toString("utf8"), "second");
    assert.equal(await readFile(path, "utf8"), "second");
  } finally {
    await fx.cleanup();
  }
});

test("component-by-component creation rejects a symlinked artifact root without writing outside", async () => {
  const fx = await fixture();
  try {
    await symlink(fx.outside, join(fx.roots.checkout, ".subagents"), "dir");
    const path = resolveArtifactPath(".subagents/{id}.handoff.md", values, fx.roots);
    await assert.rejects(writeArtifactAtomic(path, "escape", fx.roots), /symlink/);
    await assert.rejects(readFile(join(fx.outside, "run-1.handoff.md"), "utf8"), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test("write-time revalidation rejects a mutable symlink component and target", async () => {
  const fx = await fixture();
  try {
    const first = resolveArtifactPath(".subagents/runs/{id}/handoff.md", values, fx.roots);
    await writeArtifactAtomic(first, "safe", fx.roots);
    await rm(join(fx.roots.checkout, ".subagents", "runs", "run-1"), { recursive: true });
    await symlink(fx.outside, join(fx.roots.checkout, ".subagents", "runs", "run-1"), "dir");
    await assert.rejects(writeArtifactAtomic(first, "escape", fx.roots, { replace: true }), /symlink/);
    await assert.rejects(readFile(join(fx.outside, "handoff.md"), "utf8"), /ENOENT/);

    const target = resolveArtifactPath(".subagents/target.md", values, fx.roots);
    await writeFile(join(fx.outside, "target.md"), "outside", "utf8");
    await symlink(join(fx.outside, "target.md"), target);
    await assert.rejects(writeArtifactAtomic(target, "overwrite", fx.roots, { replace: true }), /target is a symlink/);
    assert.equal(await readFile(join(fx.outside, "target.md"), "utf8"), "outside");
  } finally {
    await fx.cleanup();
  }
});
