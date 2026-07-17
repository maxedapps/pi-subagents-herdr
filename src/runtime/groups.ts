import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HerdrRequestClient } from "../herdr/client.ts";
import type { PaneInfo, PaneProcessInfo, TabInfo } from "../herdr/protocol.ts";

const PLACEMENT_READY_TIMEOUT_MS = 250;
const PLACEMENT_READY_POLL_MS = 20;

export interface DelegationPlacementIdentity {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly rootPaneId: string;
  readonly rootTerminalId: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Placement reconciliation aborted");
}

function placementMismatch(snapshot: Awaited<ReturnType<HerdrRequestClient["snapshot"]>>, placement: DelegationPlacementIdentity): { ready: boolean; reason?: string; permanent?: boolean } {
  const workspaces = snapshot.workspaces.filter((candidate) => candidate.workspace_id === placement.workspaceId);
  const tabs = snapshot.tabs.filter((candidate) => candidate.tab_id === placement.tabId);
  const panesById = snapshot.panes.filter((candidate) => candidate.pane_id === placement.rootPaneId);
  const panesByTerminal = snapshot.panes.filter((candidate) => candidate.terminal_id === placement.rootTerminalId);
  if (workspaces.length > 1 || tabs.length > 1 || panesById.length > 1 || panesByTerminal.length > 1) {
    return { ready: false, permanent: true, reason: "fresh topology contains ambiguous duplicate placement identities" };
  }
  const tab = tabs[0];
  const pane = panesById[0];
  const terminalPane = panesByTerminal[0];
  if (tab && tab.workspace_id !== placement.workspaceId) return { ready: false, permanent: true, reason: `tab ${placement.tabId} moved outside workspace ${placement.workspaceId}` };
  if (pane && (pane.workspace_id !== placement.workspaceId || pane.tab_id !== placement.tabId || pane.terminal_id !== placement.rootTerminalId)) {
    return { ready: false, permanent: true, reason: `root pane ${placement.rootPaneId} no longer matches the returned workspace/tab/terminal identity` };
  }
  if (terminalPane && (terminalPane.workspace_id !== placement.workspaceId || terminalPane.tab_id !== placement.tabId || terminalPane.pane_id !== placement.rootPaneId)) {
    return { ready: false, permanent: true, reason: `root terminal ${placement.rootTerminalId} moved or was rebound` };
  }
  if (workspaces.length === 1 && tab && pane && terminalPane) return { ready: true };
  return { ready: false, reason: "exact workspace/tab/root-pane/root-terminal identity is not yet visible" };
}

/** Bounded fresh topology barrier for an exact Herdr placement returned by creation. */
export async function reconcileExactPlacement(
  client: HerdrRequestClient,
  placement: DelegationPlacementIdentity,
  signal?: AbortSignal,
  timeoutMs = PLACEMENT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let reason = "exact placement has not been checked";
  while (true) {
    throwIfAborted(signal);
    const state = placementMismatch(await client.snapshot(signal), placement);
    if (state.ready) return;
    reason = state.reason ?? reason;
    if (state.permanent || Date.now() >= deadline) {
      throw new Error(`Delegation placement ${placement.workspaceId}/${placement.tabId}/${placement.rootPaneId}/${placement.rootTerminalId} is not ready: ${reason}`);
    }
    await delay(Math.min(PLACEMENT_READY_POLL_MS, Math.max(1, deadline - Date.now())), undefined, signal === undefined ? undefined : { signal });
  }
}

export interface DelegationGroup {
  readonly key: string; readonly workspaceId: string; readonly group: string; readonly tabId: string;
  readonly rootPaneId: string; readonly rootTerminalId: string; readonly rootProcessBaseline: string;
}
export interface PartialDelegationGroup { readonly tab: TabInfo; readonly rootPane: PaneInfo; }
class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail; let release!: () => void; this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous; try { return await operation(); } finally { release(); }
  }
}
export function processBaseline(info: PaneProcessInfo): string {
  const stable = { shell_pid: info.shell_pid ?? null, tty: info.tty ?? null, foreground_process_group_id: info.foreground_process_group_id ?? null, foreground_processes: info.foreground_processes ?? [] };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** Current destructive-boundary proof: exact pane identity plus a known idle shell. */
export function verifyIdleShell(info: PaneProcessInfo): { readonly idle: true } | { readonly idle: false; readonly reason: string } {
  if (!Number.isSafeInteger(info.shell_pid) || (info.shell_pid as number) < 1) return { idle: false, reason: "shell PID is unavailable" };
  if (!Array.isArray(info.foreground_processes)) return { idle: false, reason: "foreground process list is unavailable" };
  if (info.foreground_processes.length === 0) return { idle: true };
  if (info.foreground_processes.length === 1 && info.foreground_processes[0]!.pid === info.shell_pid) return { idle: true };
  return { idle: false, reason: `foreground process list contains ${info.foreground_processes.length} active/non-shell process(es)` };
}

export class DelegationGroupManager {
  #groups = new Map<string, DelegationGroup>(); #queues = new Map<string, SerialQueue>(); #partials = new Map<string, PartialDelegationGroup>();
  constructor(private readonly client: HerdrRequestClient) {}
  key(workspaceId: string, group: string): string { return `${workspaceId}\0${group}`; }
  get(workspaceId: string, group: string): DelegationGroup | undefined { return this.#groups.get(this.key(workspaceId, group)); }
  list(): readonly DelegationGroup[] { return [...this.#groups.values()]; }
  partial(workspaceId: string, group: string): PartialDelegationGroup | undefined { return this.#partials.get(this.key(workspaceId, group)); }
  listPartials(): readonly PartialDelegationGroup[] { return [...this.#partials.values()]; }
  /** Restore immutable active-branch group provenance; fresh stop checks revalidate the anchor. */
  restoreOwned(group: Omit<DelegationGroup, "key">): DelegationGroup {
    const key = this.key(group.workspaceId, group.group);
    const restored: DelegationGroup = { key, ...group };
    const current = this.#groups.get(key);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(restored)) throw new Error(`Delegation group ${group.group} recovery conflicts with existing immutable provenance`);
    this.#groups.set(key, restored);
    return restored;
  }
  /** Forget only the exact group whose tab and stable anchor identities were closed. */
  forgetClosed(group: DelegationGroup): void {
    const current = this.#groups.get(group.key);
    if (!current || current.tabId !== group.tabId || current.rootTerminalId !== group.rootTerminalId) {
      throw new Error(`Refused to forget delegation group ${group.group}: identity no longer matches`);
    }
    this.#groups.delete(group.key);
  }
  async serialize<T>(workspaceId: string, group: string, operation: () => Promise<T>): Promise<T> {
    const key = this.key(workspaceId, group); let queue = this.#queues.get(key); if (!queue) { queue = new SerialQueue(); this.#queues.set(key, queue); }
    return queue.run(operation);
  }
  ensure(workspaceId: string, group: string, signal?: AbortSignal, onCreated?: (created: { tab: TabInfo; rootPane: PaneInfo }) => void): Promise<DelegationGroup> {
    return this.serialize(workspaceId, group, async () => {
      const key = this.key(workspaceId, group); const existing = this.#groups.get(key);
      if (existing) {
        await reconcileExactPlacement(this.client, existing, signal);
        const processInfo = await this.client.getPaneProcessInfo(existing.rootPaneId, signal);
        if (processInfo.pane_id !== existing.rootPaneId) throw new Error(`Delegation group ${group} process probe returned a different root pane`);
        return existing;
      }
      const partial = this.#partials.get(key); if (partial) throw new Error(`Delegation group ${group} has a retained partial tab ${partial.tab.tab_id}; reconcile it before retrying`);
      const created = await this.client.createTab({ workspace_id: workspaceId, label: `subagents:${group}`, focus: false }, signal);
      this.#partials.set(key, created); onCreated?.(created);
      const placement: DelegationPlacementIdentity = { workspaceId, tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id };
      await reconcileExactPlacement(this.client, placement, signal);
      const processInfo = await this.client.getPaneProcessInfo(created.rootPane.pane_id, signal);
      if (processInfo.pane_id !== created.rootPane.pane_id) throw new Error(`Delegation group ${group} process probe returned a different root pane`);
      const result: DelegationGroup = { key, workspaceId, group, tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id, rootProcessBaseline: processBaseline(processInfo) };
      this.#partials.delete(key); this.#groups.set(key, result); return result;
    });
  }
  async verifyAnchor(group: DelegationGroup, signal?: AbortSignal): Promise<{ verified: boolean; currentPaneId?: string; reason?: string }> {
    const panes = await this.client.listPanes(group.workspaceId, signal); const pane = panes.find((candidate) => candidate.terminal_id === group.rootTerminalId);
    if (!pane || pane.tab_id !== group.tabId) return { verified: false, reason: "Anchor terminal is absent or moved out of the dedicated tab" };
    const idle = verifyIdleShell(await this.client.getPaneProcessInfo(pane.pane_id, signal));
    if (!idle.idle) return { verified: false, currentPaneId: pane.pane_id, reason: `Anchor is not a known idle shell: ${idle.reason}` };
    return { verified: true, currentPaneId: pane.pane_id };
  }
}
