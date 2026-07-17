import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { recoverActiveBranchOwnership, type OwnershipJournalData, type PiBranchEntry } from "../runtime/ownership.ts";

export const FAILURE_EVIDENCE_CUSTOM_TYPE = "herdr-subagents.failure.v1" as const;

export interface FailureEvidenceV1 {
  readonly schemaVersion: 1;
  readonly failureId: string;
  readonly runId: string;
  readonly runNonce: string;
  readonly parentSessionId: string;
  readonly parentSessionPath?: string;
  readonly branchEntryId: string;
  readonly reasonSha256: string;
  readonly recordedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function digest(input: Omit<FailureEvidenceV1, "schemaVersion" | "failureId" | "recordedAt">): string {
  return `fail-${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex").slice(0, 32)}`;
}

export function parseFailureEvidence(value: unknown): FailureEvidenceV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("failure evidence is malformed");
  const known = new Set(["schemaVersion", "failureId", "runId", "runNonce", "parentSessionId", "parentSessionPath", "branchEntryId", "reasonSha256", "recordedAt"]);
  if (Object.keys(value).some((key) => !known.has(key))) throw new Error("failure evidence contains an unknown field");
  for (const key of ["failureId", "runId", "runNonce", "parentSessionId", "branchEntryId", "reasonSha256"] as const) {
    if (!nonEmpty(value[key])) throw new Error(`failure evidence ${key} is malformed`);
  }
  if (value.parentSessionPath !== undefined && !nonEmpty(value.parentSessionPath)) throw new Error("failure evidence parentSessionPath is malformed");
  if (!Number.isSafeInteger(value.recordedAt) || (value.recordedAt as number) < 0) throw new Error("failure evidence recordedAt is malformed");
  if (!/^[a-f0-9]{64}$/.test(value.reasonSha256 as string)) throw new Error("failure evidence reasonSha256 is malformed");
  const evidence = value as unknown as FailureEvidenceV1;
  const expected = digest({
    runId: evidence.runId,
    runNonce: evidence.runNonce,
    parentSessionId: evidence.parentSessionId,
    ...(evidence.parentSessionPath === undefined ? {} : { parentSessionPath: evidence.parentSessionPath }),
    branchEntryId: evidence.branchEntryId,
    reasonSha256: evidence.reasonSha256,
  });
  if (evidence.failureId !== expected) throw new Error("failure evidence ID does not match its immutable identity");
  return evidence;
}

function journalMatches(journal: OwnershipJournalData, expected: FailureEvidenceV1): boolean {
  return journal.runId === expected.runId
    && journal.runNonce === expected.runNonce
    && journal.parent.sessionId === expected.parentSessionId
    && journal.parent.sessionPath === expected.parentSessionPath
    && journal.parent.branchEntryId === expected.branchEntryId
    && journal.phase === "failed";
}

export function findPersistedFailureEvidence(
  branch: readonly PiBranchEntry[],
  expected: Pick<FailureEvidenceV1, "runId" | "runNonce" | "parentSessionId" | "parentSessionPath" | "branchEntryId"> & { readonly failureId?: string },
): SessionEntry | undefined {
  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index]!;
    if (entry.type !== "custom" || entry.customType !== FAILURE_EVIDENCE_CUSTOM_TYPE) continue;
    let evidence: FailureEvidenceV1;
    try { evidence = parseFailureEvidence(entry.data); } catch { continue; }
    if (evidence.runId !== expected.runId || evidence.runNonce !== expected.runNonce
      || evidence.parentSessionId !== expected.parentSessionId
      || evidence.parentSessionPath !== expected.parentSessionPath
      || evidence.branchEntryId !== expected.branchEntryId
      || (expected.failureId !== undefined && evidence.failureId !== expected.failureId)) continue;
    const prior = branch[index - 1];
    if (!prior || entry.parentId !== prior.id) continue;
    const ownership = recoverActiveBranchOwnership(branch.slice(0, index)).get(evidence.runId);
    if (ownership?.state !== "owned" || !journalMatches(ownership.journal, evidence)) continue;
    return entry as SessionEntry;
  }
  return undefined;
}

export function appendFailureEvidence(input: {
  readonly pi: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly journal: OwnershipJournalData;
  readonly reason: string;
  readonly now?: () => number;
}): FailureEvidenceV1 | undefined {
  const { context, journal } = input;
  if (journal.phase !== "failed") return undefined;
  const sessionId = context.sessionManager.getSessionId();
  const sessionPath = context.sessionManager.getSessionFile();
  if (journal.parent.sessionId !== sessionId || journal.parent.sessionPath !== sessionPath) return undefined;
  const branch = context.sessionManager.getBranch() as readonly PiBranchEntry[];
  const ownership = recoverActiveBranchOwnership(branch).get(journal.runId);
  if (ownership?.state !== "owned" || JSON.stringify(ownership.journal) !== JSON.stringify(journal)) return undefined;
  const immutable = {
    runId: journal.runId,
    runNonce: journal.runNonce,
    parentSessionId: journal.parent.sessionId,
    ...(journal.parent.sessionPath === undefined ? {} : { parentSessionPath: journal.parent.sessionPath }),
    branchEntryId: journal.parent.branchEntryId,
    reasonSha256: createHash("sha256").update(input.reason, "utf8").digest("hex"),
  };
  const evidence: FailureEvidenceV1 = {
    schemaVersion: 1,
    failureId: digest(immutable),
    ...immutable,
    recordedAt: (input.now ?? Date.now)(),
  };
  const existing = findPersistedFailureEvidence(branch, { ...immutable, failureId: evidence.failureId });
  if (!existing) input.pi.appendEntry(FAILURE_EVIDENCE_CUSTOM_TYPE, evidence);
  return evidence;
}
