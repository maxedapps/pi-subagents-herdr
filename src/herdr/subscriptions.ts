import type { AgentInfo, HerdrSubscriptionEvent, PaneInfo, PaneLayout, SessionSnapshot, Subscription, TabInfo, WorkspaceInfo } from "./protocol.ts";
import type { HerdrClient } from "./client.ts";

export type HerdrHealth = "connecting" | "connected" | "unavailable";

export class HerdrLiveCache {
  health: HerdrHealth = "unavailable";
  lastSnapshotAt?: number;
  lastEventAt?: number;
  readonly workspaces = new Map<string, WorkspaceInfo>();
  readonly tabs = new Map<string, TabInfo>();
  readonly panes = new Map<string, PaneInfo>();
  readonly agents = new Map<string, AgentInfo>();
  readonly layouts = new Map<string, PaneLayout>();
  focusedWorkspaceId: string | undefined; focusedTabId: string | undefined; focusedPaneId: string | undefined;

  replace(snapshot: SessionSnapshot, now = Date.now()): void {
    this.workspaces.clear(); this.tabs.clear(); this.panes.clear(); this.agents.clear(); this.layouts.clear();
    for (const item of snapshot.workspaces) this.workspaces.set(item.workspace_id, item);
    for (const item of snapshot.tabs) this.tabs.set(item.tab_id, item);
    for (const item of snapshot.panes) this.panes.set(item.pane_id, item);
    for (const item of snapshot.agents) this.agents.set(item.terminal_id, item);
    for (const item of snapshot.layouts) this.layouts.set(item.tab_id, item);
    this.focusedWorkspaceId = typeof snapshot.focused_workspace_id === "string" ? snapshot.focused_workspace_id : undefined;
    this.focusedTabId = typeof snapshot.focused_tab_id === "string" ? snapshot.focused_tab_id : undefined;
    this.focusedPaneId = typeof snapshot.focused_pane_id === "string" ? snapshot.focused_pane_id : undefined;
    this.lastSnapshotAt = now;
  }

  #removeTab(id: string): void {
    this.tabs.delete(id); this.layouts.delete(id);
    for (const [key, pane] of this.panes) if (pane.tab_id === id) { this.panes.delete(key); this.agents.delete(pane.terminal_id); }
    if (this.focusedTabId === id) this.focusedTabId = undefined;
  }
  #removeWorkspace(id: string): void {
    this.workspaces.delete(id);
    for (const [key, tab] of this.tabs) if (tab.workspace_id === id) this.#removeTab(key);
    for (const [key, pane] of this.panes) if (pane.workspace_id === id) { this.panes.delete(key); this.agents.delete(pane.terminal_id); }
    if (this.focusedWorkspaceId === id) this.focusedWorkspaceId = undefined;
  }

  apply(event: HerdrSubscriptionEvent, now = Date.now()): void {
    const data = event.data; this.lastEventAt = now;
    switch (event.event) {
      case "workspace_created": case "workspace_updated": case "worktree_created": case "worktree_opened": { const workspace = data.workspace as WorkspaceInfo; this.workspaces.set(workspace.workspace_id, workspace); break; }
      case "worktree_removed": break;
      case "workspace_closed": this.#removeWorkspace(data.workspace_id as string); break;
      case "workspace_focused": { const id = data.workspace_id as string; this.focusedWorkspaceId = id; for (const [key, item] of this.workspaces) this.workspaces.set(key, { ...item, focused: key === id }); break; }
      case "tab_created": { const tab = data.tab as TabInfo; this.tabs.set(tab.tab_id, tab); break; }
      case "tab_closed": this.#removeTab(data.tab_id as string); break;
      case "tab_focused": { const id = data.tab_id as string; const workspaceId = data.workspace_id as string; this.focusedTabId = id; for (const [key, item] of this.tabs) if (item.workspace_id === workspaceId) this.tabs.set(key, { ...item, focused: key === id }); break; }
      case "pane_created": { const pane = data.pane as PaneInfo; this.panes.set(pane.pane_id, pane); break; }
      case "pane_moved": {
        const previous = data.previous_pane_id as string; const pane = data.pane as PaneInfo;
        this.panes.delete(previous);
        if (typeof data.closed_tab_id === "string") this.#removeTab(data.closed_tab_id);
        if (typeof data.closed_workspace_id === "string") this.#removeWorkspace(data.closed_workspace_id);
        if (data.created_workspace && typeof data.created_workspace === "object") { const workspace = data.created_workspace as WorkspaceInfo; this.workspaces.set(workspace.workspace_id, workspace); }
        if (data.created_tab && typeof data.created_tab === "object") { const tab = data.created_tab as TabInfo; this.tabs.set(tab.tab_id, tab); }
        this.panes.set(pane.pane_id, pane);
        const agent = this.agents.get(pane.terminal_id); if (agent) this.agents.set(pane.terminal_id, { ...agent, pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id });
        break;
      }
      case "pane_closed": case "pane_exited": { const id = data.pane_id as string; const pane = this.panes.get(id); this.panes.delete(id); if (pane) this.agents.delete(pane.terminal_id); if (this.focusedPaneId === id) this.focusedPaneId = undefined; break; }
      case "pane_focused": { const id = data.pane_id as string; const workspaceId = data.workspace_id as string; this.focusedPaneId = id; for (const [key, item] of this.panes) if (item.workspace_id === workspaceId) this.panes.set(key, { ...item, focused: key === id }); for (const [key, item] of this.agents) if (item.workspace_id === workspaceId) this.agents.set(key, { ...item, focused: item.pane_id === id }); break; }
      case "layout_updated": { const layout = data.layout as PaneLayout; this.layouts.set(layout.tab_id, layout); break; }
      case "pane_agent_status_changed": case "pane.agent_status_changed": {
        const paneId = data.pane_id as string; const agentStatus = data.agent_status as PaneInfo["agent_status"];
        const pane = this.panes.get(paneId); if (pane) this.panes.set(paneId, { ...pane, agent_status: agentStatus });
        if (pane) { const agent = this.agents.get(pane.terminal_id); if (agent) this.agents.set(pane.terminal_id, { ...agent, agent_status: agentStatus }); }
        break;
      }
      case "pane.output_matched": case "pane.scroll_changed": break;
    }
  }

  findPaneByTerminal(terminalId: string): PaneInfo | undefined { return [...this.panes.values()].find((pane) => pane.terminal_id === terminalId); }
}

const BASE_SUBSCRIPTIONS: readonly Subscription[] = [
  { type: "workspace.created" }, { type: "workspace.updated" }, { type: "workspace.closed" }, { type: "workspace.focused" },
  { type: "worktree.created" }, { type: "worktree.opened" }, { type: "worktree.removed" },
  { type: "tab.created" }, { type: "tab.closed" }, { type: "tab.focused" },
  { type: "pane.created" }, { type: "pane.closed" }, { type: "pane.moved" }, { type: "pane.exited" }, { type: "pane.focused" },
  { type: "layout.updated" },
];

class SerialMutationQueue {
  #tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface SubscriptionManagerOptions {
  readonly client: HerdrClient; readonly cache?: HerdrLiveCache; readonly ownedPaneIds: () => readonly string[];
  readonly reconcileIntervalMs?: number; readonly backoffMs?: readonly number[]; readonly onHealth?: (health: HerdrHealth, error?: unknown) => void;
  /** Called after an authoritative health, snapshot, or event change. */
  readonly onChange?: () => void;
}
export class HerdrSubscriptionManager {
  readonly cache: HerdrLiveCache;
  #client: HerdrClient; #ownedPaneIds: () => readonly string[]; #intervalMs: number; #backoff: readonly number[];
  #onHealth: ((health: HerdrHealth, error?: unknown) => void) | undefined; #onChange: (() => void) | undefined; #controller: AbortController | undefined; #reconcileTimer: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined; #retryWake: (() => void) | undefined; #run: Promise<void> | undefined; #stopped = true; #generation = 0;
  #mutations = new SerialMutationQueue();
  constructor(options: SubscriptionManagerOptions) {
    this.#client = options.client; this.cache = options.cache ?? new HerdrLiveCache(); this.#ownedPaneIds = options.ownedPaneIds;
    this.#intervalMs = options.reconcileIntervalMs ?? 30_000; this.#backoff = options.backoffMs ?? [100, 250, 500, 1_000, 2_000]; this.#onHealth = options.onHealth; this.#onChange = options.onChange;
  }
  start(): Promise<void> { if (this.#run) return Promise.resolve(); this.#stopped = false; this.#run = this.#loop().finally(() => { this.#run = undefined; }); return Promise.resolve(); }
  async stop(): Promise<void> { this.#stopped = true; this.#generation += 1; this.#controller?.abort(); this.#clearReconcileTimer(); if (this.#retryTimer) clearTimeout(this.#retryTimer); this.#retryTimer = undefined; this.#retryWake?.(); this.#retryWake = undefined; await this.#run?.catch(() => undefined); }
  ownershipChanged(): void { this.#generation += 1; this.#controller?.abort(new Error("Herdr subscription ownership set changed")); }
  #health(health: HerdrHealth, error?: unknown) { this.cache.health = health; this.#onHealth?.(health, error); this.#onChange?.(); }
  #clearReconcileTimer(): void { if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer); this.#reconcileTimer = undefined; }
  #scheduleReconcile(controller: AbortController, generation: number): void {
    this.#clearReconcileTimer();
    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = undefined;
      void this.#reconcile(controller.signal, generation).then(() => {
        if (!this.#stopped && generation === this.#generation && !controller.signal.aborted) this.#scheduleReconcile(controller, generation);
      }).catch((error) => {
        if (!this.#stopped && generation === this.#generation && !controller.signal.aborted) { this.#health("unavailable", error); controller.abort(error); }
      });
    }, this.#intervalMs);
    this.#reconcileTimer.unref?.();
  }
  async #loop(): Promise<void> {
    let failures = 0;
    while (!this.#stopped) {
      const generation = this.#generation; this.#health("connecting"); const controller = new AbortController(); this.#controller = controller;
      let stream: Awaited<ReturnType<HerdrClient["subscribe"]>> | undefined;
      try {
        const owned = [...new Set(this.#ownedPaneIds())].sort();
        const subscriptions: Subscription[] = [...BASE_SUBSCRIPTIONS, ...owned.map((pane_id): Subscription => ({ type: "pane.agent_status_changed", pane_id }))];
        stream = await this.#client.subscribe(subscriptions, controller.signal);
        await this.#mutations.run(async () => {
          const snapshot = await this.#client.snapshot(controller.signal);
          if (this.#stopped || generation !== this.#generation || controller.signal.aborted) throw controller.signal.reason ?? new Error("Stale Herdr bootstrap snapshot");
          this.cache.replace(snapshot); this.#onChange?.();
        });
        if (this.#stopped || generation !== this.#generation) continue;
        failures = 0; this.#health("connected"); this.#scheduleReconcile(controller, generation);
        for await (const event of stream) {
          if (this.#stopped || generation !== this.#generation) break;
          await this.#mutations.run(() => { if (!this.#stopped && generation === this.#generation) { this.cache.apply(event); this.#onChange?.(); } });
        }
        if (!this.#stopped && generation === this.#generation) throw new Error("Herdr subscription disconnected");
      } catch (error) {
        if (this.#stopped) break;
        if (generation !== this.#generation) continue;
        this.#health("unavailable", error); const delay = this.#backoff[Math.min(failures++, this.#backoff.length - 1)] ?? 2_000;
        await new Promise<void>((resolve) => { this.#retryWake = resolve; this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined; this.#retryWake = undefined; resolve(); }, delay); this.#retryTimer.unref?.(); });
      } finally { this.#clearReconcileTimer(); stream?.close(); }
    }
  }
  #reconcile(signal: AbortSignal, generation: number): Promise<void> {
    return this.#mutations.run(async () => {
      const snapshot = await this.#client.snapshot(signal);
      if (signal.aborted || this.#stopped || generation !== this.#generation) throw signal.reason ?? new Error("Stale Herdr reconciliation snapshot");
      this.cache.replace(snapshot); this.#onChange?.();
    });
  }
}
