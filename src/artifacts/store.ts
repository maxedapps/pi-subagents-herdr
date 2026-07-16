import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactRoots } from "./paths.ts";
import { assertArtifactPathAllowed } from "./paths.ts";

export interface AtomicArtifactWriteOptions {
  readonly replace?: boolean;
  readonly mode?: number;
}

export type IdempotentArtifactWriteResult = "created" | "existing-exact";

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function allowedRoot(path: string, roots: ArtifactRoots): { root: string; creationBase: string } {
  const candidates = [
    { root: roots.subagents, creationBase: roots.checkout },
    ...(roots.progress === undefined ? [] : [{ root: roots.progress, creationBase: roots.checkout }]),
    ...roots.additional.map((root) => ({ root, creationBase: root })),
  ].filter((candidate) => isWithin(candidate.root, path));
  candidates.sort((left, right) => right.root.length - left.root.length);
  const selected = candidates[0];
  if (selected === undefined) throw new Error(`Artifact path is outside allowed roots: ${path}`);
  return selected;
}

async function infoOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertDirectoryComponent(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Artifact path traverses a symlink: ${path}`);
  if (!info.isDirectory()) throw new Error(`Artifact path component is not a directory: ${path}`);
}

/** Create one path component at a time and verify every component after creation. */
export async function ensureSafeArtifactDirectory(directory: string, roots: ArtifactRoots): Promise<string> {
  const absolute = assertArtifactPathAllowed(resolve(directory), roots);
  const selected = allowedRoot(absolute, roots);
  await assertDirectoryComponent(selected.creationBase);
  const rel = relative(selected.creationBase, absolute);
  const components = rel === "" ? [] : rel.split(sep);
  let current = selected.creationBase;
  for (const component of components) {
    if (component === "" || component === "." || component === "..") throw new Error("Unsafe artifact directory component");
    current = join(current, component);
    const existing = await infoOrUndefined(current);
    if (existing === undefined) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await assertDirectoryComponent(current);
  }
  const canonical = await realpath(absolute);
  const canonicalRoot = await realpath(selected.root);
  if (!isWithin(canonicalRoot, canonical)) throw new Error(`Artifact directory resolves outside its allowed root: ${absolute}`);
  return absolute;
}

async function revalidateParent(path: string, roots: ArtifactRoots): Promise<{ dev: bigint; ino: bigint }> {
  const parent = dirname(path);
  await ensureSafeArtifactDirectory(parent, roots);
  const parentInfo = await stat(parent, { bigint: true });
  const selected = allowedRoot(path, roots);
  const canonicalParent = await realpath(parent);
  const canonicalRoot = await realpath(selected.root);
  if (!isWithin(canonicalRoot, canonicalParent)) throw new Error(`Artifact parent escaped allowed root: ${parent}`);
  return { dev: parentInfo.dev, ino: parentInfo.ino };
}

async function rejectUnsafeTarget(path: string): Promise<void> {
  const existing = await infoOrUndefined(path);
  if (existing === undefined) return;
  if (existing.isSymbolicLink()) throw new Error(`Artifact target is a symlink: ${path}`);
  if (!existing.isFile()) throw new Error(`Artifact target is not a regular file: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeArtifactAtomic(
  path: string,
  data: string | Uint8Array,
  roots: ArtifactRoots,
  options: AtomicArtifactWriteOptions = {},
): Promise<string> {
  const absolute = assertArtifactPathAllowed(resolve(path), roots);
  const mode = options.mode ?? 0o600;
  const parentIdentity = await revalidateParent(absolute, roots);
  await rejectUnsafeTarget(absolute);

  if (options.replace !== true) {
    // Revalidate immediately before the exclusive, no-follow create.
    const immediate = await revalidateParent(absolute, roots);
    if (immediate.dev !== parentIdentity.dev || immediate.ino !== parentIdentity.ino) {
      throw new Error("Artifact parent changed before exclusive write");
    }
    const handle = await open(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(absolute));
    return absolute;
  }

  const temporary = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    temporaryExists = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Symlink state is mutable: inspect every component and target again at the
    // final mutation boundary rather than trusting resolution-time checks.
    const immediate = await revalidateParent(absolute, roots);
    if (immediate.dev !== parentIdentity.dev || immediate.ino !== parentIdentity.ino) {
      throw new Error("Artifact parent changed before atomic rename");
    }
    await rejectUnsafeTarget(absolute);
    const tempInfo = await lstat(temporary);
    if (!tempInfo.isFile() || tempInfo.isSymbolicLink()) throw new Error("Atomic artifact temporary file changed unexpectedly");
    await rename(temporary, absolute);
    temporaryExists = false;
    await syncDirectory(dirname(absolute));
    return absolute;
  } finally {
    if (temporaryExists) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Create once, or accept an existing regular file only when its bytes are exact. */
export async function writeArtifactExclusiveOrVerifyExact(
  path: string,
  data: string | Uint8Array,
  roots: ArtifactRoots,
  options: Pick<AtomicArtifactWriteOptions, "mode"> = {},
): Promise<IdempotentArtifactWriteResult> {
  try {
    await writeArtifactAtomic(path, data, roots, options);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const expected = Buffer.from(data);
  const existing = await readArtifactSafe(path, roots);
  if (!existing.equals(expected)) {
    throw new Error(`Artifact collision: existing evidence differs at ${resolve(path)}`);
  }
  return "existing-exact";
}

export async function readArtifactSafe(path: string, roots: ArtifactRoots): Promise<Buffer> {
  const absolute = assertArtifactPathAllowed(resolve(path), roots);
  await revalidateParent(absolute, roots);
  await rejectUnsafeTarget(absolute);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Artifact source is not a regular file: ${absolute}`);
    const selected = allowedRoot(absolute, roots);
    const canonical = await realpath(absolute);
    const canonicalRoot = await realpath(selected.root);
    if (!isWithin(canonicalRoot, canonical)) throw new Error(`Artifact source escaped allowed root: ${absolute}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
