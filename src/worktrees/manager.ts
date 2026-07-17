import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { HerdrRequestClient } from "../herdr/client.ts";
import type { WorktreeSelector } from "../herdr/protocol.ts";
import type { ArtifactReference } from "../contracts/artifact.ts";
import { processBaseline, type DelegationGroupManager } from "../runtime/groups.ts";
import type { PiBranchEntry, PiEntryAppender } from "../runtime/ownership.ts";
import type {
  ObjectiveIntegrationEvidence,
  ParentVerificationState,
  WorktreeOwner,
  WorktreeRecord,
  WorktreeState,
  WorktreeStateView,
} from "./contracts.ts";
import { toWorktreeStateView, WORKTREE_STATES } from "./contracts.ts";
import { identifyCheckout } from "./writer-locks.ts";

const execFileAsync = promisify(execFile);

async function git(checkout: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 1_000_000 });
  return result.stdout.trim();
}

function safeRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("Worktree run id is unsafe");
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

const ALLOWED_TRANSITIONS: Readonly<Record<WorktreeState, readonly WorktreeState[]>> = {
  created: ["active", "dirty", "integration_pending", "integrated", "retained", "removed"],
  active: ["dirty", "integration_pending", "integrated", "retained"],
  dirty: ["integration_pending", "integrated", "retained"],
  integration_pending: ["dirty", "integrated", "retained"],
  integrated: ["dirty", "retained", "removed"],
  retained: ["active", "dirty", "integration_pending", "integrated", "removed"],
  removed: [],
};

export const WORKTREE_RECORD_ENTRY_TYPE = "herdr-subagents.worktree-record.v1" as const;
interface WorktreeRecordJournalData { readonly schemaVersion: 1; readonly id: string; readonly sequence: number; readonly record: WorktreeRecord; }
export interface RecoveredWorktreeRecord { readonly state: "certain" | "uncertain"; readonly record: WorktreeRecord; readonly sequence: number; readonly issues: readonly string[]; }

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${label} must be a non-empty string`);
}
export function decodeWorktreeRecord(value: unknown): WorktreeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Worktree record must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error("Unsupported worktree record schema");
  for (const key of ["id", "repositoryId", "commonGitDir", "herdrRepositoryKey", "sourceCheckoutPath", "workspaceId", "checkoutPath", "branch", "base"] as const) assertNonEmpty(record[key], `worktree.${key}`);
  if (!WORKTREE_STATES.includes(record.state as WorktreeState)) throw new Error("Worktree state is malformed");
  if (!Array.isArray(record.artifactPaths) || !Array.isArray(record.capturedArtifacts)) throw new Error("Worktree artifact path state is malformed");
  if (typeof record.createdRoot !== "object" || record.createdRoot === null || typeof record.owner !== "object" || record.owner === null || typeof record.parentVerification !== "object" || record.parentVerification === null) throw new Error("Worktree cleanup identity/state is malformed");
  if (typeof record.artifactsCaptured !== "boolean" || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) throw new Error("Worktree cleanup flags/timestamps are malformed");
  const root = record.createdRoot as Record<string, unknown>; for (const key of ["tabId", "rootPaneId", "rootTerminalId"] as const) assertNonEmpty(root[key], `worktree.createdRoot.${key}`);
  if (root.rootProcessBaseline !== undefined) assertNonEmpty(root.rootProcessBaseline, "worktree.createdRoot.rootProcessBaseline");
  const owner = record.owner as Record<string, unknown>; assertNonEmpty(owner.runId, "worktree.owner.runId"); assertNonEmpty(owner.runNonce, "worktree.owner.runNonce");
  if (typeof owner.parent !== "object" || owner.parent === null) throw new Error("Worktree parent proof is malformed");
  for (const artifact of [...record.artifactPaths, ...record.capturedArtifacts]) {
    if (typeof artifact !== "object" || artifact === null) throw new Error("Worktree artifact reference is malformed");
    const reference = artifact as Record<string, unknown>; assertNonEmpty(reference.kind, "artifact.kind"); assertNonEmpty(reference.path, "artifact.path"); assertNonEmpty(reference.absolutePath, "artifact.absolutePath");
    if (typeof reference.required !== "boolean") throw new Error("Artifact required flag is malformed");
  }
  return value as WorktreeRecord;
}
function assertRecordUpdate(current: WorktreeRecord, next: WorktreeRecord): void {
  if (next.id !== current.id || next.repositoryId !== current.repositoryId || next.commonGitDir !== current.commonGitDir
    || next.herdrRepositoryKey !== current.herdrRepositoryKey || next.sourceWorkspaceId !== current.sourceWorkspaceId
    || next.sourceCheckoutPath !== current.sourceCheckoutPath || next.workspaceId !== current.workspaceId
    || next.checkoutPath !== current.checkoutPath || next.branch !== current.branch || next.generatedBranch !== current.generatedBranch || next.base !== current.base
    || JSON.stringify(next.owner) !== JSON.stringify(current.owner) || JSON.stringify(next.legacyOwner) !== JSON.stringify(current.legacyOwner) || JSON.stringify(next.artifactPaths) !== JSON.stringify(current.artifactPaths)
    || next.createdRoot.tabId !== current.createdRoot.tabId || next.createdRoot.rootPaneId !== current.createdRoot.rootPaneId
    || next.createdRoot.rootTerminalId !== current.createdRoot.rootTerminalId) {
    throw new Error("Immutable worktree provenance, artifact paths, or ownership changed");
  }
  if (current.createdRoot.rootProcessBaseline !== undefined && next.createdRoot.rootProcessBaseline !== current.createdRoot.rootProcessBaseline) throw new Error("Initial-root process baseline changed");
  if (current.tab !== undefined && JSON.stringify(next.tab) !== JSON.stringify(current.tab)) throw new Error("Worktree group anchor identity/baseline changed");
  if (current.writer !== undefined && JSON.stringify(next.writer) !== JSON.stringify(current.writer)) throw new Error("Bound worktree writer identity changed");
  if (current.artifactsCaptured && (!next.artifactsCaptured || JSON.stringify(next.capturedArtifacts) !== JSON.stringify(current.capturedArtifacts))) throw new Error("Captured artifact evidence cannot be removed or changed");
  if (current.parentVerification.review === "reviewed" && next.parentVerification.review !== "reviewed") throw new Error("Parent review evidence regressed");
  if (current.parentVerification.integration !== "pending" && next.parentVerification.integration === "pending") throw new Error("Objective integration evidence regressed");
  if (current.humanDiscard !== undefined && JSON.stringify(next.humanDiscard) !== JSON.stringify(current.humanDiscard)) throw new Error("Human discard decision changed");
  if (current.removalAttempt !== undefined && next.removalAttempt === undefined && next.state !== "removed") throw new Error("Unresolved removal-attempt evidence was cleared");
  if (current.removalAttempt !== undefined && next.removalAttempt !== undefined && JSON.stringify(next.removalAttempt) !== JSON.stringify(current.removalAttempt)) throw new Error("Removal-attempt evidence changed");
  if (next.updatedAt < current.updatedAt) throw new Error("Worktree durable timestamp regressed");
  if (next.state !== current.state && !ALLOWED_TRANSITIONS[current.state].includes(next.state)) throw new Error(`Invalid worktree transition ${current.state} -> ${next.state}`);
}
function decodeJournalData(value: unknown): WorktreeRecordJournalData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed worktree journal entry");
  const data = value as Record<string, unknown>; assertNonEmpty(data.id, "worktree journal id");
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.sequence) || (data.sequence as number) < 0) throw new Error("Malformed worktree journal sequence");
  const record = decodeWorktreeRecord(data.record); if (record.id !== data.id) throw new Error("Worktree journal id does not match its record");
  return value as WorktreeRecordJournalData;
}

export function recoverWorktreeRecords(entries: readonly PiBranchEntry[]): Map<string, RecoveredWorktreeRecord> {
  const recovered = new Map<string, RecoveredWorktreeRecord>();
  const entryIndexes = new Map(entries.map((entry, index) => [entry.id, index]));
  entries.forEach((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== WORKTREE_RECORD_ENTRY_TYPE) return;
    let data: WorktreeRecordJournalData;
    try { data = decodeJournalData(entry.data); }
    catch (error) {
      const id = typeof entry.data === "object" && entry.data !== null && typeof (entry.data as { id?: unknown }).id === "string" ? (entry.data as { id: string }).id : undefined;
      const prior = id ? recovered.get(id) : undefined;
      if (id && prior) recovered.set(id, { ...prior, state: "uncertain", issues: [...prior.issues, error instanceof Error ? error.message : String(error)] });
      return;
    }
    const prior = recovered.get(data.id); const issues = prior ? [...prior.issues] : [];
    if (entry.parentId === undefined || index === 0 || entry.parentId !== entries[index - 1]!.id) issues.push("worktree journal entry is not linked to the preceding active-branch entry");
    const parentIndex = entryIndexes.get(data.record.owner.parent.branchEntryId);
    if (parentIndex === undefined || parentIndex >= index) issues.push("worktree journal parent branch proof is absent or not earlier on the active branch");
    if (!prior) {
      if (data.sequence !== 0) issues.push("worktree journal does not begin at sequence 0");
    } else {
      if (data.sequence !== prior.sequence + 1) issues.push("worktree journal sequence is non-contiguous");
      try { assertRecordUpdate(prior.record, data.record); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    }
    recovered.set(data.id, { state: issues.length ? "uncertain" : "certain", record: data.record, sequence: data.sequence, issues });
  });
  return recovered;
}

export class WorktreeRegistry {
  #records = new Map<string, WorktreeRecord>();
  #sequences = new Map<string, number>();
  constructor(private readonly journal: PiEntryAppender) {}
  static recover(entries: readonly PiBranchEntry[], journal: PiEntryAppender): WorktreeRegistry {
    const registry = new WorktreeRegistry(journal);
    for (const [id, recovered] of recoverWorktreeRecords(entries)) {
      const record = recovered.state === "certain" ? recovered.record : {
        ...recovered.record,
        ...(recovered.record.state === "removed" ? {} : { state: "retained" as const }),
        retentionReason: `Recovered worktree retained because durable state is uncertain: ${recovered.issues.join("; ")}`,
        removalRefusal: "durable worktree recovery is uncertain",
        recoveryIssue: recovered.issues.join("; "),
      };
      registry.#records.set(id, record); registry.#sequences.set(id, recovered.sequence);
    }
    return registry;
  }
  #persist(record: WorktreeRecord, sequence: number): void {
    decodeWorktreeRecord(record);
    this.journal.appendEntry(WORKTREE_RECORD_ENTRY_TYPE, { schemaVersion: 1, id: record.id, sequence, record } satisfies WorktreeRecordJournalData);
  }
  register(record: WorktreeRecord): WorktreeRecord {
    if (this.#records.has(record.id)) throw new Error(`Worktree record ${record.id} already exists`);
    this.#persist(record, 0); this.#records.set(record.id, record); this.#sequences.set(record.id, 0); return record;
  }
  get(id: string): WorktreeRecord | undefined { return this.#records.get(id); }
  list(): readonly WorktreeRecord[] { return [...this.#records.values()]; }
  getState(id: string): WorktreeStateView | undefined { const record = this.get(id); return record ? toWorktreeStateView(record) : undefined; }
  listStates(): readonly WorktreeStateView[] { return this.list().map(toWorktreeStateView); }

  update(id: string, update: (record: WorktreeRecord) => WorktreeRecord): WorktreeRecord {
    const current = this.get(id); if (!current) throw new Error(`Unknown worktree record ${id}`);
    if (current.recoveryIssue) throw new Error(`Recovered worktree state is uncertain and cannot transition: ${current.recoveryIssue}`);
    const next = update(current); assertRecordUpdate(current, next);
    const sequence = (this.#sequences.get(id) ?? -1) + 1;
    this.#persist(next, sequence); this.#records.set(id, next); this.#sequences.set(id, sequence); return next;
  }
  #transition(id: string, state: WorktreeState, reason?: string): WorktreeRecord {
    return this.update(id, (record) => ({
      ...record,
      state,
      updatedAt: Date.now(),
      ...(reason === undefined ? {} : { retentionReason: reason }),
    }));
  }
  markDirty(id: string, reason = "Git reports checkout changes"): WorktreeRecord { return this.#transition(id, "dirty", reason); }
  markIntegrationPending(id: string, reason = "Parent integration remains pending"): WorktreeRecord { return this.#transition(id, "integration_pending", reason); }
  beginRemoval(id: string, force: boolean, childHead: string): WorktreeRecord {
    return this.update(id, (record) => {
      if (record.removalAttempt) throw new Error("A durable worktree removal attempt is already unresolved");
      if (!record.artifactsCaptured) throw new Error("A worktree removal attempt requires durable captured-artifact evidence");
      if (force && !record.humanDiscard) throw new Error("Force removal requires a durable human discard decision");
      if (!force && record.parentVerification.integration !== "verified" && record.parentVerification.integration !== "not_required") throw new Error("Non-force removal requires durable objective integration evidence");
      return { ...record, removalAttempt: { force, startedAt: Date.now(), childHead }, updatedAt: Date.now() };
    });
  }
  markRemoved(id: string): WorktreeRecord {
    const record = this.get(id); if (!record) throw new Error(`Unknown worktree record ${id}`);
    const safelyVerified = record.parentVerification.integration === "verified" || record.parentVerification.integration === "not_required";
    if (!safelyVerified && record.humanDiscard === undefined) throw new Error("Worktree cannot enter removed without objective safe-cleanup evidence or a recorded human discard decision");
    if (!record.removalAttempt) throw new Error("Worktree removal requires a durable write-ahead removal attempt");
    return this.update(id, (current) => {
      const { removalAttempt: _attempt, ...rest } = current;
      return { ...rest, state: "removed", finalization: { ...current.finalization, workspaceRemovedAt: Date.now(), removedPath: current.checkoutPath, childHead: current.removalAttempt!.childHead }, updatedAt: Date.now() };
    });
  }
  bindWriter(id: string, writer: NonNullable<WorktreeRecord["writer"]>): WorktreeRecord {
    return this.update(id, (record) => {
      if (record.writer !== undefined) throw new Error("Worktree already has a writer binding");
      return { ...record, writer, state: "active", updatedAt: Date.now() };
    });
  }
  setParentReviewed(id: string, detail?: string): WorktreeRecord {
    return this.update(id, (record) => {
      if (record.state === "removed") throw new Error("Removed worktree cannot be reviewed");
      const parentVerification: ParentVerificationState = {
        ...record.parentVerification,
        review: "reviewed",
        reviewedAt: Date.now(),
        ...(detail === undefined ? {} : { detail }),
      };
      return { ...record, parentVerification, updatedAt: Date.now() };
    });
  }
  setIntegrationEvidence(id: string, evidence: ObjectiveIntegrationEvidence): WorktreeRecord {
    return this.update(id, (record) => {
      return {
        ...record,
        state: "integrated",
        parentVerification: { ...record.parentVerification, integration: evidence.kind === "no_changes" ? "not_required" : "verified", integrationEvidence: evidence },
        updatedAt: Date.now(),
      };
    });
  }
  markBranchFinalized(id: string, disposition: "deleted" | "preserved"): WorktreeRecord {
    return this.update(id, (record) => {
      const { removalRefusal: _refusal, ...rest } = record;
      return { ...rest, finalization: { ...record.finalization, branchFinalizedAt: Date.now(), branchDisposition: disposition }, updatedAt: Date.now() };
    });
  }
  markRuntimeArtifactsPurged(id: string): WorktreeRecord {
    return this.update(id, (record) => {
      const { removalRefusal: _refusal, ...rest } = record;
      return { ...rest, finalization: { ...record.finalization, runtimeArtifactsPurgedAt: Date.now() }, updatedAt: Date.now() };
    });
  }
  recordFinalizationError(id: string, reason: string): WorktreeRecord {
    return this.update(id, (record) => ({ ...record, finalization: { ...record.finalization, lastError: reason }, removalRefusal: reason, updatedAt: Date.now() }));
  }
  setCapturedArtifacts(id: string, references: WorktreeRecord["capturedArtifacts"]): WorktreeRecord {
    return this.update(id, (record) => ({ ...record, artifactsCaptured: true, capturedArtifacts: references, updatedAt: Date.now() }));
  }
  setHumanDiscard(id: string, humanDiscard: NonNullable<WorktreeRecord["humanDiscard"]>): WorktreeRecord {
    return this.update(id, (record) => ({ ...record, humanDiscard, updatedAt: Date.now() }));
  }
  retain(id: string, reason: string, removalRefusal?: string): WorktreeRecord {
    return this.update(id, (record) => ({
      ...record,
      state: "retained",
      retentionReason: reason,
      ...(removalRefusal === undefined ? {} : { removalRefusal }),
      updatedAt: Date.now(),
    }));
  }
}

export interface CreateWriterWorktreeInput {
  readonly id: string;
  readonly owner: WorktreeOwner;
  readonly source: WorktreeSelector;
  readonly group: string;
  /** Absolute, run-bound paths fixed before topology creation. */
  readonly artifacts: readonly { readonly kind: ArtifactReference["kind"]; readonly sourcePath: string; readonly writer: ArtifactReference["writer"]; readonly required: boolean }[];
  readonly branch?: string;
  readonly base?: string;
  readonly path?: string;
  readonly label?: string;
  readonly signal?: AbortSignal;
  /** Called immediately after Herdr returns identities, before any later tab/probe can fail. */
  readonly onWorktreeCreated?: (record: WorktreeRecord) => void | Promise<void>;
  readonly onGroupReady?: (record: WorktreeRecord) => void | Promise<void>;
}

export class WorktreeProvisionError extends Error {
  constructor(message: string, readonly retained: WorktreeRecord, options?: ErrorOptions) {
    super(message, options); this.name = "WorktreeProvisionError";
  }
}

export class WorktreeManager {
  constructor(
    readonly client: HerdrRequestClient,
    readonly groups: DelegationGroupManager,
    readonly registry: WorktreeRegistry,
  ) {}

  async createForWriter(input: CreateWriterWorktreeInput): Promise<WorktreeRecord> {
    safeRunId(input.id);
    if (Number(input.source.workspace_id !== undefined) + Number(input.source.cwd !== undefined) !== 1) throw new Error("Writer worktree requires exactly one explicit source workspace or cwd");
    if (!input.group) throw new Error("Writer worktree requires a delegation group");
    if (input.source.cwd !== undefined && !isAbsolute(input.source.cwd)) throw new Error("Worktree source cwd must be absolute");
    if (input.path !== undefined && !isAbsolute(input.path)) throw new Error("Worktree path must be absolute");

    const listed = await this.client.listWorktrees(input.source, input.signal);
    const sourceIdentity = await identifyCheckout(listed.source.source_checkout_path);
    if (input.source.cwd !== undefined) {
      const supplied = await identifyCheckout(input.source.cwd);
      if (supplied.repositoryId !== sourceIdentity.repositoryId || supplied.checkoutPath !== sourceIdentity.checkoutPath) throw new Error("Herdr worktree source does not match the requested canonical checkout");
    }
    const base = await git(sourceIdentity.checkoutPath, ["rev-parse", "--verify", `${input.base ?? "HEAD"}^{commit}`]);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const branch = input.branch ?? `herdr-subagents/${input.id}-${suffix}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,220}$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.startsWith("/")) throw new Error("Requested worktree branch is unsafe");
    const defaultDirectory = join(dirname(sourceIdentity.checkoutPath), ".herdr-subagents-worktrees");
    const requestedPath = resolve(input.path ?? join(defaultDirectory, `${input.id}-${suffix}`));
    await mkdir(dirname(requestedPath), { recursive: true });
    const path = join(await realpath(dirname(requestedPath)), basename(requestedPath));
    if (isWithin(sourceIdentity.checkoutPath, path) || isWithin(path, sourceIdentity.checkoutPath)) throw new Error("Writer worktree path must be distinct and non-overlapping with the source checkout");
    try { await access(path); throw new Error(`Writer worktree path already exists: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const artifactPaths: ArtifactReference[] = input.artifacts.map((artifact) => {
      if (!isAbsolute(artifact.sourcePath)) throw new Error(`Worktree ${artifact.kind} artifact path must be absolute`);
      const suppliedPath = resolve(artifact.sourcePath);
      const absolutePath = isWithin(requestedPath, suppliedPath) ? join(path, relative(requestedPath, suppliedPath)) : suppliedPath;
      if (!isWithin(join(path, ".subagents"), absolutePath) && !isWithin(join(path, ".progress"), absolutePath)) throw new Error(`Worktree ${artifact.kind} artifact path is not bound to the disposable checkout`);
      return { kind: artifact.kind, path: absolutePath, absolutePath, writer: artifact.writer, required: artifact.required };
    });

    const created = await this.client.createWorktree({
      ...input.source,
      branch,
      base,
      path,
      label: input.label ?? `subagents:${input.id}`,
      focus: false,
    }, input.signal);
    const now = Date.now();
    const provisional: WorktreeRecord = {
      schemaVersion: 1,
      id: input.id,
      repositoryId: sourceIdentity.repositoryId,
      commonGitDir: sourceIdentity.commonGitDir,
      herdrRepositoryKey: listed.source.repo_key,
      ...(listed.source.source_workspace_id == null ? {} : { sourceWorkspaceId: listed.source.source_workspace_id }),
      sourceCheckoutPath: sourceIdentity.checkoutPath,
      workspaceId: created.workspace.workspace_id,
      checkoutPath: resolve(created.worktree.path),
      branch,
      generatedBranch: input.branch === undefined,
      base,
      state: "created",
      createdRoot: { tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id },
      owner: input.owner,
      artifactPaths,
      artifactsCaptured: false,
      capturedArtifacts: [],
      parentVerification: { review: "pending", integration: "pending" },
      createdAt: now,
      updatedAt: now,
    };
    this.registry.register(provisional);
    try {
      await input.onWorktreeCreated?.(provisional);
      if (created.workspace.focused || created.tab.focused || created.rootPane.focused) throw new Error("Herdr focused a worktree resource created with focus:false");
      if (created.worktree.branch !== branch || created.worktree.is_detached || created.worktree.is_bare || !created.worktree.is_linked_worktree) throw new Error("Herdr returned unexpected worktree branch/link provenance");
      const checkoutPath = await realpath(created.worktree.path);
      if (checkoutPath !== path || created.workspace.worktree?.checkout_path !== checkoutPath || created.workspace.worktree.repo_key !== listed.source.repo_key || !created.workspace.worktree.is_linked_worktree) throw new Error("Herdr workspace/worktree provenance does not match the requested identity");
      const childIdentity = await identifyCheckout(checkoutPath);
      if (childIdentity.repositoryId !== sourceIdentity.repositoryId || childIdentity.commonGitDir !== sourceIdentity.commonGitDir) throw new Error("Created checkout does not belong to the canonical source repository");
      const initialRootProcessBaseline = processBaseline(await this.client.getPaneProcessInfo(created.rootPane.pane_id, input.signal));
      this.registry.update(input.id, (record) => ({ ...record, checkoutPath, createdRoot: { ...record.createdRoot, rootProcessBaseline: initialRootProcessBaseline }, updatedAt: Date.now() }));
      const group = await this.groups.ensure(created.workspace.workspace_id, input.group, input.signal);
      const ready = this.registry.update(input.id, (record) => ({
        ...record,
        checkoutPath,
        tab: { tabId: group.tabId, rootPaneId: group.rootPaneId, rootTerminalId: group.rootTerminalId, rootProcessBaseline: group.rootProcessBaseline },
        updatedAt: Date.now(),
      }));
      await input.onGroupReady?.(ready);
      return ready;
    } catch (error) {
      const retained = this.registry.retain(input.id, `Worktree provisioning was only partial and was retained: ${error instanceof Error ? error.message : String(error)}`);
      throw new WorktreeProvisionError(retained.retentionReason!, retained, { cause: error });
    }
  }
}
