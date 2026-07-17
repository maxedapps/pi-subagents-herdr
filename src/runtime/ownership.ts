import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import type { SessionSnapshot } from "../herdr/protocol.ts";

export const OWNERSHIP_ENTRY_TYPE = "herdr-subagents.ownership.v1" as const;
export interface IntendedResources { readonly workspaceId: string; readonly group: string; readonly worktreeRequested: boolean; }
export interface JournalResources {
  readonly tabId?: string; readonly rootPaneId?: string; readonly rootTerminalId?: string; readonly rootProcessBaseline?: string;
  readonly paneId?: string; readonly terminalId?: string; readonly nativeSession?: NativeSessionIdentity;
  readonly repositoryId?: string; readonly commonGitDir?: string; readonly herdrRepositoryKey?: string;
  readonly worktreeSourceWorkspaceId?: string; readonly worktreeWorkspaceId?: string; readonly checkoutPath?: string;
  readonly worktreeBranch?: string; readonly worktreeBase?: string;
  readonly worktreeInitialTabId?: string; readonly worktreeInitialRootPaneId?: string; readonly worktreeInitialRootTerminalId?: string;
}
export type OwnershipJournalPhase = "intent" | "worktree_created" | "created" | "started" | "stopped" | "cleanup_adopted" | "failed";
export interface OwnershipJournalData {
  readonly schemaVersion: 1; readonly runId: string; readonly runNonce: string; readonly sequence: number;
  readonly parent: { readonly sessionId: string; readonly sessionPath?: string; readonly branchEntryId: string };
  readonly intended: IntendedResources; readonly resources: JournalResources; readonly phase: OwnershipJournalPhase;
}
export interface PiEntryAppender { appendEntry(customType: string, data: unknown): void; }
export interface PiBranchEntry { readonly type: string; readonly id: string; readonly parentId?: string | null; readonly customType?: string; readonly data?: unknown; }
export interface RecoveredOwnership { readonly state: "owned" | "uncertain"; readonly journal: OwnershipJournalData; readonly issues: readonly string[]; }
export interface CurrentParentIdentity { readonly sessionId: string; readonly sessionPath?: string; }

const RESOURCE_KEYS = new Set(["tabId", "rootPaneId", "rootTerminalId", "rootProcessBaseline", "paneId", "terminalId", "nativeSession", "repositoryId", "commonGitDir", "herdrRepositoryKey", "worktreeSourceWorkspaceId", "worktreeWorkspaceId", "checkoutPath", "worktreeBranch", "worktreeBase", "worktreeInitialTabId", "worktreeInitialRootPaneId", "worktreeInitialRootTerminalId"]);
const TRANSITIONS: Readonly<Record<OwnershipJournalPhase, readonly OwnershipJournalPhase[]>> = {
  intent: ["worktree_created", "created", "cleanup_adopted", "failed"],
  worktree_created: ["created", "failed"],
  created: ["created", "started", "failed"],
  started: ["started", "stopped", "failed"],
  stopped: [],
  cleanup_adopted: [],
  failed: ["stopped"],
};
function safeId(value: string, label: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function optionalString(value: unknown, label: string): void { if (value !== undefined && typeof value !== "string") throw new Error(`${label} must be a string`); }
function validateNativeSession(value: unknown): void {
  if (!isRecord(value) || (value.kind !== "id" && value.kind !== "path") || typeof value.value !== "string" || typeof value.source !== "string") throw new Error("Malformed ownership native session identity");
}
function validateResources(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (!RESOURCE_KEYS.has(key)) throw new Error(`Unknown ownership resource ${key}`);
  for (const key of RESOURCE_KEYS) if (key !== "nativeSession") optionalString(value[key], `resources.${key}`);
  if (value.nativeSession !== undefined) validateNativeSession(value.nativeSession);
}
function validatePhaseResources(journal: OwnershipJournalData): void {
  const resources = journal.resources;
  if (journal.phase === "intent" && Object.keys(resources).length !== 0) throw new Error("Ownership intent cannot already contain returned resources");
  if (journal.phase === "worktree_created" && (!resources.repositoryId || !resources.commonGitDir || !resources.herdrRepositoryKey || !resources.worktreeWorkspaceId || !resources.checkoutPath || !resources.worktreeBranch || !resources.worktreeBase || !resources.worktreeInitialTabId || !resources.worktreeInitialRootPaneId || !resources.worktreeInitialRootTerminalId)) throw new Error("worktree_created ownership journal lacks canonical repository/worktree provenance and returned root identity");
  if ((journal.phase === "created" || journal.phase === "started" || journal.phase === "stopped" || journal.phase === "cleanup_adopted") && (!resources.tabId || !resources.rootPaneId || !resources.rootTerminalId)) throw new Error(`${journal.phase} ownership journal lacks the returned group identity`);
  if ((journal.phase === "created" || journal.phase === "started" || journal.phase === "stopped" || journal.phase === "cleanup_adopted") && journal.intended.worktreeRequested && (!resources.repositoryId || !resources.commonGitDir || !resources.herdrRepositoryKey || !resources.worktreeWorkspaceId || !resources.checkoutPath || !resources.worktreeBranch || !resources.worktreeBase)) throw new Error(`${journal.phase} ownership journal lacks worktree provenance`);
  if ((journal.phase === "started" || journal.phase === "cleanup_adopted") && (!resources.paneId || !resources.terminalId)) throw new Error(`${journal.phase} ownership journal lacks the child pane and terminal identity`);
}
export function parseOwnershipJournalData(value: unknown): OwnershipJournalData {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runId !== "string" || typeof value.runNonce !== "string" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !isRecord(value.parent) || !isRecord(value.intended) || !isRecord(value.resources)) throw new Error("Malformed ownership journal entry");
  safeId(value.runId, "runId"); safeId(value.runNonce, "runNonce");
  if (typeof value.parent.sessionId !== "string" || value.parent.sessionId.length === 0 || typeof value.parent.branchEntryId !== "string" || value.parent.branchEntryId.length === 0) throw new Error("Malformed ownership journal parent identity");
  optionalString(value.parent.sessionPath, "parent.sessionPath");
  if (typeof value.intended.workspaceId !== "string" || typeof value.intended.group !== "string" || typeof value.intended.worktreeRequested !== "boolean") throw new Error("Malformed ownership journal intent");
  if (!["intent", "worktree_created", "created", "started", "stopped", "cleanup_adopted", "failed"].includes(value.phase as string)) throw new Error("Malformed ownership journal phase");
  validateResources(value.resources); const journal = value as unknown as OwnershipJournalData; validatePhaseResources(journal); return journal;
}
function mergeResources(previous: JournalResources, patch: JournalResources): JournalResources {
  const next: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (!RESOURCE_KEYS.has(key)) throw new Error(`Unknown ownership resource ${key}`);
    const prior = next[key]; if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error(`Ownership resource ${key} is immutable once recorded`);
    if (value !== undefined) next[key] = value;
  }
  validateResources(next); return next as JournalResources;
}
function assertTransition(previous: OwnershipJournalData, phase: OwnershipJournalPhase, resources: JournalResources): JournalResources {
  if (!TRANSITIONS[previous.phase].includes(phase)) throw new Error(`Invalid ownership journal transition ${previous.phase} -> ${phase}`);
  const merged = mergeResources(previous.resources, resources);
  if ((phase === "created" && previous.phase === "created" || phase === "started" && previous.phase === "started") && JSON.stringify(merged) === JSON.stringify(previous.resources)) throw new Error(`Repeated ${phase} phase must add immutable resource evidence`);
  const candidate: OwnershipJournalData = { ...previous, sequence: previous.sequence + 1, phase, resources: merged };
  validatePhaseResources(candidate); return merged;
}

export class ActiveBranchOwnershipJournal {
  constructor(private readonly pi: PiEntryAppender) {}
  begin(input: { runId: string; runNonce: string; branchEntryId: string; sessionId: string; sessionPath?: string; intended: IntendedResources }): OwnershipJournalData {
    safeId(input.runId, "runId"); safeId(input.runNonce, "runNonce"); if (!input.branchEntryId) throw new Error("An active parent branch entry is required before topology creation"); if (!input.sessionId) throw new Error("A current parent Pi session id is required");
    const parent = { branchEntryId: input.branchEntryId, sessionId: input.sessionId, ...(input.sessionPath === undefined ? {} : { sessionPath: input.sessionPath }) };
    const data: OwnershipJournalData = { schemaVersion: 1, runId: input.runId, runNonce: input.runNonce, sequence: 0, parent, intended: input.intended, resources: {}, phase: "intent" };
    this.pi.appendEntry(OWNERSHIP_ENTRY_TYPE, data); return data;
  }
  append(previous: OwnershipJournalData, phase: OwnershipJournalPhase, resources: JournalResources): OwnershipJournalData {
    const merged = assertTransition(previous, phase, resources);
    const data: OwnershipJournalData = { ...previous, sequence: previous.sequence + 1, phase, resources: merged };
    this.pi.appendEntry(OWNERSHIP_ENTRY_TYPE, data); return data;
  }
}

export function recoverActiveBranchOwnership(entries: readonly PiBranchEntry[]): Map<string, RecoveredOwnership> {
  const states = new Map<string, RecoveredOwnership>();
  const latestIndexes = new Map<string, number>();
  const idIndexes = new Map<string, number>();
  const duplicateIds = new Set<string>();
  entries.forEach((entry, index) => { if (idIndexes.has(entry.id)) duplicateIds.add(entry.id); else idIndexes.set(entry.id, index); });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== OWNERSHIP_ENTRY_TYPE) continue;
    let current: OwnershipJournalData;
    try { current = parseOwnershipJournalData(entry.data); } catch {
      if (isRecord(entry.data) && typeof entry.data.runId === "string") { const prior = states.get(entry.data.runId); if (prior) states.set(entry.data.runId, { state: "uncertain", journal: prior.journal, issues: [...prior.issues, "malformed later ownership journal entry"] }); }
      continue;
    }
    const prior = states.get(current.runId); const issues = prior ? [...prior.issues] : [];
    const previousBranchEntry = entries[index - 1];
    if (entry.parentId === undefined || !previousBranchEntry || entry.parentId !== previousBranchEntry.id) issues.push("ownership journal entry is not linked to the preceding active-branch entry");
    if (duplicateIds.has(entry.id)) issues.push("active branch contains a duplicate ownership entry id");
    const parentIndex = idIndexes.get(current.parent.branchEntryId);
    if (parentIndex === undefined || parentIndex >= index) issues.push("referenced parent branch entry does not precede the ownership journal");
    if (!prior) {
      if (current.sequence !== 0 || current.phase !== "intent") issues.push("journal does not begin with sequence 0 intent");
      if (previousBranchEntry?.id !== current.parent.branchEntryId) issues.push("initial ownership intent is not directly appended to its referenced parent branch entry");
    } else {
      if (current.runNonce !== prior.journal.runNonce || JSON.stringify(current.parent) !== JSON.stringify(prior.journal.parent) || JSON.stringify(current.intended) !== JSON.stringify(prior.journal.intended)) issues.push("journal immutable identity changed");
      if (current.sequence !== prior.journal.sequence + 1) issues.push("journal sequence is non-contiguous");
      if (!TRANSITIONS[prior.journal.phase].includes(current.phase)) issues.push(`invalid journal phase transition ${prior.journal.phase} -> ${current.phase}`);
      const priorIndex = latestIndexes.get(current.runId); if (priorIndex === undefined || priorIndex >= index) issues.push("journal sequence is not ordered on the active branch");
      for (const [key, value] of Object.entries(prior.journal.resources)) if (!Object.hasOwn(current.resources, key) || JSON.stringify((current.resources as Record<string, unknown>)[key]) !== JSON.stringify(value)) issues.push(`journal resource ${key} was removed or changed`);
      try {
        const merged = mergeResources(prior.journal.resources, current.resources);
        if ((current.phase === "created" && prior.journal.phase === "created" || current.phase === "started" && prior.journal.phase === "started") && JSON.stringify(merged) === JSON.stringify(prior.journal.resources)) issues.push(`repeated ${current.phase} phase added no resource evidence`);
      } catch (error) { issues.push(error instanceof Error ? error.message : "journal resource changed"); }
    }
    latestIndexes.set(current.runId, index);
    states.set(current.runId, { state: issues.length ? "uncertain" : "owned", journal: current, issues });
  }
  return states;
}

export interface OperationalMetadata { readonly runId?: string; readonly runNonce?: string; readonly terminalId?: string; readonly nativeSession?: NativeSessionIdentity; }
export interface OwnershipReconciliation { readonly state: "owned" | "orphaned" | "uncertain"; readonly reason: string; readonly journal?: OwnershipJournalData; }
export function reconcileOwnership(input: { runId: string; active: Map<string, RecoveredOwnership>; snapshot: SessionSnapshot; currentParent: CurrentParentIdentity; metadata?: OperationalMetadata }): OwnershipReconciliation {
  const recovered = input.active.get(input.runId);
  if (!recovered) return { state: "orphaned", reason: "No ownership entry exists on the active Pi branch" };
  if (recovered.state === "uncertain") return { state: "uncertain", reason: recovered.issues.join("; "), journal: recovered.journal };
  const journal = recovered.journal;
  if (journal.parent.sessionId !== input.currentParent.sessionId || (journal.parent.sessionPath !== undefined && journal.parent.sessionPath !== input.currentParent.sessionPath)) return { state: "orphaned", reason: "Ownership journal belongs to a different parent Pi session", journal };
  const terminal = journal.resources.terminalId;
  if (!terminal) return { state: "uncertain", reason: "Active journal has no child terminal identity", journal };
  const pane = input.snapshot.panes.find((candidate) => candidate.terminal_id === terminal);
  const agent = input.snapshot.agents.find((candidate) => candidate.terminal_id === terminal);
  if (!pane || !agent || agent.pane_id !== pane.pane_id || agent.tab_id !== pane.tab_id || agent.workspace_id !== pane.workspace_id) return { state: "uncertain", reason: "Live Herdr snapshot cannot prove the journal terminal and topology", journal };
  const expectedNative = journal.resources.nativeSession;
  if (expectedNative && (!agent.agent_session || agent.agent_session.kind !== expectedNative.kind || agent.agent_session.value !== expectedNative.value || agent.agent_session.source !== expectedNative.source)) return { state: "uncertain", reason: "Native child session identity does not match the active journal", journal };
  const metadata = input.metadata;
  if (!metadata) return { state: "uncertain", reason: "Validated operational run metadata is required for recovery; retain as observational evidence", journal };
  if (metadata.runId !== journal.runId || metadata.runNonce !== journal.runNonce || metadata.terminalId !== terminal || JSON.stringify(metadata.nativeSession) !== JSON.stringify(expectedNative)) return { state: "uncertain", reason: "Operational metadata is stale or tampered; it cannot grant ownership", journal };
  return { state: "owned", reason: "Current parent session, active branch journal, operational run nonce, and live immutable identities agree", journal };
}
