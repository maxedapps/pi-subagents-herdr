import { lstat } from "node:fs/promises";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveArtifactLocation, type RunArtifact } from "./artifact.ts";
import type { AgentStatus } from "./herdr.ts";
import type { ProfileName } from "./profiles.ts";
import {
  createRecoveryLocator,
  enumerateRecoveryLocators,
  type EnumeratedRecoveryLocator,
  type RecoveryLocatorRecord,
} from "./registry.ts";
import type { Run } from "./runtime.ts";
import {
  HERDR_STATE_CUSTOM_TYPE,
  inventoryHerdrJournal,
  isHerdrStateRecord,
  reconstructHerdrJournal,
  type HerdrLifecycleState,
  type HerdrStateRecord,
  type JournalGeneration,
  type ReplayedHerdrRun,
} from "./session.ts";

export interface RecoveryCatalogRow {
  runId: string;
  profile?: ProfileName;
  source: "current" | "durable" | "artifact-only";
  lifecycle?: HerdrLifecycleState | Run["lifecycle"];
  status?: AgentStatus;
  generation?: number;
  delivery?: JournalGeneration["delivery"];
  outcome?: JournalGeneration["outcome"];
  branch: "active" | "historical" | "unknown";
  artifactPath?: string;
  artifactCompleteness?: "available" | "incomplete" | "unknown";
}

export interface RecoveryCatalogInput {
  entries: readonly SessionEntry[];
  branch: readonly SessionEntry[];
  parentSessionId: string;
  parentSessionFile: string;
  currentRuns: readonly Run[];
  artifacts: readonly RunArtifact[];
}

export type GlobalRecoveryClassification =
  | "current_live_owner"
  | "released_or_dead_recoverable"
  | "retained_data_only"
  | "closed_stale_locator"
  | "malformed"
  | "identity_mismatched"
  | "artifact_only"
  | "live_unreleased_owner";

export interface GlobalRecoveryCandidate {
  runId: string;
  parentSessionId: string;
  parentSessionFile?: string;
  classification: GlobalRecoveryClassification;
  source: "locator" | "legacy-journal" | "artifact-only";
  profile?: ProfileName;
  ownerState?: RecoveryLocatorRecord["ownerState"];
  parentProcessId?: number;
  parentInstanceId?: string;
  lifecycle?: HerdrLifecycleState;
  artifactPath?: string;
  retained?: readonly string[];
  reason?: string;
  locatorPath?: string;
  actionable: boolean;
}

export interface GlobalRecoveryInventory {
  candidates: GlobalRecoveryCandidate[];
  partial: boolean;
  errors: readonly string[];
}

export function buildRecoveryCatalog(input: RecoveryCatalogInput): {
  rows: RecoveryCatalogRow[];
  invalidEntries: number;
} {
  const inventory = inventoryHerdrJournal(input.entries, input.parentSessionId, input.parentSessionFile);
  const activeEntryIds = new Set(input.branch.map(({ id }) => id));
  const currentRuns = new Map(input.currentRuns.map((run) => [run.id, run]));
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.runId, artifact.path]));
  const rows: RecoveryCatalogRow[] = [];

  for (const item of inventory.runs.values()) {
    const active = activeEntryIds.has(item.latestEntryId);
    const current = active ? currentRuns.get(item.runId) : undefined;
    const artifactPath = artifacts.get(item.runId);
    const artifactCompleteness = artifactPath
      ? item.latest.generation?.artifactResultPersisted === true
        || item.latest.generation?.outcome === "aborted"
        ? "available"
        : "incomplete"
      : undefined;
    rows.push(current ? {
      runId: item.runId,
      profile: current.profile,
      source: "current",
      lifecycle: current.lifecycle,
      status: current.status,
      ...(current.generation ? {
        generation: current.generation.number,
        delivery: current.generation.delivery,
        ...(current.generation.outcome ? { outcome: current.generation.outcome } : {}),
      } : {}),
      branch: "active",
      ...(artifactPath ? { artifactPath, artifactCompleteness } : {}),
    } : {
      runId: item.runId,
      profile: item.latest.profile,
      source: "durable",
      lifecycle: item.latest.state,
      ...(item.latest.status ? { status: item.latest.status } : {}),
      ...(item.latest.generation ? {
        generation: item.latest.generation.number,
        delivery: item.latest.generation.delivery,
        ...(item.latest.generation.outcome ? { outcome: item.latest.generation.outcome } : {}),
      } : {}),
      branch: active ? "active" : "historical",
      ...(artifactPath ? { artifactPath, artifactCompleteness } : {}),
    });
    artifacts.delete(item.runId);
  }

  for (const [runId, artifactPath] of artifacts) {
    rows.push({
      runId,
      source: "artifact-only",
      branch: "unknown",
      artifactPath,
      artifactCompleteness: "unknown",
    });
  }
  return { rows, invalidEntries: inventory.invalidEntries };
}

function generation(row: RecoveryCatalogRow): string {
  return row.generation === undefined
    ? "g? unknown"
    : `g${row.generation} ${row.outcome ?? row.delivery ?? "unknown"}`;
}

function artifact(row: RecoveryCatalogRow): string {
  return row.artifactPath
    ? `${row.artifactPath} (${row.artifactCompleteness ?? "unknown"})`
    : "artifact unavailable";
}

export function formatRecoveryCatalog(rows: readonly RecoveryCatalogRow[]): string {
  const header = "Parent-session subagent recovery catalog after compaction:";
  if (rows.length === 0) return `${header}\nNo parent-session subagent runs or artifacts were discovered.`;
  const lines = rows.map((row) => {
    const profile = row.profile ? ` [${row.profile}]` : "";
    if (row.source === "artifact-only") {
      return `- ${row.runId}${profile} — status/branch/completeness unknown (artifact only); artifact: ${artifact(row)}`;
    }
    const source = row.source === "current" ? "current" : "latest durable";
    return `- ${row.runId}${profile} — ${source} ${row.lifecycle}/${row.status ?? "unknown"}/${generation(row)}; ${row.branch} branch; artifact: ${artifact(row)}`;
  });
  return [header, ...lines].join("\n");
}

export function formatGlobalRecoveryInventory(inventory: GlobalRecoveryInventory): string {
  const header = "Global Herdr subagent recovery inventory:";
  if (inventory.candidates.length === 0) {
    return `${header}\nNo locator or legacy journal-backed residue was discovered.${inventory.partial ? "\nScan was partial." : ""}`;
  }
  const lines = inventory.candidates.map((candidate) => {
    const profile = candidate.profile ? ` [${candidate.profile}]` : "";
    const action = candidate.actionable ? "actionable" : "report-only";
    const reason = candidate.reason ? `; ${candidate.reason}` : "";
    return `- ${candidate.parentSessionId}/${candidate.runId}${profile} — ${candidate.classification} (${action}, ${candidate.source})${reason}`;
  });
  return [
    header,
    ...lines,
    ...(inventory.partial ? ["Scan was partial; see per-session errors."] : []),
    ...inventory.errors.map((error) => `Error: ${error}`),
  ].join("\n");
}

function processAlive(pid: number, isProcessAlive: (pid: number) => boolean): boolean {
  return isProcessAlive(pid);
}

function classifyJournalRecord(
  record: HerdrStateRecord,
  options: {
    locator?: RecoveryLocatorRecord;
    source: GlobalRecoveryCandidate["source"];
    locatorPath?: string;
    isProcessAlive: (pid: number) => boolean;
    currentParentSessionId?: string;
    currentInstanceId?: string;
  },
): GlobalRecoveryCandidate {
  const base = {
    runId: record.runId,
    parentSessionId: record.parentSessionId,
    parentSessionFile: record.parentSessionFile,
    source: options.source,
    profile: record.profile,
    ownerState: options.locator?.ownerState,
    parentProcessId: record.parentProcessId,
    parentInstanceId: record.parentInstanceId,
    lifecycle: record.state,
    artifactPath: record.artifactPath ?? options.locator?.artifactPath,
    ...(record.retained ? { retained: [...record.retained] } : {}),
    ...(options.locatorPath ? { locatorPath: options.locatorPath } : {}),
  } satisfies Partial<GlobalRecoveryCandidate>;

  if (
    options.currentParentSessionId
    && options.currentInstanceId
    && record.parentSessionId === options.currentParentSessionId
    && record.parentInstanceId === options.currentInstanceId
    && record.state !== "closed"
  ) {
    return {
      ...base,
      classification: "current_live_owner",
      actionable: false,
      reason: "owned by the current parent instance",
    } as GlobalRecoveryCandidate;
  }

  if (record.state === "closed") {
    return {
      ...base,
      classification: "closed_stale_locator",
      actionable: options.locator !== undefined,
      reason: "journal is already closed",
    } as GlobalRecoveryCandidate;
  }

  const ownerLive = processAlive(record.parentProcessId, options.isProcessAlive);
  const released = options.locator?.ownerState === "released";
  if (ownerLive && !released) {
    return {
      ...base,
      classification: "live_unreleased_owner",
      actionable: false,
      reason: `parent process ${record.parentProcessId} is still live and locator is not released`,
    } as GlobalRecoveryCandidate;
  }

  if (record.state === "retained" && record.childStopped === true) {
    const incomplete = record.generation?.artifactParentPersisted === true
      && record.generation.artifactResultPersisted !== true
      && record.generation.outcome !== "aborted";
    if (!incomplete) {
      return {
        ...base,
        classification: "retained_data_only",
        actionable: true,
        reason: released || !ownerLive
          ? "retained data-only residue with released or dead owner"
          : "retained data-only residue",
      } as GlobalRecoveryCandidate;
    }
  }

  return {
    ...base,
    classification: "released_or_dead_recoverable",
    actionable: true,
    reason: released
      ? "locator released and journal is nonterminal"
      : `parent process ${record.parentProcessId} is dead and journal is nonterminal`,
  } as GlobalRecoveryCandidate;
}

export async function openValidatedParentJournal(
  parentSessionFile: string,
  expectedParentSessionId?: string,
): Promise<{
  manager: SessionManager;
  parentSessionId: string;
  parentSessionFile: string;
  entries: readonly SessionEntry[];
  branch: readonly SessionEntry[];
} | { error: string }> {
  try {
    const stats = await lstat(parentSessionFile);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { error: `parent session file is not a real regular file: ${parentSessionFile}` };
    }
    const manager = SessionManager.open(parentSessionFile);
    const parentSessionId = manager.getSessionId();
    const openedFile = manager.getSessionFile();
    if (!openedFile) return { error: "opened parent session has no file path" };
    if (expectedParentSessionId && parentSessionId !== expectedParentSessionId) {
      return { error: `opened session id ${parentSessionId} does not match locator parent ${expectedParentSessionId}` };
    }
    if (openedFile !== parentSessionFile) {
      return { error: `opened session file ${openedFile} does not match locator file ${parentSessionFile}` };
    }
    return {
      manager,
      parentSessionId,
      parentSessionFile: openedFile,
      entries: manager.getEntries(),
      branch: manager.getBranch(),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function latestActiveJournalRun(
  branch: readonly SessionEntry[],
  parentSessionId: string,
  parentSessionFile: string,
  runId: string,
): { replay?: ReplayedHerdrRun; error?: string } {
  const reconstructed = reconstructHerdrJournal(branch, parentSessionId, parentSessionFile);
  const replay = reconstructed.runs.get(runId);
  if (!replay) return { error: `run ${runId} is missing from the active parent branch` };
  if (!isHerdrStateRecord(replay.latest)) return { error: `run ${runId} journal record is malformed` };
  return { replay };
}

export async function buildGlobalRecoveryInventory(options: {
  agentDir: string;
  isProcessAlive: (pid: number) => boolean;
  includeLegacy?: boolean;
  signal?: AbortSignal;
  currentParentSessionId?: string;
  currentInstanceId?: string;
  concurrency?: number;
  listAllSessions?: () => Promise<Array<{ path: string; id?: string }>>;
}): Promise<GlobalRecoveryInventory> {
  const candidates: GlobalRecoveryCandidate[] = [];
  const errors: string[] = [];
  let partial = false;
  const seen = new Set<string>();

  const pushUnique = (candidate: GlobalRecoveryCandidate) => {
    const key = `${candidate.parentSessionId}::${candidate.runId}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  let locators: EnumeratedRecoveryLocator[] = [];
  try {
    locators = await enumerateRecoveryLocators(options.agentDir);
  } catch (error) {
    partial = true;
    errors.push(`locator enumeration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const entry of locators) {
    if (options.signal?.aborted) {
      partial = true;
      errors.push("locator scan aborted");
      break;
    }
    if (entry.error || !entry.record) {
      pushUnique({
        runId: entry.runId,
        parentSessionId: entry.parentSessionId,
        classification: "malformed",
        source: "locator",
        locatorPath: entry.path,
        actionable: false,
        reason: entry.error ?? "locator record missing",
      });
      continue;
    }
    const locator = entry.record;
    const opened = await openValidatedParentJournal(locator.parentSessionFile, locator.parentSessionId);
    if ("error" in opened) {
      pushUnique({
        runId: locator.runId,
        parentSessionId: locator.parentSessionId,
        parentSessionFile: locator.parentSessionFile,
        classification: "identity_mismatched",
        source: "locator",
        ownerState: locator.ownerState,
        parentProcessId: locator.parentProcessId,
        parentInstanceId: locator.parentInstanceId,
        profile: locator.profile,
        artifactPath: locator.artifactPath,
        locatorPath: entry.path,
        actionable: false,
        reason: opened.error,
      });
      continue;
    }
    const latest = latestActiveJournalRun(
      opened.branch,
      opened.parentSessionId,
      opened.parentSessionFile,
      locator.runId,
    );
    if (latest.error || !latest.replay) {
      pushUnique({
        runId: locator.runId,
        parentSessionId: locator.parentSessionId,
        parentSessionFile: locator.parentSessionFile,
        classification: "identity_mismatched",
        source: "locator",
        ownerState: locator.ownerState,
        parentProcessId: locator.parentProcessId,
        parentInstanceId: locator.parentInstanceId,
        profile: locator.profile,
        artifactPath: locator.artifactPath,
        locatorPath: entry.path,
        actionable: false,
        reason: latest.error ?? "journal replay missing",
      });
      continue;
    }
    const record = latest.replay.latest;
    if (
      record.parentInstanceId !== locator.parentInstanceId
      || record.parentProcessId !== locator.parentProcessId
      || record.parentSessionFile !== locator.parentSessionFile
    ) {
      pushUnique({
        runId: locator.runId,
        parentSessionId: locator.parentSessionId,
        parentSessionFile: locator.parentSessionFile,
        classification: "identity_mismatched",
        source: "locator",
        ownerState: locator.ownerState,
        parentProcessId: locator.parentProcessId,
        parentInstanceId: locator.parentInstanceId,
        profile: locator.profile,
        artifactPath: locator.artifactPath,
        locatorPath: entry.path,
        actionable: false,
        reason: "locator ownership facts do not match the authoritative journal record",
      });
      continue;
    }
    pushUnique(classifyJournalRecord(record, {
      locator,
      source: "locator",
      locatorPath: entry.path,
      isProcessAlive: options.isProcessAlive,
      currentParentSessionId: options.currentParentSessionId,
      currentInstanceId: options.currentInstanceId,
    }));
  }

  if (options.includeLegacy) {
    const listAll = options.listAllSessions
      ?? (async () => (await SessionManager.listAll()).map((session) => ({ path: session.path, id: session.id })));
    let sessions: Array<{ path: string; id?: string }> = [];
    try {
      sessions = await listAll();
    } catch (error) {
      partial = true;
      errors.push(`legacy session list failed: ${error instanceof Error ? error.message : String(error)}`);
      sessions = [];
    }

    const concurrency = Math.max(1, options.concurrency ?? 4);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(sessions.length, 1)) }, async () => {
      while (index < sessions.length) {
        if (options.signal?.aborted) {
          partial = true;
          errors.push("legacy scan aborted");
          return;
        }
        const current = sessions[index++]!;
        const opened = await openValidatedParentJournal(current.path, current.id);
        if ("error" in opened) {
          partial = true;
          errors.push(`${current.path}: ${opened.error}`);
          continue;
        }
        const inventory = inventoryHerdrJournal(opened.entries, opened.parentSessionId, opened.parentSessionFile);
        const active = reconstructHerdrJournal(opened.branch, opened.parentSessionId, opened.parentSessionFile);
        for (const [runId, replay] of active.runs) {
          const record = replay.latest;
          if (record.state === "closed") continue;
          const key = `${record.parentSessionId}::${runId}`;
          if (seen.has(key)) continue;
          const artifactPath = record.artifactPath ?? resolveArtifactLocation({
            agentDir: options.agentDir,
            parentSessionId: record.parentSessionId,
            runId: record.runId,
          }).path;
          const ownerState = processAlive(record.parentProcessId, options.isProcessAlive) ? "active" as const : "released" as const;
          try {
            await createRecoveryLocator(options.agentDir, {
              runId: record.runId,
              parentSessionId: record.parentSessionId,
              parentSessionFile: record.parentSessionFile,
              parentInstanceId: record.parentInstanceId,
              parentProcessId: record.parentProcessId,
              profile: record.profile,
              artifactPath,
              createdAt: record.at,
              ownerState,
            });
          } catch (error) {
            partial = true;
            errors.push(`legacy locator backfill ${record.parentSessionId}/${runId}: ${error instanceof Error ? error.message : String(error)}`);
          }
          pushUnique(classifyJournalRecord({
            ...record,
            artifactPath,
          }, {
            source: "legacy-journal",
            isProcessAlive: options.isProcessAlive,
            currentParentSessionId: options.currentParentSessionId,
            currentInstanceId: options.currentInstanceId,
            locator: {
              schemaVersion: 1,
              runId: record.runId,
              parentSessionId: record.parentSessionId,
              parentSessionFile: record.parentSessionFile,
              parentInstanceId: record.parentInstanceId,
              parentProcessId: record.parentProcessId,
              profile: record.profile,
              artifactPath,
              createdAt: record.at,
              ownerState,
            },
          }));
        }
        void inventory;
      }
    });
    await Promise.all(workers);
  }

  candidates.sort((left, right) => {
    const parent = left.parentSessionId.localeCompare(right.parentSessionId);
    return parent !== 0 ? parent : left.runId.localeCompare(right.runId);
  });
  return { candidates, partial, errors };
}

export { HERDR_STATE_CUSTOM_TYPE };
