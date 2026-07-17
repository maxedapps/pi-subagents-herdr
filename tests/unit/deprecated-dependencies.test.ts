import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const expectedMessage = "Use your platform's native DOMException instead";
const acceptedEntry = { version: "1.0.0", dev: true, deprecated: expectedMessage };

async function runAudit(packages: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "deprecated-lock-audit-"));
  const lockfile = join(directory, "fixture-lock.json");
  await writeFile(lockfile, `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages }, null, 2)}\n`);
  try {
    const result = spawnSync(process.execPath, ["--throw-deprecation", "scripts/check-deprecated-dependencies.mjs", lockfile], {
      cwd: process.cwd(), encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runMissingSourceLock(sourceMarker: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "deprecated-lock-missing-"));
  const lockfile = join(directory, "package-lock.json");
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "pi-subagents-herdr",
    files: ["extensions/", "src/", "scripts/"],
  }, null, 2)}\n`);
  if (sourceMarker) await mkdir(join(directory, "tests"));
  try {
    const result = spawnSync(process.execPath, ["--throw-deprecation", "scripts/check-deprecated-dependencies.mjs", lockfile], {
      cwd: process.cwd(), encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts duplicate exact dev-only node-domexception lock entries", async () => {
  const result = await runAudit({
    "": { name: "fixture" },
    "node_modules/node-domexception": acceptedEntry,
    "node_modules/parent/node_modules/node-domexception": acceptedEntry,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 reviewed lock entries/);
  assert.match(result.stdout, /node_modules\/parent\/node_modules\/node-domexception/);
});

test("rejects every unknown deprecated package", async () => {
  const result = await runAudit({
    "node_modules/node-domexception": acceptedEntry,
    "node_modules/legacy-package": { version: "2.0.0", dev: true, deprecated: "Use a replacement" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unreviewed deprecated dependency legacy-package@2\.0\.0/);
});

test("rejects malformed deprecated metadata", async () => {
  const result = await runAudit({
    "node_modules/node-domexception": acceptedEntry,
    "node_modules/malformed": { version: "1.0.0", dev: true, deprecated: true },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed deprecated metadata/);
});

for (const mismatch of [
  { name: "wrong version", entry: { ...acceptedEntry, version: "1.0.1" }, expected: /requires version 1\.0\.0/ },
  { name: "non-dev path", entry: { ...acceptedEntry, dev: false }, expected: /requires dev=true/ },
  { name: "changed message", entry: { ...acceptedEntry, deprecated: "Deprecated" }, expected: /exception message changed/ },
] as const) {
  test(`rejects a node-domexception ${mismatch.name} mismatch`, async () => {
    const result = await runAudit({ "node_modules/node-domexception": mismatch.entry });
    assert.equal(result.status, 1);
    assert.match(result.stderr, mismatch.expected);
  });
}

test("rejects a stale exception when deprecated node-domexception entries disappear", async () => {
  const result = await runAudit({ "": { name: "fixture" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale node-domexception exception/);
  assert.match(result.stderr, /remove the allowlist and contributor warning/);
});

test("reports the source-lock audit as not applicable in an installed archive", async () => {
  const result = await runMissingSourceLock(false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not applicable: source package-lock\.json is intentionally excluded/);
});

test("fails when a source checkout marker remains but package-lock.json is missing", async () => {
  const result = await runMissingSourceLock(true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});
