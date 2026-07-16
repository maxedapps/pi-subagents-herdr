import { createHash } from "node:crypto";
import type { HerdrRequestClient } from "../herdr/client.ts";
import type { PaneInfo, PaneProcessInfo, TabInfo } from "../herdr/protocol.ts";

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
      const key = this.key(workspaceId, group); const existing = this.#groups.get(key); if (existing) return existing;
      const partial = this.#partials.get(key); if (partial) throw new Error(`Delegation group ${group} has a retained partial tab ${partial.tab.tab_id}; reconcile it before retrying`);
      const created = await this.client.createTab({ workspace_id: workspaceId, label: `subagents:${group}`, focus: false }, signal);
      this.#partials.set(key, created); onCreated?.(created);
      const processInfo = await this.client.getPaneProcessInfo(created.rootPane.pane_id, signal);
      const result: DelegationGroup = { key, workspaceId, group, tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id, rootProcessBaseline: processBaseline(processInfo) };
      this.#partials.delete(key); this.#groups.set(key, result); return result;
    });
  }
  async verifyAnchor(group: DelegationGroup, signal?: AbortSignal): Promise<{ verified: boolean; currentPaneId?: string; reason?: string }> {
    const panes = await this.client.listPanes(group.workspaceId, signal); const pane = panes.find((candidate) => candidate.terminal_id === group.rootTerminalId);
    if (!pane || pane.tab_id !== group.tabId) return { verified: false, reason: "Anchor terminal is absent or moved out of the dedicated tab" };
    const current = processBaseline(await this.client.getPaneProcessInfo(pane.pane_id, signal));
    if (current !== group.rootProcessBaseline) return { verified: false, currentPaneId: pane.pane_id, reason: "Anchor process baseline changed" };
    return { verified: true, currentPaneId: pane.pane_id };
  }
}
