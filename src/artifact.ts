import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isProfileName, type ProfileName } from "./profiles.ts";

const ARTIFACT_DIRECTORY = "herdr-subagent-artifacts";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const updateQueues = new Map<string, Promise<void>>();

export interface ArtifactIdentity {
  agentDir: string;
  parentSessionId: string;
  runId: string;
}

export interface ArtifactLocation {
  directory: string;
  path: string;
}

export interface RunArtifact {
  runId: string;
  path: string;
}

export type ArtifactProfile = ProfileName;

export interface WorkerArtifactFacts {
  path?: string;
  branch?: string;
  workspaceId?: string;
}

export interface ArtifactHeader {
  runId: string;
  profile: ArtifactProfile;
  worker?: WorkerArtifactFacts;
}

export interface GenerationSection {
  generation: number;
  speaker: "Parent" | "Subagent";
  body: string;
}

export interface AbortedGenerationSection {
  generation: number;
}

export interface CleanupSection {
  state: "removed" | "action required" | "finalized";
  reason?: string;
  retained?: readonly string[];
  next?: string;
}

export interface ArtifactUpdateOperations {
  writeFile(
    path: string,
    contents: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const defaultUpdateOperations: ArtifactUpdateOperations = { writeFile, rename };

function validateIdentifier(label: string, value: string): void {
  if (!value || value === "." || value === ".." || /[\\/\0-\x1f\x7f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error("Artifact path escapes its root");
  }
}

export function resolveArtifactDirectory(agentDir: string, parentSessionId: string): string {
  if (!agentDir) throw new Error("Invalid agent directory");
  validateIdentifier("parent session ID", parentSessionId);
  const root = resolve(agentDir, ARTIFACT_DIRECTORY);
  const directory = resolve(root, parentSessionId);
  assertContained(root, directory);
  return directory;
}

export function resolveArtifactLocation(identity: ArtifactIdentity): ArtifactLocation {
  validateIdentifier("run ID", identity.runId);
  const directory = resolveArtifactDirectory(identity.agentDir, identity.parentSessionId);
  const path = resolve(directory, `${identity.runId}.md`);
  assertContained(directory, path);
  return { directory, path };
}

export async function enumerateRunArtifacts(agentDir: string, parentSessionId: string): Promise<RunArtifact[]> {
  const directory = resolveArtifactDirectory(agentDir, parentSessionId);
  let entries;
  try {
    const rootStats = await lstat(dirname(directory));
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error(`Artifact root is not a real directory: ${dirname(directory)}`);
    }
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error(`Artifact directory is not a real directory: ${directory}`);
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const artifacts: RunArtifact[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const runId = entry.name.slice(0, -3);
    let location: ArtifactLocation;
    try {
      location = resolveArtifactLocation({ agentDir, parentSessionId, runId });
    } catch {
      continue;
    }
    if (location.directory !== directory || location.path !== resolve(directory, entry.name)) continue;
    const stats = await lstat(location.path);
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    artifacts.push({ runId, path: location.path });
  }
  return artifacts;
}

export function renderArtifactHeader(header: ArtifactHeader): string {
  validateIdentifier("run ID", header.runId);
  if (!isProfileName(header.profile)) throw new Error("Invalid artifact profile");

  const lines = [`# Herdr subagent ${header.runId}`, `- Profile: ${header.profile}`];
  if (header.worker?.path !== undefined) lines.push(`- Worktree: ${header.worker.path}`);
  if (header.worker?.branch !== undefined) lines.push(`- Branch: ${header.worker.branch}`);
  if (header.worker?.workspaceId !== undefined) lines.push(`- Workspace: ${header.worker.workspaceId}`);
  return `${lines.join("\n")}\n`;
}

function longestBacktickRun(body: string): number {
  let longest = 0;
  for (const match of body.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return longest;
}

function validateGenerationNumber(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Invalid generation number");
  }
}

export function renderGenerationSection(section: GenerationSection): string {
  validateGenerationNumber(section.generation);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(section.body) + 1));
  return `\n## Generation ${section.generation} — ${section.speaker}\n${fence}text\n${section.body}\n${fence}\n`;
}

export function renderAbortedGenerationSection(section: AbortedGenerationSection): string {
  validateGenerationNumber(section.generation);
  return `\n## Generation ${section.generation} — Aborted\n- Explicitly stopped before a final result.\n`;
}

export function renderCleanupSection(section: CleanupSection): string {
  const lines = ["", "## Cleanup", `- State: ${section.state}`];
  if (section.reason !== undefined) lines.push(`- Reason: ${section.reason}`);
  for (const fact of section.retained ?? []) lines.push(`- Retained: ${fact}`);
  if (section.next !== undefined) lines.push(`- Next: ${section.next}`);
  return `${lines.join("\n")}\n`;
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
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Artifact directory is not a real directory: ${path}`);
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function performUpdate(
  identity: ArtifactIdentity,
  location: ArtifactLocation,
  renderedSection: string,
  operations: ArtifactUpdateOperations,
): Promise<void> {
  const root = resolve(identity.agentDir, ARTIFACT_DIRECTORY);
  await requirePrivateDirectory(root);
  await requirePrivateDirectory(location.directory);

  const targetStats = await statIfPresent(location.path);
  if (targetStats?.isSymbolicLink()) throw new Error(`Artifact target is a symbolic link: ${location.path}`);
  if (targetStats && !targetStats.isFile()) throw new Error(`Artifact target is not a regular file: ${location.path}`);

  const prior = targetStats ? await readFile(location.path, "utf8") : "";
  if (prior.endsWith(renderedSection)) return;
  const tempPath = resolve(location.directory, `.${identity.runId}.${process.pid}.${randomUUID()}.tmp`);
  assertContained(location.directory, tempPath);

  let tempMayExist = false;
  try {
    tempMayExist = true;
    await operations.writeFile(tempPath, prior + renderedSection, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
      flag: "wx",
    });
    await operations.rename(tempPath, location.path);
    tempMayExist = false;
  } finally {
    if (tempMayExist) await unlink(tempPath).catch(() => undefined);
  }
}

export function appendArtifactSection(
  identity: ArtifactIdentity,
  renderedSection: string,
  operations: ArtifactUpdateOperations = defaultUpdateOperations,
): Promise<void> {
  const location = resolveArtifactLocation(identity);
  const previous = updateQueues.get(location.path) ?? Promise.resolve();
  const update = previous.catch(() => undefined).then(() => performUpdate(identity, location, renderedSection, operations));
  updateQueues.set(location.path, update);
  return update.finally(() => {
    if (updateQueues.get(location.path) === update) updateQueues.delete(location.path);
  });
}
