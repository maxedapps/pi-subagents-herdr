import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isProfileName, type ProfileName } from "./profiles.ts";

export const RECOVERY_DIRECTORY = "herdr-subagent-recovery";
export const RECOVERY_LOCATOR_SCHEMA_VERSION = 1 as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const updateQueues = new Map<string, Promise<unknown>>();

export type RecoveryLocatorOwnerState = "active" | "released";

export interface RecoveryLocatorIdentity {
  agentDir: string;
  parentSessionId: string;
  runId: string;
}

export interface RecoveryLocatorLocation {
  root: string;
  directory: string;
  path: string;
}

export interface RecoveryLocatorRecord {
  schemaVersion: typeof RECOVERY_LOCATOR_SCHEMA_VERSION;
  runId: string;
  parentSessionId: string;
  parentSessionFile: string;
  parentInstanceId: string;
  parentProcessId: number;
  profile: ProfileName;
  artifactPath: string;
  createdAt: number;
  ownerState: RecoveryLocatorOwnerState;
}

export interface RecoveryLocatorWriteInput {
  runId: string;
  parentSessionId: string;
  parentSessionFile: string;
  parentInstanceId: string;
  parentProcessId: number;
  profile: ProfileName;
  artifactPath: string;
  createdAt: number;
  ownerState?: RecoveryLocatorOwnerState;
}

export interface EnumeratedRecoveryLocator {
  parentSessionId: string;
  runId: string;
  path: string;
  record?: RecoveryLocatorRecord;
  error?: string;
}

export interface RecoveryLocatorOperations {
  writeFile(
    path: string,
    contents: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultOperations: RecoveryLocatorOperations = { writeFile, rename, unlink };

function validateIdentifier(label: string, value: string): void {
  if (!value || value === "." || value === ".." || /[\\/\0-\x1f\x7f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error("Recovery locator path escapes its root");
  }
}

export function isRecoveryLocatorRecord(value: unknown): value is RecoveryLocatorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === RECOVERY_LOCATOR_SCHEMA_VERSION
    && typeof record.runId === "string"
    && typeof record.parentSessionId === "string"
    && typeof record.parentSessionFile === "string"
    && record.parentSessionFile.length > 0
    && typeof record.parentInstanceId === "string"
    && record.parentInstanceId.length > 0
    && typeof record.parentProcessId === "number"
    && Number.isSafeInteger(record.parentProcessId)
    && record.parentProcessId > 0
    && isProfileName(record.profile)
    && typeof record.artifactPath === "string"
    && record.artifactPath.length > 0
    && typeof record.createdAt === "number"
    && Number.isFinite(record.createdAt)
    && (record.ownerState === "active" || record.ownerState === "released");
}

export function resolveRecoveryRoot(agentDir: string): string {
  if (!agentDir) throw new Error("Invalid agent directory");
  return resolve(agentDir, RECOVERY_DIRECTORY);
}

export function resolveRecoveryLocatorLocation(identity: RecoveryLocatorIdentity): RecoveryLocatorLocation {
  validateIdentifier("parent session ID", identity.parentSessionId);
  validateIdentifier("run ID", identity.runId);
  const root = resolveRecoveryRoot(identity.agentDir);
  const directory = resolve(root, identity.parentSessionId);
  const path = resolve(directory, `${identity.runId}.json`);
  assertContained(root, directory);
  assertContained(directory, path);
  return { root, directory, path };
}

async function statIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requirePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Recovery locator directory is not a real directory: ${path}`);
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function serializePath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = updateQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  updateQueues.set(path, next);
  try {
    return await next;
  } finally {
    if (updateQueues.get(path) === next) updateQueues.delete(path);
  }
}

async function writeLocatorFile(
  identity: RecoveryLocatorIdentity,
  record: RecoveryLocatorRecord,
  operations: RecoveryLocatorOperations,
): Promise<void> {
  const location = resolveRecoveryLocatorLocation(identity);
  if (record.runId !== identity.runId || record.parentSessionId !== identity.parentSessionId) {
    throw new Error("Recovery locator identity does not match record");
  }

  await requirePrivateDirectory(location.root);
  await requirePrivateDirectory(location.directory);

  const targetStats = await statIfPresent(location.path);
  if (targetStats?.isSymbolicLink()) throw new Error(`Recovery locator target is a symbolic link: ${location.path}`);
  if (targetStats && !targetStats.isFile()) throw new Error(`Recovery locator target is not a regular file: ${location.path}`);

  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const tempPath = resolve(location.directory, `.${identity.runId}.${process.pid}.${randomUUID()}.tmp`);
  assertContained(location.directory, tempPath);

  let tempMayExist = false;
  try {
    tempMayExist = true;
    await operations.writeFile(tempPath, contents, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
      flag: "wx",
    });
    await operations.rename(tempPath, location.path);
    tempMayExist = false;
    await chmod(location.path, PRIVATE_FILE_MODE);
  } finally {
    if (tempMayExist) await unlink(tempPath).catch(() => undefined);
  }
}

export function createRecoveryLocator(
  agentDir: string,
  input: RecoveryLocatorWriteInput,
  operations: RecoveryLocatorOperations = defaultOperations,
): Promise<RecoveryLocatorRecord> {
  const identity = {
    agentDir,
    parentSessionId: input.parentSessionId,
    runId: input.runId,
  };
  const location = resolveRecoveryLocatorLocation(identity);
  const record: RecoveryLocatorRecord = {
    schemaVersion: RECOVERY_LOCATOR_SCHEMA_VERSION,
    runId: input.runId,
    parentSessionId: input.parentSessionId,
    parentSessionFile: input.parentSessionFile,
    parentInstanceId: input.parentInstanceId,
    parentProcessId: input.parentProcessId,
    profile: input.profile,
    artifactPath: input.artifactPath,
    createdAt: input.createdAt,
    ownerState: input.ownerState ?? "active",
  };
  if (!isRecoveryLocatorRecord(record)) throw new Error("Invalid recovery locator record");
  return serializePath(location.path, async () => {
    await writeLocatorFile(identity, record, operations);
    return { ...record };
  });
}

export function updateRecoveryLocatorOwnerState(
  agentDir: string,
  identity: Omit<RecoveryLocatorIdentity, "agentDir">,
  ownerState: RecoveryLocatorOwnerState,
  operations: RecoveryLocatorOperations = defaultOperations,
): Promise<RecoveryLocatorRecord> {
  const fullIdentity = { agentDir, ...identity };
  const location = resolveRecoveryLocatorLocation(fullIdentity);
  return serializePath(location.path, async () => {
    const existing = await readRecoveryLocator(agentDir, identity);
    if (!existing) throw new Error(`Recovery locator is missing: ${location.path}`);
    const record: RecoveryLocatorRecord = { ...existing, ownerState };
    await writeLocatorFile(fullIdentity, record, operations);
    return { ...record };
  });
}

export function deleteRecoveryLocator(
  agentDir: string,
  identity: Omit<RecoveryLocatorIdentity, "agentDir">,
  operations: RecoveryLocatorOperations = defaultOperations,
): Promise<boolean> {
  const fullIdentity = { agentDir, ...identity };
  const location = resolveRecoveryLocatorLocation(fullIdentity);
  return serializePath(location.path, async () => {
    const stats = await statIfPresent(location.path);
    if (!stats) return false;
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Recovery locator target is not a regular file: ${location.path}`);
    }
    await operations.unlink(location.path);
    return true;
  });
}

export async function readRecoveryLocator(
  agentDir: string,
  identity: Omit<RecoveryLocatorIdentity, "agentDir">,
): Promise<RecoveryLocatorRecord | undefined> {
  const location = resolveRecoveryLocatorLocation({ agentDir, ...identity });
  const stats = await statIfPresent(location.path);
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Recovery locator target is not a regular file: ${location.path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(location.path, "utf8"));
  } catch (error) {
    throw new Error(`Recovery locator is malformed: ${location.path}`, { cause: error });
  }
  if (!isRecoveryLocatorRecord(parsed)) {
    throw new Error(`Recovery locator is malformed: ${location.path}`);
  }
  if (parsed.runId !== identity.runId || parsed.parentSessionId !== identity.parentSessionId) {
    throw new Error(`Recovery locator identity mismatch: ${location.path}`);
  }
  return { ...parsed };
}

export async function enumerateRecoveryLocators(agentDir: string): Promise<EnumeratedRecoveryLocator[]> {
  const root = resolveRecoveryRoot(agentDir);
  const rootStats = await statIfPresent(root);
  if (!rootStats) return [];
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Recovery locator root is not a real directory: ${root}`);
  }

  const parentEntries = (await readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const results: EnumeratedRecoveryLocator[] = [];

  for (const parentEntry of parentEntries) {
    if (parentEntry.name.startsWith(".")) continue;
    let parentSessionId: string;
    let directory: string;
    try {
      validateIdentifier("parent session ID", parentEntry.name);
      parentSessionId = parentEntry.name;
      directory = resolve(root, parentSessionId);
      assertContained(root, directory);
    } catch {
      continue;
    }

    const directoryStats = await statIfPresent(directory);
    if (!directoryStats || directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) continue;
    if (directory !== resolve(root, parentEntry.name)) continue;

    const fileEntries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const fileEntry of fileEntries) {
      if (fileEntry.name.startsWith(".") || !fileEntry.name.endsWith(".json")) continue;
      if (fileEntry.isDirectory()) continue;
      const runId = fileEntry.name.slice(0, -".json".length);
      let location: RecoveryLocatorLocation;
      try {
        location = resolveRecoveryLocatorLocation({ agentDir, parentSessionId, runId });
      } catch {
        continue;
      }
      if (location.directory !== directory || location.path !== resolve(directory, fileEntry.name)) continue;
      const stats = await statIfPresent(location.path);
      if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
        results.push({
          parentSessionId,
          runId,
          path: location.path,
          error: "locator is not a regular file",
        });
        continue;
      }
      try {
        const record = await readRecoveryLocator(agentDir, { parentSessionId, runId });
        if (!record) {
          results.push({ parentSessionId, runId, path: location.path, error: "locator disappeared during read" });
          continue;
        }
        results.push({ parentSessionId, runId, path: location.path, record });
      } catch (error) {
        results.push({
          parentSessionId,
          runId,
          path: location.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}
