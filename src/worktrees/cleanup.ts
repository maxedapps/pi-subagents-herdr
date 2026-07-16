import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { CaptureWorktreeArtifactsOptions } from "../artifacts/handoff.ts";
import type { ArtifactRoots } from "../artifacts/paths.ts";
import { HERDR_PROTOCOL_VERSION, MINIMUM_HERDR_VERSION } from "../contracts/protocol.ts";
import type { HerdrRequestClient } from "../herdr/client.ts";
import { processBaseline } from "../runtime/groups.ts";
import type {
  HumanDiscardDecision,
  ObjectiveIntegrationEvidence,
  ParentBranchProof,
  WorktreeRecord,
} from "./contracts.ts";
import { captureWriterArtifacts, verifyRetainedArtifactCapture } from "./artifacts.ts";
import { WorktreeRegistry } from "./manager.ts";
import { identifyCheckout } from "./writer-locks.ts";

const execFileAsync = promisify(execFile);

async function git(checkout: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 1_000_000 });
  return result.stdout.trim();
}

async function gitExit(checkout: string, args: readonly string[]): Promise<boolean> {
  try { await execFileAsync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 1_000_000 }); return true; }
  catch (error) { if (typeof (error as { code?: unknown }).code === "number") return false; throw error; }
}

function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): readonly number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const left = parse(actual); const right = parse(minimum);
  if (!left || !right || actual.includes("-")) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

export type IntegrationVerificationRequest =
  | { readonly kind: "no_changes" }
  | { readonly kind: "commit_contained"; readonly parentCheckoutPath: string; readonly parentRef?: string }
  | { readonly kind: "tree_matches"; readonly parentCheckoutPath: string; readonly parentRef?: string };

/** Derive integration from Git object identity; no caller assertion is accepted as proof. */
export async function verifyObjectiveIntegration(
  record: WorktreeRecord,
  request: IntegrationVerificationRequest,
): Promise<ObjectiveIntegrationEvidence> {
  const childIdentity = await identifyCheckout(record.checkoutPath);
  if (childIdentity.repositoryId !== record.repositoryId || childIdentity.commonGitDir !== record.commonGitDir) throw new Error("Disposable checkout no longer matches canonical repository identity");
  const childHead = await git(record.checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (request.kind === "no_changes") {
    const status = await git(record.checkoutPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.length !== 0 || childHead !== record.base) throw new Error("Worktree has commits or filesystem changes; integration is required");
    return { kind: "no_changes", verifiedAt: Date.now(), childHead, baseCommit: record.base };
  }
  const parentCheckoutPath = (await identifyCheckout(request.parentCheckoutPath)).checkoutPath;
  const parentIdentity = await identifyCheckout(parentCheckoutPath);
  if (parentIdentity.repositoryId !== record.repositoryId || parentIdentity.commonGitDir !== record.commonGitDir) throw new Error("Parent integration checkout belongs to a different canonical repository");
  const parentHead = await git(parentCheckoutPath, ["rev-parse", "--verify", `${request.parentRef ?? "HEAD"}^{commit}`]);
  if (request.kind === "commit_contained") {
    if (!await gitExit(parentCheckoutPath, ["merge-base", "--is-ancestor", childHead, parentHead])) throw new Error("Parent commit does not contain the child worktree HEAD");
    return { kind: "commit_contained", verifiedAt: Date.now(), childHead, parentHead, parentCheckoutPath };
  }
  const [childTree, parentTree] = await Promise.all([
    git(record.checkoutPath, ["rev-parse", "--verify", `${childHead}^{tree}`]),
    git(parentCheckoutPath, ["rev-parse", "--verify", `${parentHead}^{tree}`]),
  ]);
  if (childTree !== parentTree) throw new Error("Parent and child commit trees do not match");
  return { kind: "tree_matches", verifiedAt: Date.now(), childTree, parentTree, parentHead, parentCheckoutPath };
}

export interface WorktreeOwnershipAuthorization {
  readonly runId: string;
  readonly runNonce: string;
  readonly parent: ParentBranchProof;
  readonly activeBranchState: "owned";
}

function assertOwnership(record: WorktreeRecord, authorization: WorktreeOwnershipAuthorization): void {
  if (authorization.activeBranchState !== "owned" || authorization.runId !== record.owner.runId || authorization.runNonce !== record.owner.runNonce
    || JSON.stringify(authorization.parent) !== JSON.stringify(record.owner.parent)) {
    throw new Error("Current active-branch ownership proof does not exactly match the extension-owned worktree");
  }
}

async function verifyNoLiveOrUnknownChildren(client: HerdrRequestClient, record: WorktreeRecord, signal?: AbortSignal): Promise<void> {
  const ping = await client.ping(signal);
  if (ping.protocol !== HERDR_PROTOCOL_VERSION || !semverAtLeast(ping.version, MINIMUM_HERDR_VERSION)) throw new Error(`Compatible Herdr is unavailable (${ping.version}/protocol ${ping.protocol})`);
  const snapshot = await client.snapshot(signal);
  if (snapshot.protocol !== HERDR_PROTOCOL_VERSION) throw new Error("Herdr snapshot protocol is incompatible");
  if (record.writer) {
    const pane = snapshot.panes.find((candidate) => candidate.terminal_id === record.writer!.terminalId);
    const agent = snapshot.agents.find((candidate) => candidate.terminal_id === record.writer!.terminalId);
    const native = snapshot.agents.find((candidate) => candidate.agent_session?.kind === record.writer!.nativeSession.kind
      && candidate.agent_session.value === record.writer!.nativeSession.value && candidate.agent_session.source === record.writer!.nativeSession.source);
    if (pane || agent || native) throw new Error("Bound writer terminal/native session is still live or uncertain");
  }
  const workspaceAgents = snapshot.agents.filter((candidate) => candidate.workspace_id === record.workspaceId);
  if (workspaceAgents.length !== 0) throw new Error("Worktree workspace still contains a live or detected agent");
  const anchors = [record.createdRoot, ...(record.tab ? [record.tab] : [])];
  const allowedAnchors = new Set(anchors.map((anchor) => anchor.rootTerminalId));
  const unknownPanes = snapshot.panes.filter((candidate) => candidate.workspace_id === record.workspaceId && !allowedAnchors.has(candidate.terminal_id));
  if (unknownPanes.length !== 0) throw new Error("Worktree workspace contains an unknown/non-anchor pane");
  for (const anchor of anchors) {
    if (!anchor.rootProcessBaseline) throw new Error(`Anchor ${anchor.rootTerminalId} has no persisted process baseline`);
    const pane = snapshot.panes.find((candidate) => candidate.workspace_id === record.workspaceId && candidate.terminal_id === anchor.rootTerminalId);
    if (!pane || pane.tab_id !== anchor.tabId) throw new Error(`Anchor ${anchor.rootTerminalId} is absent or moved out of its recorded tab`);
    const current = processBaseline(await client.getPaneProcessInfo(pane.pane_id, signal));
    if (current !== anchor.rootProcessBaseline) throw new Error(`Anchor ${anchor.rootTerminalId} process baseline changed; unknown foreground state retained`);
  }
}

async function ensureArtifacts(input: {
  readonly registry: WorktreeRegistry;
  readonly record: WorktreeRecord;
  readonly capture: CaptureWorktreeArtifactsOptions;
  readonly parentRoots: ArtifactRoots;
}): Promise<WorktreeRecord> {
  const [captureSource, captureParent, suppliedParent] = await Promise.all([
    realpath(resolve(input.capture.sourceRoots.checkout)),
    realpath(resolve(input.capture.parentRoots.checkout)),
    realpath(resolve(input.parentRoots.checkout)),
  ]);
  if (input.capture.runId !== input.record.id) throw new Error("Artifact capture run id is not bound to the worktree record");
  if (captureSource !== input.record.checkoutPath) throw new Error("Artifact capture source checkout is not bound to the disposable worktree record");
  if (captureParent !== input.record.sourceCheckoutPath || suppliedParent !== input.record.sourceCheckoutPath) throw new Error("Artifact capture destination is not bound to the record source checkout");
  const requested = input.capture.artifacts.map((artifact) => ({ kind: artifact.kind, sourcePath: resolve(artifact.sourcePath), required: artifact.required }));
  const recorded = input.record.artifactPaths.map((artifact) => ({ kind: artifact.kind, sourcePath: artifact.absolutePath, required: artifact.required }));
  if (JSON.stringify(requested) !== JSON.stringify(recorded)) throw new Error("Artifact capture paths/required flags do not exactly match durable worktree state");
  if (input.record.artifactsCaptured) {
    const existing = await verifyRetainedArtifactCapture({ references: input.record.capturedArtifacts, parentRoots: input.parentRoots, disposableCheckoutPath: input.record.checkoutPath });
    if (!existing.verified) throw new Error(existing.reason);
    return input.record;
  }
  const capture = await captureWriterArtifacts(input.capture);
  if (!capture.verifiedForRemoval) throw new Error(`Required non-empty parent-owned handoff capture failed: ${capture.diagnostics.map((item) => item.message).join("; ")}`);
  const recordedCapture = input.registry.setCapturedArtifacts(input.record.id, capture.references);
  const immediate = await verifyRetainedArtifactCapture({ references: recordedCapture.capturedArtifacts, parentRoots: input.parentRoots, disposableCheckoutPath: recordedCapture.checkoutPath });
  if (!immediate.verified) throw new Error(`Immediate retained artifact verification failed: ${immediate.reason}`);
  return recordedCapture;
}

function requestFromSavedEvidence(evidence: ObjectiveIntegrationEvidence): IntegrationVerificationRequest {
  switch (evidence.kind) {
    case "no_changes": return { kind: "no_changes" };
    case "commit_contained": return { kind: "commit_contained", parentCheckoutPath: evidence.parentCheckoutPath };
    case "tree_matches": return { kind: "tree_matches", parentCheckoutPath: evidence.parentCheckoutPath };
  }
}

async function assertClean(record: WorktreeRecord): Promise<void> {
  const status = await git(record.checkoutPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length !== 0) throw new Error(`Worktree checkout is dirty: ${status.split("\n").slice(0, 5).join(" | ")}`);
}

async function verifyHerdrRemovalIdentity(client: HerdrRequestClient, record: WorktreeRecord, signal?: AbortSignal): Promise<void> {
  const child = await identifyCheckout(record.checkoutPath);
  if (child.repositoryId !== record.repositoryId || child.commonGitDir !== record.commonGitDir || child.checkoutPath !== record.checkoutPath) throw new Error("Canonical checkout identity changed before removal");
  const [workspace, listed] = await Promise.all([
    client.getWorkspace(record.workspaceId, signal),
    client.listWorktrees({ cwd: record.sourceCheckoutPath }, signal),
  ]);
  const candidate = listed.worktrees.find((worktree) => resolve(worktree.path) === record.checkoutPath);
  if (!candidate || candidate.open_workspace_id !== record.workspaceId || candidate.branch !== record.branch || !candidate.is_linked_worktree) throw new Error("Herdr worktree list does not identity-match the extension-owned workspace/branch/path");
  if (listed.source.repo_key !== record.herdrRepositoryKey || workspace.workspace_id !== record.workspaceId || workspace.worktree?.repo_key !== record.herdrRepositoryKey
    || resolve(workspace.worktree.checkout_path) !== record.checkoutPath || !workspace.worktree.is_linked_worktree) throw new Error("Herdr workspace provenance does not identity-match the extension record");
}

export interface CleanupResult {
  readonly removed: boolean;
  readonly retained: boolean;
  readonly state: WorktreeRecord["state"];
  readonly reason: string;
  readonly record: WorktreeRecord;
}

export interface SafeCleanupInput {
  readonly id: string;
  readonly cleanup?: "retain" | "remove_if_safe";
  readonly ownership: WorktreeOwnershipAuthorization;
  readonly artifactCapture: CaptureWorktreeArtifactsOptions;
  readonly parentRoots: ArtifactRoots;
  readonly integrationEvidence?: IntegrationVerificationRequest;
  /** Optional caller-owned active-branch proof, rerun at the destructive boundary. */
  readonly revalidateOwnership?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

const HUMAN_DISCARD_TOKENS = new WeakSet<object>();
export interface HumanDiscardAuthorization {
  readonly decisionId: string;
  readonly worktreeId: string;
  readonly runNonce: string;
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly confirmedAt: number;
  readonly consequences: readonly string[];
}

export async function requestHumanDiscardAuthorization(input: {
  readonly record: WorktreeRecord;
  readonly confirm: (preview: {
    readonly title: string;
    readonly workspaceId: string;
    readonly checkoutPath: string;
    readonly branch: string;
    readonly consequences: readonly string[];
  }) => Promise<boolean>;
}): Promise<HumanDiscardAuthorization | undefined> {
  const consequences = [
    `Dirty or unintegrated files in ${input.record.checkoutPath} may be permanently discarded`,
    `Herdr force removal will delete the checkout but leave branch ${input.record.branch} intact`,
    "This decision cannot be authorized by an LLM tool call",
  ] as const;
  const confirmed = await input.confirm({ title: "Discard retained writer worktree?", workspaceId: input.record.workspaceId, checkoutPath: input.record.checkoutPath, branch: input.record.branch, consequences });
  if (!confirmed) return undefined;
  const authorization: HumanDiscardAuthorization = { decisionId: randomUUID(), worktreeId: input.record.id, runNonce: input.record.owner.runNonce, workspaceId: input.record.workspaceId, checkoutPath: input.record.checkoutPath, confirmedAt: Date.now(), consequences };
  HUMAN_DISCARD_TOKENS.add(authorization); return authorization;
}

export class WorktreeCleanupManager {
  constructor(readonly client: HerdrRequestClient, readonly registry: WorktreeRegistry) {}

  async verifyAndRecordIntegration(id: string, request: IntegrationVerificationRequest): Promise<WorktreeRecord> {
    const record = this.registry.get(id); if (!record) throw new Error(`Unknown worktree ${id}`);
    const evidence = await verifyObjectiveIntegration(record, request);
    return this.registry.setIntegrationEvidence(id, evidence);
  }

  async cleanup(input: SafeCleanupInput): Promise<CleanupResult> {
    let record = this.registry.get(input.id); if (!record) throw new Error(`Unknown worktree ${input.id}`);
    assertOwnership(record, input.ownership);
    if (record.recoveryIssue || record.removalAttempt) {
      const reason = record.recoveryIssue ? `Worktree retained because durable recovery is uncertain: ${record.recoveryIssue}` : "Worktree retained because a prior durable removal attempt has an unresolved outcome";
      return { removed: false, retained: true, state: record.state, reason, record };
    }
    if ((input.cleanup ?? "retain") === "retain") {
      record = this.registry.retain(record.id, "Writer worktree retention is the default; parent verification/integration may continue");
      return { removed: false, retained: true, state: record.state, reason: record.retentionReason!, record };
    }
    try {
      await verifyNoLiveOrUnknownChildren(this.client, record, input.signal);
      record = await ensureArtifacts({ registry: this.registry, record, capture: input.artifactCapture, parentRoots: input.parentRoots });
      if (record.parentVerification.review !== "reviewed") throw new Error("Parent review is not recorded");
      try { await assertClean(record); }
      catch (error) { record = this.registry.markDirty(record.id, error instanceof Error ? error.message : String(error)); throw error; }
      const savedEvidence = record.parentVerification.integrationEvidence;
      const finalIntegrationRequest = savedEvidence ? requestFromSavedEvidence(savedEvidence) : input.integrationEvidence;
      if (!finalIntegrationRequest) { record = this.registry.markIntegrationPending(record.id); throw new Error("Objective integration evidence is required"); }
      await verifyHerdrRemovalIdentity(this.client, record, input.signal);
      // Recheck mutable Herdr, artifact, checkout, child commit, and parent commit/tree state at the destructive boundary.
      await verifyNoLiveOrUnknownChildren(this.client, record, input.signal);
      const finalArtifacts = await verifyRetainedArtifactCapture({ references: record.capturedArtifacts, parentRoots: input.parentRoots, disposableCheckoutPath: record.checkoutPath });
      if (!finalArtifacts.verified) throw new Error(finalArtifacts.reason);
      await assertClean(record);
      record = this.registry.setIntegrationEvidence(record.id, await verifyObjectiveIntegration(record, finalIntegrationRequest));
      await verifyNoLiveOrUnknownChildren(this.client, record, input.signal);
      await input.revalidateOwnership?.();
      record = this.registry.beginRemoval(record.id, false);
      const removed = await this.client.removeWorktree(record.workspaceId, false, input.signal);
      if (removed.workspaceId !== record.workspaceId || resolve(removed.path) !== record.checkoutPath || removed.forced) throw new Error("Herdr removal response did not match the non-force extension-owned identity");
      record = this.registry.markRemoved(record.id);
      return { removed: true, retained: false, state: record.state, reason: "Identity-matched clean integrated worktree removed; branch was not deleted", record };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record = this.registry.retain(record.id, `Worktree retained: ${reason}`, reason);
      return { removed: false, retained: true, state: record.state, reason, record };
    }
  }

  async discardWithHumanConfirmation(input: Omit<SafeCleanupInput, "cleanup" | "integrationEvidence"> & { readonly authorization: HumanDiscardAuthorization }): Promise<CleanupResult> {
    let record = this.registry.get(input.id); if (!record) throw new Error(`Unknown worktree ${input.id}`);
    assertOwnership(record, input.ownership);
    if (record.recoveryIssue || record.removalAttempt) {
      const reason = record.recoveryIssue ? `Worktree retained because durable recovery is uncertain: ${record.recoveryIssue}` : "Worktree retained because a prior durable removal attempt has an unresolved outcome";
      return { removed: false, retained: true, state: record.state, reason, record };
    }
    const authorization = input.authorization;
    if (!HUMAN_DISCARD_TOKENS.has(authorization) || authorization.worktreeId !== record.id || authorization.runNonce !== record.owner.runNonce
      || authorization.workspaceId !== record.workspaceId || authorization.checkoutPath !== record.checkoutPath) {
      record = this.registry.retain(record.id, "Worktree retained: human-only discard authorization is absent, forged, or stale", "human-only discard authorization refused");
      return { removed: false, retained: true, state: record.state, reason: "human-only discard authorization refused", record };
    }
    try {
      await verifyNoLiveOrUnknownChildren(this.client, record, input.signal);
      record = await ensureArtifacts({ registry: this.registry, record, capture: input.artifactCapture, parentRoots: input.parentRoots });
      await verifyHerdrRemovalIdentity(this.client, record, input.signal);
      await verifyNoLiveOrUnknownChildren(this.client, record, input.signal);
      const finalArtifacts = await verifyRetainedArtifactCapture({ references: record.capturedArtifacts, parentRoots: input.parentRoots, disposableCheckoutPath: record.checkoutPath });
      if (!finalArtifacts.verified) throw new Error(finalArtifacts.reason);
      const decision: HumanDiscardDecision = { decisionId: authorization.decisionId, confirmedAt: authorization.confirmedAt, consequences: authorization.consequences };
      record = this.registry.setHumanDiscard(record.id, decision);
      await verifyNoLiveOrUnknownChildren(this.client, record, input.signal);
      await input.revalidateOwnership?.();
      record = this.registry.beginRemoval(record.id, true);
      const removed = await this.client.removeWorktree(record.workspaceId, true, input.signal);
      if (removed.workspaceId !== record.workspaceId || resolve(removed.path) !== record.checkoutPath || !removed.forced) throw new Error("Herdr force-removal response did not match the confirmed extension-owned identity");
      record = this.registry.markRemoved(record.id);
      return { removed: true, retained: false, state: record.state, reason: "Human-confirmed discard removed the checkout; branch was not deleted", record };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record = this.registry.retain(record.id, `Worktree retained after discard refusal/failure: ${reason}`, reason);
      return { removed: false, retained: true, state: record.state, reason, record };
    }
  }
}
