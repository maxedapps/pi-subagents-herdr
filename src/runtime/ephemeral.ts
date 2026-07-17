import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Harness } from "../contracts/harness.ts";

export interface EphemeralRuntimeFiles {
  readonly directory: string;
  readonly systemPrompt: string;
  readonly sessionDirectory?: string;
  readonly resultExchangeDirectory?: string;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;
const ROOT_PREFIX = "pi-subagent-";

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Ephemeral runtime requires a safe immutable run ID");
}

function basenamePrefix(runId: string): string {
  assertSafeRunId(runId);
  return `${ROOT_PREFIX}${runId}-`;
}

async function canonicalTemporaryRoot(): Promise<string> {
  return realpath(resolve(tmpdir()));
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real non-symlink directory`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} must be private`);
  if (await realpath(path) !== path) throw new Error(`${label} must use its canonical path`);
}

async function assertRunBoundRoot(runId: string, directoryPath: string): Promise<string> {
  const temporaryRoot = await canonicalTemporaryRoot();
  const directory = resolve(directoryPath);
  const prefix = basenamePrefix(runId);
  const name = basename(directory);
  if (dirname(directory) !== temporaryRoot || !name.startsWith(prefix) || !SAFE_MKDTEMP_SUFFIX.test(name.slice(prefix.length))) {
    throw new Error("Ephemeral runtime directory is not the exact run-bound mkdtemp layout under the canonical OS temp root");
  }
  if (directoryPath !== directory) throw new Error("Ephemeral runtime directory path must be canonical and absolute");
  await assertPrivateDirectory(directory, "Ephemeral runtime directory");
  return directory;
}

async function assertPrivateFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real non-symlink file`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} must be private`);
  if (await realpath(path) !== path) throw new Error(`${label} must use its canonical path`);
}

async function assertResultExchangeLayout(directory: string, exchangeDirectory: string): Promise<void> {
  if (exchangeDirectory !== join(directory, "result-exchange")) {
    throw new Error("Pi ephemeral runtime requires the exact result-exchange child path");
  }
  await assertPrivateDirectory(exchangeDirectory, "Ephemeral Pi result-exchange directory");
  const requests = join(exchangeDirectory, "requests");
  const responses = join(exchangeDirectory, "responses");
  await assertPrivateDirectory(requests, "Ephemeral Pi result-exchange requests directory");
  await assertPrivateDirectory(responses, "Ephemeral Pi result-exchange responses directory");
  const entries = (await readdir(exchangeDirectory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["requests", "responses"])) {
    throw new Error("Ephemeral result-exchange directory contains an unexpected entry");
  }
}

/** Validate the exact deletable OS-temp layout bound to one immutable run ID. */
export async function assertEphemeralRuntimeLayout(
  runId: string,
  harness: Harness,
  files: EphemeralRuntimeFiles,
): Promise<void> {
  const directory = await assertRunBoundRoot(runId, files.directory);
  if (files.systemPrompt !== join(directory, "system.md")) throw new Error("Ephemeral runtime system prompt path does not match its exact run-bound child path");
  if (harness === "pi") {
    if (files.sessionDirectory !== join(directory, "sessions")) throw new Error("Pi ephemeral runtime requires the exact sessions child path");
    if (files.resultExchangeDirectory === undefined) throw new Error("Pi ephemeral runtime requires the result-exchange child path");
    await assertResultExchangeLayout(directory, files.resultExchangeDirectory);
  } else {
    if (files.sessionDirectory !== undefined) throw new Error("Non-Pi ephemeral runtime must not claim a Pi sessions child");
    if (files.resultExchangeDirectory !== undefined) throw new Error("Non-Pi ephemeral runtime must not claim a Pi result-exchange child");
  }

  await assertPrivateFile(files.systemPrompt, "Ephemeral runtime system prompt");
  if (files.sessionDirectory !== undefined) await assertPrivateDirectory(files.sessionDirectory, "Ephemeral Pi session directory");

  const expectedEntries = files.sessionDirectory === undefined
    ? ["system.md"]
    : ["result-exchange", "sessions", "system.md"];
  const entries = (await readdir(directory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error("Ephemeral runtime directory contains an unexpected root entry");
  }
}

export async function createEphemeralRuntimeFiles(
  runId: string,
  harness: Harness,
  systemText: string,
): Promise<EphemeralRuntimeFiles> {
  const temporaryRoot = await canonicalTemporaryRoot();
  const directory = await mkdtemp(join(temporaryRoot, basenamePrefix(runId)));
  try {
    await chmod(directory, 0o700);
    const systemPrompt = join(directory, "system.md");
    await writeFile(systemPrompt, systemText, { mode: 0o600, flag: "wx" });
    const files: EphemeralRuntimeFiles = harness === "pi"
      ? {
          directory,
          systemPrompt,
          sessionDirectory: join(directory, "sessions"),
          resultExchangeDirectory: join(directory, "result-exchange"),
        }
      : { directory, systemPrompt };
    if (files.sessionDirectory !== undefined) await mkdir(files.sessionDirectory, { mode: 0o700 });
    if (files.resultExchangeDirectory !== undefined) {
      await mkdir(files.resultExchangeDirectory, { mode: 0o700 });
      await mkdir(join(files.resultExchangeDirectory, "requests"), { mode: 0o700 });
      await mkdir(join(files.resultExchangeDirectory, "responses"), { mode: 0o700 });
    }
    await assertEphemeralRuntimeLayout(runId, harness, files);
    return files;
  } catch (error) {
    // Construction cleanup still refuses redirected/symlinked roots and unknown entries.
    try {
      await assertRunBoundRoot(runId, directory);
      const entries = await readdir(directory);
      if (!entries.every((entry) => entry === "system.md" || entry === "sessions" || entry === "result-exchange")) {
        throw new Error("Unexpected construction-time runtime entry");
      }
      await rm(directory, { recursive: true, force: true });
    } catch { /* Retain any tampered/uncertain directory rather than deleting recursively. */ }
    throw error;
  }
}

/** Revalidate the exact layout immediately before recursive deletion. */
export async function removeEphemeralRuntimeFiles(
  runId: string,
  harness: Harness,
  files: EphemeralRuntimeFiles,
): Promise<void> {
  await assertEphemeralRuntimeLayout(runId, harness, files);
  await rm(files.directory, { recursive: true, force: true });
}
