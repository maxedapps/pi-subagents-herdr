import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactKind, ArtifactReference, ArtifactWriter } from "../contracts/artifact.ts";
import type { AgentProfile } from "../contracts/profile.ts";
import type { Diagnostic } from "../contracts/result.ts";
import type { ArtifactRoots } from "./paths.ts";
import { assertArtifactPathAllowed } from "./paths.ts";
import { readArtifactSafe, writeArtifactExclusiveOrVerifyExact } from "./store.ts";

export interface ArtifactWriterResolution {
  readonly writer: ArtifactWriter;
  readonly parentMustValidate: true;
  readonly parentWrapperRequired: true;
}

export function resolveArtifactWriter(
  profile: AgentProfile,
  effectiveMutationCapable: boolean,
): ArtifactWriterResolution {
  const writer = profile.artifacts?.writer ?? "parent";
  if (writer === "child" && !effectiveMutationCapable) {
    throw new Error(`Profile ${profile.name} cannot use artifacts.writer=child without effective mutation capability`);
  }
  return { writer, parentMustValidate: true, parentWrapperRequired: true };
}

export interface MaterializeHandoffOptions {
  readonly profile: AgentProfile;
  readonly effectiveMutationCapable: boolean;
  readonly handoffPath: string;
  readonly roots: ArtifactRoots;
  readonly finalOutput: string;
  /** Full delegated assignment moved from run metadata into final handoff. */
  readonly assignment: string;
}

export interface MaterializedHandoff {
  readonly path: string;
  readonly writer: "parent" | "parent-wrapper";
  readonly byteLength: number;
  readonly sha256: string;
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function contentText(data: Buffer, label: string): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { throw new Error(`${label} must be valid UTF-8 text`); }
  if (data.byteLength === 0 || text.trim().length === 0 || text.includes("\0")) {
    throw new Error(`${label} must contain non-whitespace text without NUL bytes`);
  }
  return text;
}

export function parentHandoffWrapperPath(path: string): string {
  const extension = extname(path);
  const stem = basename(path, extension);
  return join(dirname(path), `${stem}.parent${extension}`);
}

function finalHandoffText(assignment: string, heading: string, output: string): string {
  if (assignment.trim().length === 0 || assignment.includes("\0")) {
    throw new Error("Full delegated assignment is required for final handoff materialization");
  }
  if (output.trim().length === 0 || output.includes("\0")) {
    throw new Error("Final handoff requires non-empty text without NUL bytes");
  }
  return ["# Subagent handoff", "", "## Assignment", assignment, "", `## ${heading}`, output].join("\n");
}

/**
 * Materialize one deterministic parent-owned final handoff.
 * Parent writers use the provided final output. Child writers require a valid child handoff file
 * and wrap it — missing/invalid child content fails closed (no invented substitute body).
 */
export async function materializeHandoff(options: MaterializeHandoffOptions): Promise<MaterializedHandoff> {
  const resolution = resolveArtifactWriter(options.profile, options.effectiveMutationCapable);
  const childOrParentPath = assertArtifactPathAllowed(resolve(options.handoffPath), options.roots);
  let capturePath = childOrParentPath;
  let heading = "Final output";
  let output = options.finalOutput;
  if (resolution.writer === "child") {
    capturePath = assertArtifactPathAllowed(parentHandoffWrapperPath(childOrParentPath), options.roots);
    output = contentText(await readArtifactSafe(childOrParentPath, options.roots), "Child handoff");
    heading = "Validated child handoff";
  }
  const content = Buffer.from(finalHandoffText(options.assignment, heading, output), "utf8");
  await writeArtifactExclusiveOrVerifyExact(capturePath, content, options.roots);
  const captured = await readArtifactSafe(capturePath, options.roots);
  contentText(captured, "Parent-owned final handoff");
  return {
    path: capturePath,
    writer: resolution.writer === "child" ? "parent-wrapper" : "parent",
    byteLength: captured.byteLength,
    sha256: digest(captured),
  };
}

export interface WorktreeArtifactToCapture {
  readonly kind: ArtifactKind;
  readonly sourcePath: string;
  readonly required: boolean;
}

export interface CaptureWorktreeArtifactsOptions {
  readonly artifacts: readonly WorktreeArtifactToCapture[];
  readonly sourceRoots: ArtifactRoots;
  readonly parentRoots: ArtifactRoots;
  /** Stable, run-unique extension ID used for the parent-owned capture path. */
  readonly runId: string;
}

export interface WorktreeCaptureResult {
  readonly verifiedForRemoval: boolean;
  readonly references: readonly ArtifactReference[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Copy required evidence out of a disposable worktree and verify destination
 * bytes and SHA-256 before a later phase may authorize worktree removal.
 */
export async function captureWorktreeArtifactsBeforeRemoval(
  options: CaptureWorktreeArtifactsOptions,
): Promise<WorktreeCaptureResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runId)) {
    throw new Error("Worktree artifact capture requires a safe run-unique runId");
  }
  const [sourceCheckout, parentCheckout] = await Promise.all([
    realpath(resolve(options.sourceRoots.checkout)),
    realpath(resolve(options.parentRoots.checkout)),
  ]);
  if (isWithin(sourceCheckout, parentCheckout) || isWithin(parentCheckout, sourceCheckout)) {
    throw new Error("Worktree artifact source and parent checkouts must be canonical, distinct, and non-overlapping");
  }
  const expectedSourceSubagents = join(sourceCheckout, ".subagents");
  const expectedParentSubagents = join(parentCheckout, ".subagents");
  if (resolve(options.sourceRoots.subagents) !== expectedSourceSubagents) {
    throw new Error("Worktree artifact source root must be the source checkout's .subagents directory");
  }
  if (resolve(options.parentRoots.subagents) !== expectedParentSubagents) {
    throw new Error("Worktree artifact capture destination must be the parent checkout's .subagents directory");
  }
  const sourceArtifactRoots = [
    expectedSourceSubagents,
    ...(options.sourceRoots.progress === undefined ? [] : [join(sourceCheckout, ".progress")]),
  ];
  const parentDirectory = join(expectedParentSubagents, "runs", options.runId, "captured");
  const references: ArtifactReference[] = [];
  const diagnostics: Diagnostic[] = [];
  let verifiedForRemoval = true;
  const usedNames = new Set<string>();

  for (const artifact of options.artifacts) {
    let source: Buffer;
    try {
      const sourcePath = assertArtifactPathAllowed(resolve(artifact.sourcePath), options.sourceRoots);
      if (!sourceArtifactRoots.some((root) => isWithin(root, sourcePath))) {
        throw new Error("source is not owned by the disposable checkout's artifact directories");
      }
      source = await readArtifactSafe(sourcePath, options.sourceRoots);
      if (artifact.required && (source.byteLength === 0 || source.toString("utf8").trim().length === 0)) {
        throw new Error("required artifact is empty");
      }
    } catch (error) {
      if (artifact.required) verifiedForRemoval = false;
      diagnostics.push({
        code: artifact.required ? "required-worktree-artifact-missing" : "optional-worktree-artifact-unavailable",
        message: `Could not capture ${artifact.kind} artifact ${artifact.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        path: artifact.sourcePath,
        severity: artifact.required ? "error" : "warning",
      });
      continue;
    }
    let name = `${artifact.kind}-${basename(artifact.sourcePath)}`;
    let suffix = 2;
    while (usedNames.has(name)) name = `${artifact.kind}-${suffix++}-${basename(artifact.sourcePath)}`;
    usedNames.add(name);
    const destination = join(parentDirectory, name);
    try {
      await writeArtifactExclusiveOrVerifyExact(destination, source, options.parentRoots);
    } catch (error) {
      verifiedForRemoval = false;
      diagnostics.push({
        code: "worktree-artifact-destination-collision",
        message: `Refused to overwrite retained capture ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        path: destination,
        severity: "error",
      });
      continue;
    }
    const copied = await readArtifactSafe(destination, options.parentRoots);
    const sourceHash = digest(source);
    const destinationHash = digest(copied);
    if (source.byteLength !== copied.byteLength || sourceHash !== destinationHash) {
      verifiedForRemoval = false;
      diagnostics.push({
        code: "worktree-artifact-verification-failed",
        message: `Captured artifact failed byte/hash verification: ${destination}`,
        path: destination,
        severity: "error",
      });
      continue;
    }
    references.push({
      kind: artifact.kind,
      path: artifact.sourcePath,
      writer: "parent",
      required: artifact.required,
      absolutePath: destination,
      capturedAt: Date.now(),
      byteLength: copied.byteLength,
      sha256: destinationHash,
    });
  }
  if (options.artifacts.some((artifact) => artifact.required) && !options.artifacts.filter((artifact) => artifact.required).every(
    (artifact) => references.some((reference) => reference.kind === artifact.kind && reference.path === artifact.sourcePath),
  )) verifiedForRemoval = false;
  return { verifiedForRemoval, references, diagnostics };
}
