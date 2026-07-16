import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { ArtifactKind, ArtifactReference } from "../contracts/artifact.ts";
import {
  captureWorktreeArtifactsBeforeRemoval,
  type CaptureWorktreeArtifactsOptions,
  type WorktreeCaptureResult,
} from "../artifacts/handoff.ts";
import { readArtifactSafe } from "../artifacts/store.ts";
import type { ArtifactRoots } from "../artifacts/paths.ts";

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export interface VerifiedWorktreeCapture extends WorktreeCaptureResult {
  readonly requiredKinds: readonly ArtifactKind[];
}

/** Capture required handoff evidence and any configured optional progress before removal. */
export async function captureWriterArtifacts(
  options: CaptureWorktreeArtifactsOptions,
  requiredKinds: readonly ArtifactKind[] = ["handoff"],
): Promise<VerifiedWorktreeCapture> {
  const requiredInputsPresent = requiredKinds.every((kind) => options.artifacts.some((artifact) => artifact.kind === kind && artifact.required));
  const capture = await captureWorktreeArtifactsBeforeRemoval(options);
  const requiredReferencesPresent = requiredKinds.every((kind) => capture.references.some((reference) => reference.kind === kind
    && reference.required && reference.byteLength !== undefined && reference.byteLength > 0 && reference.sha256 !== undefined));
  return { ...capture, verifiedForRemoval: capture.verifiedForRemoval && requiredInputsPresent && requiredReferencesPresent, requiredKinds };
}

export async function verifyRetainedArtifactCapture(input: {
  readonly references: readonly ArtifactReference[];
  readonly parentRoots: ArtifactRoots;
  readonly disposableCheckoutPath: string;
  readonly requiredKinds?: readonly ArtifactKind[];
}): Promise<{ verified: boolean; reason: string }> {
  const requiredKinds = input.requiredKinds ?? ["handoff"];
  for (const kind of requiredKinds) {
    const reference = input.references.find((candidate) => candidate.kind === kind && candidate.required);
    if (!reference?.absolutePath || reference.byteLength === undefined || reference.byteLength <= 0 || reference.sha256 === undefined) return { verified: false, reason: `Required non-empty parent-owned ${kind} capture metadata is missing` };
    if (isWithin(input.disposableCheckoutPath, reference.absolutePath)) return { verified: false, reason: `Required ${kind} capture still resides in the disposable checkout` };
    let bytes: Buffer;
    try { bytes = await readArtifactSafe(reference.absolutePath, input.parentRoots); }
    catch (error) { return { verified: false, reason: `Required ${kind} capture cannot be read safely: ${error instanceof Error ? error.message : String(error)}` }; }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== reference.byteLength || digest !== reference.sha256) return { verified: false, reason: `Required ${kind} capture no longer matches its verified byte/hash evidence` };
  }
  return { verified: true, reason: "Required parent-owned handoff capture still matches verified byte/hash evidence" };
}
