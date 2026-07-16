import type { HerdrRequestClient } from "../herdr/client.ts";
import type { AgentInfo, PaneInfo } from "../herdr/protocol.ts";
import type { DelegationGroup, DelegationGroupManager } from "./groups.ts";
import type { WorktreeRecord } from "../worktrees/contracts.ts";
import { type ActiveBranchOwnershipJournal, type OwnershipJournalData } from "./ownership.ts";

export interface PartialCleanupReport { readonly closedPaneIds: readonly string[]; readonly closedTabIds: readonly string[]; readonly retained: readonly string[]; }
export class PartialStartRecorder {
  current: OwnershipJournalData;
  constructor(private readonly journal: ActiveBranchOwnershipJournal, intent: OwnershipJournalData) { this.current = intent; }
  recordWorktree(worktree: WorktreeRecord): void {
    this.current = this.journal.append(this.current, "worktree_created", {
      repositoryId: worktree.repositoryId,
      commonGitDir: worktree.commonGitDir,
      herdrRepositoryKey: worktree.herdrRepositoryKey,
      ...(worktree.sourceWorkspaceId === undefined ? {} : { worktreeSourceWorkspaceId: worktree.sourceWorkspaceId }),
      worktreeWorkspaceId: worktree.workspaceId,
      checkoutPath: worktree.checkoutPath,
      worktreeBranch: worktree.branch,
      worktreeBase: worktree.base,
      worktreeInitialTabId: worktree.createdRoot.tabId,
      worktreeInitialRootPaneId: worktree.createdRoot.rootPaneId,
      worktreeInitialRootTerminalId: worktree.createdRoot.rootTerminalId,
    });
  }
  recordCreatedGroupIdentity(created: { tab: { tab_id: string }; rootPane: { pane_id: string; terminal_id: string } }): void { this.current = this.journal.append(this.current, "created", { tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id }); }
  recordGroup(group: DelegationGroup): void { this.current = this.journal.append(this.current, "created", { tabId: group.tabId, rootPaneId: group.rootPaneId, rootTerminalId: group.rootTerminalId, rootProcessBaseline: group.rootProcessBaseline }); }
  recordAgent(agent: AgentInfo): void { this.current = this.journal.append(this.current, "started", { paneId: agent.pane_id, terminalId: agent.terminal_id, ...(agent.agent_session ? { nativeSession: { source: agent.agent_session.source, kind: agent.agent_session.kind, value: agent.agent_session.value } } : {}) }); }
  fail(): void { this.current = this.journal.append(this.current, "failed", {}); }
}

async function resolveProvenPane(client: HerdrRequestClient, terminalId: string, native?: { kind: "id" | "path"; value: string; source: string }, signal?: AbortSignal): Promise<PaneInfo | undefined> {
  const panes = await client.listPanes(undefined, signal); const pane = panes.find((candidate) => candidate.terminal_id === terminalId); if (!pane) return undefined;
  if (native) { const agents = await client.listAgents(signal); const agent = agents.find((candidate) => candidate.terminal_id === terminalId); if (!agent?.agent_session || agent.agent_session.kind !== native.kind || agent.agent_session.value !== native.value || agent.agent_session.source !== native.source) throw new Error("Child native session no longer matches write-ahead ownership proof"); }
  return pane;
}

export async function cleanupPartialStart(input: {
  readonly client: HerdrRequestClient; readonly groupManager: DelegationGroupManager; readonly group?: DelegationGroup;
  readonly journal: OwnershipJournalData; readonly groupCreatedThisAttempt: boolean; readonly signal?: AbortSignal;
}): Promise<PartialCleanupReport> {
  const closedPaneIds: string[] = []; const closedTabIds: string[] = []; const retained: string[] = [];
  const resources = input.journal.resources;
  if (resources.terminalId) {
    try {
      const pane = await resolveProvenPane(input.client, resources.terminalId, resources.nativeSession, input.signal);
      if (pane) { await input.client.closePane(pane.pane_id, input.signal); closedPaneIds.push(pane.pane_id); }
    } catch (error) { retained.push(`child terminal ${resources.terminalId}: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (resources.paneId) retained.push(`pane ${resources.paneId}: terminal identity was never recorded`);

  if (input.groupCreatedThisAttempt && input.group && resources.tabId === input.group.tabId && resources.rootTerminalId === input.group.rootTerminalId) {
    try {
      const anchor = await input.groupManager.verifyAnchor(input.group, input.signal);
      if (!anchor.verified) retained.push(`tab ${input.group.tabId}: ${anchor.reason}`);
      else {
        const panes = (await input.client.listPanes(input.group.workspaceId, input.signal)).filter((pane) => pane.tab_id === input.group!.tabId);
        if (panes.length !== 1 || panes[0]?.terminal_id !== input.group.rootTerminalId) retained.push(`tab ${input.group.tabId}: unknown or non-anchor panes remain`);
        else {
          await input.client.closeTab(input.group.tabId, input.signal);
          input.groupManager.forgetClosed(input.group);
          closedTabIds.push(input.group.tabId);
        }
      }
    } catch (error) { retained.push(`tab ${input.group.tabId}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const partial = input.groupManager.partial(input.journal.intended.workspaceId, input.journal.intended.group);
  if (partial) {
    const matchesJournal = resources.tabId === partial.tab.tab_id && resources.rootPaneId === partial.rootPane.pane_id && resources.rootTerminalId === partial.rootPane.terminal_id;
    retained.push(matchesJournal
      ? `tab ${partial.tab.tab_id}: retained partial delegation group; anchor process baseline is unavailable, so reconstruction and tab closure are not proven safe`
      : `tab ${partial.tab.tab_id}: retained partial delegation group does not exactly match the write-ahead journal`);
  } else if (input.groupCreatedThisAttempt && !input.group && resources.tabId) {
    retained.push(`tab ${resources.tabId}: write-ahead identity exists but no complete or reconstruct-safe group baseline is available`);
  }
  return { closedPaneIds, closedTabIds, retained: [...new Set(retained)] };
}
