import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { purgeRuntimeRunArtifacts } from "../../src/artifacts/purge.ts";
import { resolveArtifactRoots } from "../../src/artifacts/paths.ts";
import { createCapturedResult, capturedToEnvelope } from "../../src/results/contracts.ts";
import { writeResultEnvelope } from "../../src/results/store.ts";

test("default operational run artifacts are purged without residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-purge-"));
  try {
    const roots = await resolveArtifactRoots({ checkout: root, allowProgress: false });
    const directory = join(root, ".subagents", "runs", "run-1");
    await writeResultEnvelope(root, capturedToEnvelope(createCapturedResult({
      source: "pi-final-assistant", runId: "run-1", runNonce: "nonce", generation: 1, requestNonce: "req", rawText: "done",
    }), { stage: "captured", parentSessionId: "parent" }), roots);
    await writeFile(join(directory, "run.json"), "{}\n");
    const result = await purgeRuntimeRunArtifacts(roots, "run-1");
    assert.deepEqual(result, { purged: true, directoryRemoved: true, preservedCustomArtifacts: false, reason: "Runtime run directory removed" });
    await assert.rejects(lstat(directory), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified custom captures are preserved while operational files are purged", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-purge-custom-"));
  try {
    const roots = await resolveArtifactRoots({ checkout: root, allowProgress: false });
    const directory = join(root, ".subagents", "runs", "run-1");
    await mkdir(join(directory, "captured"), { recursive: true });
    await writeFile(join(directory, "run.json"), "{}\n");
    await writeFile(join(directory, "captured", "handoff-custom.md"), "custom\n");
    const result = await purgeRuntimeRunArtifacts(roots, "run-1");
    assert.equal(result.preservedCustomArtifacts, true);
    assert.equal(await readFile(join(directory, "captured", "handoff-custom.md"), "utf8"), "custom\n");
    await assert.rejects(readFile(join(directory, "run.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit custom paths are preserved while neighboring operational files are purged", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-purge-explicit-"));
  try {
    const roots = await resolveArtifactRoots({ checkout: root, allowProgress: false });
    const directory = join(root, ".subagents", "runs", "run-1");
    const custom = join(directory, "handoff.md");
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "run.json"), "{}\n"); await writeFile(custom, "intentional\n");
    const result = await purgeRuntimeRunArtifacts(roots, "run-1", [custom]);
    assert.equal(result.preservedCustomArtifacts, true); assert.equal(await readFile(custom, "utf8"), "intentional\n"); await assert.rejects(readFile(join(directory, "run.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe result-store entries fail closed", async (t) => {
  const cases = ["000000.json", "generation-1.json", "000001.txt", "1000000.json", "owner.json"];
  for (const name of cases) await t.test(name, async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-purge-result-name-"));
    try {
      const roots = await resolveArtifactRoots({ checkout: root, allowProgress: false });
      const results = join(root, ".subagents", "runs", "run-1", "results");
      await mkdir(results, { recursive: true });
      await writeFile(join(results, name), "keep\n");
      await assert.rejects(purgeRuntimeRunArtifacts(roots, "run-1"), /unsafe entry/);
      assert.equal(await readFile(join(results, name), "utf8"), "keep\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  for (const mode of ["directory", "symlink"] as const) await t.test(mode, async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-purge-result-type-"));
    try {
      const roots = await resolveArtifactRoots({ checkout: root, allowProgress: false });
      const results = join(root, ".subagents", "runs", "run-1", "results");
      await mkdir(results, { recursive: true });
      const entry = join(results, "000001.json");
      if (mode === "directory") await mkdir(entry);
      else { await writeFile(join(root, "outside"), "keep\n"); await symlink(join(root, "outside"), entry); }
      await assert.rejects(purgeRuntimeRunArtifacts(roots, "run-1"), /unsafe entry/);
      assert.equal((await lstat(entry)).isDirectory() || (await lstat(entry)).isSymbolicLink(), true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("unknown entries and symlinks fail closed", async (t) => {
  for (const mode of ["unknown", "symlink"] as const) await t.test(mode, async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-purge-refuse-"));
    try {
      const roots = await resolveArtifactRoots({ checkout: root, allowProgress: false });
      const directory = join(root, ".subagents", "runs", "run-1");
      await mkdir(directory, { recursive: true });
      if (mode === "unknown") await writeFile(join(directory, "owner-data.txt"), "keep\n");
      else { await writeFile(join(root, "outside"), "keep\n"); await symlink(join(root, "outside"), join(directory, "run.json")); }
      await assert.rejects(purgeRuntimeRunArtifacts(roots, "run-1"), /unknown entry|symlink/);
      assert.equal((await lstat(directory)).isDirectory(), true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
