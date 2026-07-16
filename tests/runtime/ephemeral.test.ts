import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createEphemeralRuntimeFiles, removeEphemeralRuntimeFiles } from "../../src/runtime/ephemeral.ts";

test("ephemeral removal accepts only the exact canonical private run-bound OS-temp layout", async () => {
  const files = await createEphemeralRuntimeFiles("run-exact", "pi", "private prompt");
  await removeEphemeralRuntimeFiles("run-exact", "pi", files);
  await assert.rejects(access(files.directory), /ENOENT/);
});

test("external private-directory metadata cannot redirect recursive ephemeral deletion", async () => {
  const external = await mkdtemp(join(process.cwd(), ".ephemeral-external-"));
  try {
    await chmod(external, 0o700);
    const systemPrompt = join(external, "system.md");
    const sessionDirectory = join(external, "sessions");
    await writeFile(systemPrompt, "do not delete", { mode: 0o600 });
    await mkdir(sessionDirectory, { mode: 0o700 });
    await assert.rejects(
      removeEphemeralRuntimeFiles("run-external", "pi", { directory: external, systemPrompt, sessionDirectory }),
      /canonical OS temp root/,
    );
    await access(systemPrompt);
  } finally { await rm(external, { recursive: true, force: true }); }
});

test("unexpected root entries are detected again immediately before recursive removal", async () => {
  const files = await createEphemeralRuntimeFiles("run-tampered", "codex", "private prompt");
  try {
    await writeFile(join(files.directory, "unexpected"), "retain", { mode: 0o600 });
    await assert.rejects(removeEphemeralRuntimeFiles("run-tampered", "codex", files), /unexpected root entry/);
    await access(files.systemPrompt);
  } finally { await rm(files.directory, { recursive: true, force: true }); }
});
