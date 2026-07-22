import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  createRecoveryLocator,
  deleteRecoveryLocator,
  enumerateRecoveryLocators,
  readRecoveryLocator,
  RECOVERY_DIRECTORY,
  RECOVERY_LOCATOR_SCHEMA_VERSION,
  resolveRecoveryLocatorLocation,
  updateRecoveryLocatorOwnerState,
  type RecoveryLocatorOperations,
  type RecoveryLocatorWriteInput,
} from "../src/registry.ts";

function baseInput(overrides: Partial<RecoveryLocatorWriteInput> = {}): RecoveryLocatorWriteInput {
  return {
    runId: "run-01",
    parentSessionId: "parent-session",
    parentSessionFile: "/tmp/parent-session.jsonl",
    parentInstanceId: "instance-1",
    parentProcessId: 12345,
    profile: "scout",
    artifactPath: "/tmp/agent/herdr-subagent-artifacts/parent-session/run-01.md",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function fixture(run: (agentDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "herdr-registry-"));
  const agentDir = join(root, "agent");
  try {
    await run(agentDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("locator locations are deterministic, contained, and reject invalid identifiers", () => {
  const identity = { agentDir: "/agent", parentSessionId: "parent-123", runId: "run_456" };
  assert.deepEqual(resolveRecoveryLocatorLocation(identity), {
    root: resolve("/agent", RECOVERY_DIRECTORY),
    directory: resolve("/agent", RECOVERY_DIRECTORY, "parent-123"),
    path: resolve("/agent", RECOVERY_DIRECTORY, "parent-123", "run_456.json"),
  });

  for (const parentSessionId of ["", ".", "..", "../escape", "nested/session", "nested\\session", "line\nbreak"]) {
    assert.throws(() => resolveRecoveryLocatorLocation({ ...identity, parentSessionId }), /Invalid parent session ID/);
  }
  for (const runId of ["", ".", "..", "../escape", "/absolute", "nested/run", "nested\\run", "nul\0byte"]) {
    assert.throws(() => resolveRecoveryLocatorLocation({ ...identity, runId }), /Invalid run ID/);
  }
});

test("create/read/update/delete round-trips with private modes and atomic overwrite", async () => {
  await fixture(async (agentDir) => {
    const created = await createRecoveryLocator(agentDir, baseInput());
    assert.equal(created.schemaVersion, RECOVERY_LOCATOR_SCHEMA_VERSION);
    assert.equal(created.ownerState, "active");

    const location = resolveRecoveryLocatorLocation({
      agentDir,
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    });
    const fileStats = await lstat(location.path);
    const dirStats = await lstat(location.directory);
    const rootStats = await lstat(location.root);
    assert.equal(fileStats.isFile(), true);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.equal(dirStats.mode & 0o777, 0o700);
    assert.equal(rootStats.mode & 0o777, 0o700);

    assert.deepEqual(await readRecoveryLocator(agentDir, {
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    }), created);

    const released = await updateRecoveryLocatorOwnerState(agentDir, {
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    }, "released");
    assert.equal(released.ownerState, "released");
    assert.equal((await readRecoveryLocator(agentDir, {
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    }))?.ownerState, "released");

    assert.equal(await deleteRecoveryLocator(agentDir, {
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    }), true);
    assert.equal(await readRecoveryLocator(agentDir, {
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    }), undefined);
    assert.equal(await deleteRecoveryLocator(agentDir, {
      parentSessionId: created.parentSessionId,
      runId: created.runId,
    }), false);
  });
});

test("enumeration is deterministic and isolates malformed, symlink, and traversal entries", async () => {
  await fixture(async (agentDir) => {
    assert.deepEqual(await enumerateRecoveryLocators(agentDir), []);

    await createRecoveryLocator(agentDir, baseInput({ runId: "run-b", createdAt: 2 }));
    await createRecoveryLocator(agentDir, baseInput({
      runId: "run-a",
      parentSessionId: "parent-a",
      createdAt: 1,
      profile: "worker",
    }));
    await createRecoveryLocator(agentDir, baseInput({
      runId: "run-c",
      parentSessionId: "parent-a",
      createdAt: 3,
      profile: "researcher",
    }));

    const root = resolveRecoveryLocatorLocation({
      agentDir,
      parentSessionId: "parent-session",
      runId: "run-b",
    }).root;
    const parentDir = join(root, "parent-session");
    await writeFile(join(parentDir, ".hidden.json"), "{}\n");
    await writeFile(join(parentDir, "run-temp.txt"), "nope\n");
    await writeFile(join(parentDir, "run-bad.json"), "{not-json\n");
    await writeFile(join(parentDir, "run-wrong.json"), JSON.stringify({
      schemaVersion: RECOVERY_LOCATOR_SCHEMA_VERSION,
      runId: "different",
      parentSessionId: "parent-session",
      parentSessionFile: "/tmp/parent-session.jsonl",
      parentInstanceId: "instance-1",
      parentProcessId: 1,
      profile: "scout",
      artifactPath: "/tmp/a.md",
      createdAt: 1,
      ownerState: "active",
    }));
    await mkdir(join(parentDir, "run-dir.json"));
    const outside = join(dirname(agentDir), "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, join(parentDir, "run-link.json"));

    const enumerated = await enumerateRecoveryLocators(agentDir);
    assert.deepEqual(enumerated.map(({ parentSessionId, runId, error }) => ({ parentSessionId, runId, error: Boolean(error) })), [
      { parentSessionId: "parent-a", runId: "run-a", error: false },
      { parentSessionId: "parent-a", runId: "run-c", error: false },
      { parentSessionId: "parent-session", runId: "run-b", error: false },
      { parentSessionId: "parent-session", runId: "run-bad", error: true },
      { parentSessionId: "parent-session", runId: "run-link", error: true },
      { parentSessionId: "parent-session", runId: "run-wrong", error: true },
    ]);
    assert.match(enumerated.find(({ runId }) => runId === "run-bad")?.error ?? "", /malformed/);
    assert.match(enumerated.find(({ runId }) => runId === "run-wrong")?.error ?? "", /identity mismatch|malformed/);
  });
});

test("per-run serialization isolates concurrent writes and cleans interrupted temps", async () => {
  await fixture(async (agentDir) => {
    const location = resolveRecoveryLocatorLocation({
      agentDir,
      parentSessionId: "parent-session",
      runId: "run-01",
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
    let firstStarted = false;

    const slowOps: RecoveryLocatorOperations = {
      async writeFile(path, contents, options) {
        firstStarted = true;
        await firstGate;
        await writeFile(path, contents, options);
      },
      rename,
      unlink: async (path) => { await rm(path, { force: true }); },
    };
    const first = createRecoveryLocator(agentDir, baseInput({ ownerState: "active" }), slowOps);
    await eventually(() => firstStarted);
    const second = createRecoveryLocator(agentDir, baseInput({
      ownerState: "released",
      parentInstanceId: "instance-2",
    }));
    releaseFirst();
    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    assert.equal(firstRecord.ownerState, "active");
    assert.equal(secondRecord.ownerState, "released");
    assert.equal((await readRecoveryLocator(agentDir, {
      parentSessionId: "parent-session",
      runId: "run-01",
    }))?.ownerState, "released");
    assert.equal((await readRecoveryLocator(agentDir, {
      parentSessionId: "parent-session",
      runId: "run-01",
    }))?.parentInstanceId, "instance-2");

    const entries = await readdir(location.directory);
    assert.deepEqual(entries.filter((name) => name.startsWith(".")), []);
  });
});

test("failed writes leave no durable locator and clean temp files", async () => {
  await fixture(async (agentDir) => {
    const location = resolveRecoveryLocatorLocation({
      agentDir,
      parentSessionId: "parent-session",
      runId: "run-01",
    });
    await assert.rejects(createRecoveryLocator(agentDir, baseInput(), {
      async writeFile() {
        throw new Error("disk full");
      },
      rename,
      unlink: async (path) => { await rm(path, { force: true }); },
    }), /disk full/);
    assert.equal(await readRecoveryLocator(agentDir, {
      parentSessionId: "parent-session",
      runId: "run-01",
    }), undefined);
    const directoryStats = await lstat(location.directory).catch(() => undefined);
    if (directoryStats) {
      const entries = await readdir(location.directory);
      assert.deepEqual(entries.filter((name) => name.endsWith(".tmp") || name.endsWith(".json")), []);
    }
  });
});

test("symlink roots and files are rejected", async () => {
  await fixture(async (agentDir) => {
    const realRoot = join(dirname(agentDir), "real-recovery");
    await mkdir(realRoot, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await symlink(realRoot, join(agentDir, RECOVERY_DIRECTORY));
    await assert.rejects(createRecoveryLocator(agentDir, baseInput()), /not a real directory/);

    await rm(join(agentDir, RECOVERY_DIRECTORY), { force: true });
    const location = resolveRecoveryLocatorLocation({
      agentDir,
      parentSessionId: "parent-session",
      runId: "run-01",
    });
    await mkdir(location.directory, { recursive: true });
    const outside = join(dirname(agentDir), "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, location.path);
    await assert.rejects(createRecoveryLocator(agentDir, baseInput()), /symbolic link/);
    await assert.rejects(readRecoveryLocator(agentDir, {
      parentSessionId: "parent-session",
      runId: "run-01",
    }), /not a regular file|symbolic link/);
  });
});

test("missing parent file values and invalid owner fields are rejected at write time", async () => {
  await fixture(async (agentDir) => {
    assert.throws(() => createRecoveryLocator(agentDir, baseInput({ parentSessionFile: "" })), /Invalid recovery locator record/);
    assert.throws(() => createRecoveryLocator(agentDir, baseInput({ parentProcessId: 0 })), /Invalid recovery locator record/);
    assert.throws(() => createRecoveryLocator(agentDir, baseInput({ parentProcessId: 1.5 })), /Invalid recovery locator record/);
  });
});

async function eventually(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}
