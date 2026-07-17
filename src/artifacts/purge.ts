import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseGenerationResultFileName } from "../results/store.ts";
import type { ArtifactRoots } from "./paths.ts";

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export interface RuntimePurgeResult {
  readonly purged: boolean;
  readonly directoryRemoved: boolean;
  readonly preservedCustomArtifacts: boolean;
  readonly reason: string;
}

async function inspectRuntimeRunArtifacts(roots: ArtifactRoots, runId: string, preservePaths: readonly string[]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Runtime artifact purge run id is unsafe");
  const directory = resolve(roots.subagents, "runs", runId);
  if (!within(roots.subagents, directory)) throw new Error("Runtime artifact purge path escapes .subagents");
  let rootInfo;
  try { rootInfo = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directory, absent: true as const, entries: [], preserved: new Set<string>() };
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Runtime run path is not a safe directory");
  const preserved = new Set<string>();
  for (const candidate of preservePaths) {
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { continue; }
    const info = await lstat(canonical);
    if (!info.isSymbolicLink() && within(directory, canonical) && canonical !== directory) preserved.add(canonical);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const isPreservedEntry = (path: string) => preserved.has(path) || [...preserved].some((candidate) => within(path, candidate));
  const allowedFiles = new Set(["run.json", "handoff.md", "handoff.parent.md", "progress.md"]);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Runtime run directory contains a symlink: ${entry.name}`);
    if (entry.isFile() && (allowedFiles.has(entry.name) || isPreservedEntry(join(directory, entry.name)))) continue;
    if (entry.isDirectory() && (entry.name === "results" || entry.name === "captured" || isPreservedEntry(join(directory, entry.name)))) continue;
    throw new Error(`Runtime run directory contains an unknown entry: ${entry.name}`);
  }
  const results = entries.find((entry) => entry.name === "results");
  if (results) {
    const resultEntries = await readdir(join(directory, "results"), { withFileTypes: true });
    for (const entry of resultEntries) {
      if (!entry.isFile() || entry.isSymbolicLink() || parseGenerationResultFileName(entry.name) === undefined) {
        throw new Error(`Runtime results directory contains an unsafe entry: ${entry.name}`);
      }
    }
  }
  return { directory, absent: false as const, entries, preserved, isPreservedEntry };
}

/** Validate the exact purge boundary without mutating any prior-session resource. */
export async function assertRuntimeRunArtifactsPurgeSafe(roots: ArtifactRoots, runId: string, preservePaths: readonly string[] = []): Promise<void> {
  await inspectRuntimeRunArtifacts(roots, runId, preservePaths);
}

/** Remove only the exact run-bound operational layout; never follow symlinks or unknown entries. */
export async function purgeRuntimeRunArtifacts(roots: ArtifactRoots, runId: string, preservePaths: readonly string[] = []): Promise<RuntimePurgeResult> {
  const inspected = await inspectRuntimeRunArtifacts(roots, runId, preservePaths);
  if (inspected.absent) return { purged: true, directoryRemoved: true, preservedCustomArtifacts: false, reason: "Runtime run directory is already absent" };
  for (const entry of inspected.entries) {
    if (entry.name === "captured" || inspected.isPreservedEntry(join(inspected.directory, entry.name))) continue;
    await rm(join(inspected.directory, entry.name), { recursive: entry.isDirectory(), force: false });
  }
  const captured = inspected.entries.some((entry) => entry.name === "captured") || inspected.preserved.size > 0;
  if (!captured) await rmdir(inspected.directory);
  return {
    purged: true,
    directoryRemoved: !captured,
    preservedCustomArtifacts: captured,
    reason: captured ? "Operational metadata/results purged; verified custom captures preserved" : "Runtime run directory removed",
  };
}
