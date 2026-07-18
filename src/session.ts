import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { AgentStatus } from "./herdr.ts";
import type { ProfileName } from "./profiles.ts";
import type { WorkerCleanup, WorktreeFacts } from "./worktree.ts";

export const HERDR_STATE_CUSTOM_TYPE = "herdr-subagent-state";

export type HerdrLifecycleState =
  | "starting"
  | "live"
  | "generation_pending"
  | "result_ready"
  | "result_queued"
  | "result_delivered"
  | "stopping"
  | "retained"
  | "closed";

export interface JournalGeneration {
  number: number;
  baselineEntryId: string | null;
  delivery: "pending" | "ready" | "queued" | "delivered";
  resultEntryId?: string;
  returned?: boolean;
}

export interface HerdrStateRecord {
  state: HerdrLifecycleState;
  at: number;
  parentSessionId: string;
  parentSessionFile: string;
  parentEntryId: string | null;
  parentInstanceId: string;
  parentProcessId: number;
  runId: string;
  childSessionId: string;
  childSessionDir: string;
  childSessionPath?: string;
  childCwd: string;
  terminalId: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  profile: ProfileName;
  generation?: JournalGeneration;
  result?: ChildResult;
  worktree?: WorktreeFacts;
  retained?: readonly string[];
  workerCleanup?: WorkerCleanup;
  error?: string;
}

export interface ReplayedHerdrRun {
  latest: HerdrStateRecord;
  readyGenerations: ReadonlySet<number>;
  latestResult?: ChildResult;
}

const JOURNAL_STATES = new Set<HerdrLifecycleState>([
  "starting", "live", "generation_pending", "result_ready", "result_queued",
  "result_delivered", "stopping", "retained", "closed",
]);

function isRecord(value: unknown): value is HerdrStateRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return JOURNAL_STATES.has(record.state as HerdrLifecycleState)
    && typeof record.at === "number"
    && Number.isFinite(record.at)
    && typeof record.parentSessionId === "string"
    && typeof record.parentSessionFile === "string"
    && (typeof record.parentEntryId === "string" || record.parentEntryId === null)
    && typeof record.parentInstanceId === "string"
    && typeof record.parentProcessId === "number"
    && Number.isSafeInteger(record.parentProcessId)
    && record.parentProcessId > 0
    && typeof record.runId === "string"
    && typeof record.childSessionId === "string"
    && typeof record.childSessionDir === "string"
    && typeof record.childCwd === "string"
    && typeof record.terminalId === "string"
    && typeof record.paneId === "string"
    && typeof record.tabId === "string"
    && typeof record.workspaceId === "string"
    && (record.profile === "scout" || record.profile === "researcher" || record.profile === "worker");
}

export function reconstructHerdrJournal(
  branch: readonly SessionEntry[],
  parentSessionId: string,
  parentSessionFile: string,
): { runs: Map<string, ReplayedHerdrRun>; invalidEntries: number } {
  const replayed = new Map<string, { latest: HerdrStateRecord; readyGenerations: Set<number>; latestResult?: ChildResult }>();
  let invalidEntries = 0;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== HERDR_STATE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data)) {
      invalidEntries++;
      continue;
    }
    const record = entry.data;
    if (record.parentSessionId !== parentSessionId || record.parentSessionFile !== parentSessionFile) continue;
    const current = replayed.get(record.runId) ?? { latest: record, readyGenerations: new Set<number>() };
    current.latest = record;
    if (record.state === "result_ready" && record.generation && record.result) {
      current.readyGenerations.add(record.generation.number);
      current.latestResult = record.result;
    }
    replayed.set(record.runId, current);
  }
  return { runs: replayed, invalidEntries };
}

export interface ChildSessionLocation {
  childSessionId: string;
  childSessionDir: string;
  childCwd: string;
}

export interface ChildSessionSnapshot {
  path: string;
  manager: SessionManager;
}

export interface ChildResult {
  childEntryId: string;
  text: string;
  message: AssistantMessage;
}

export function createChildSessionLocation(
  parentSessionId: string,
  runId: string,
  childCwd: string,
  agentDir = getAgentDir(),
): ChildSessionLocation {
  return {
    childSessionId: `herdr-${runId}`,
    childSessionDir: join(agentDir, "herdr-subagents", parentSessionId, runId),
    childCwd,
  };
}

export async function openChildSession(location: ChildSessionLocation): Promise<ChildSessionSnapshot | undefined> {
  const matches = (await SessionManager.list(location.childCwd, location.childSessionDir))
    .filter(({ id }) => id === location.childSessionId);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error(`Child session identity is ambiguous: ${location.childSessionId}`);
  const path = matches[0]!.path;
  const manager = SessionManager.open(path, location.childSessionDir, location.childCwd);
  if (manager.getSessionId() !== location.childSessionId) {
    throw new Error(`Child session identity mismatch: expected ${location.childSessionId}`);
  }
  return { path, manager };
}

export async function captureChildCursor(
  location: ChildSessionLocation,
  firstGeneration = false,
): Promise<{ baselineEntryId: string | null; childSessionPath?: string }> {
  if (firstGeneration) return { baselineEntryId: null };
  const snapshot = await openChildSession(location);
  if (!snapshot) throw new Error(`Child session is not persisted: ${location.childSessionId}`);
  const branch = snapshot.manager.getBranch();
  const baselineEntryId = snapshot.manager.getLeafId();
  if (!baselineEntryId || !branch.some(({ id }) => id === baselineEntryId)) {
    throw new Error(`Child session active-branch cursor is missing: ${location.childSessionId}`);
  }
  return { baselineEntryId, childSessionPath: snapshot.path };
}

export async function readChildResult(
  location: ChildSessionLocation,
  baselineEntryId: string | null,
  herdrStatus: AgentStatus,
): Promise<(ChildResult & { childSessionPath: string }) | undefined> {
  if (herdrStatus === "working") return undefined;
  const snapshot = await openChildSession(location);
  if (!snapshot) return undefined;
  const branch = snapshot.manager.getBranch();
  let start = 0;
  if (baselineEntryId !== null) {
    const baselineIndex = branch.findIndex(({ id }) => id === baselineEntryId);
    if (baselineIndex < 0) {
      throw new Error(`Child session baseline is not on the active branch: ${baselineEntryId}`);
    }
    start = baselineIndex + 1;
  }

  let selected: ChildResult | undefined;
  for (const entry of branch.slice(start)) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const assistant = entry.message as AssistantMessage;
    if (assistant.stopReason === "toolUse") continue;
    selected = {
      childEntryId: entry.id,
      text: assistant.content
        .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
        .map(({ text }) => text)
        .join(""),
      message: assistant,
    };
  }
  return selected ? { ...selected, childSessionPath: snapshot.path } : undefined;
}
