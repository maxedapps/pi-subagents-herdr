import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import type { AgentInfo, PaneInfo } from "../../src/herdr/protocol.ts";
import { DelegationGroupManager } from "../../src/runtime/groups.ts";
import { ActiveBranchOwnershipJournal, type OwnershipJournalData, type PiBranchEntry } from "../../src/runtime/ownership.ts";
import { PartialStartRecorder, cleanupPartialStart } from "../../src/runtime/reconcile.ts";
import { agent, pane, tab, workspace } from "../herdr/fixtures.ts";

function fakeClient() {
  let creates = 0; let snapshots = 0; let visibleAfterSnapshots = 0; let groupLive = false;
  let panes: PaneInfo[] = [{ ...pane, pane_id: "w1:anchor", terminal_id: "term_anchor", tab_id: "w1:group", focused: false }]; let agents: AgentInfo[] = [];
  const closedPanes: string[] = []; const closedTabs: string[] = [];
  const groupTab = { ...tab, tab_id: "w1:group", workspace_id: "w1", focused: false };
  const client = {
    async createTab(input: any) { creates += 1; groupLive = true; assert.equal(input.focus, false); await new Promise((resolve) => setTimeout(resolve, 10)); return { tab: groupTab, rootPane: panes[0]! }; },
    async snapshot() {
      snapshots += 1;
      const visible = groupLive && snapshots > visibleAfterSnapshots;
      return { version: "0.7.3", protocol: 16, workspaces: [{ ...workspace, workspace_id: "w1" }], tabs: visible ? [groupTab] : [], panes: visible ? panes : [], layouts: [], agents };
    },
    async getPaneProcessInfo(paneId: string) { return { pane_id: paneId, shell_pid: 10, tty: "/dev/tty", foreground_process_group_id: 10, foreground_processes: [] }; },
    async listPanes() { return groupLive ? panes : []; }, async listAgents() { return agents; },
    async closePane(paneId: string) { closedPanes.push(paneId); panes = panes.filter((item) => item.pane_id !== paneId); },
    async closeTab(tabId: string) { closedTabs.push(tabId); groupLive = false; },
  } as unknown as HerdrRequestClient;
  return {
    client,
    get creates() { return creates; }, get snapshots() { return snapshots; },
    get visibleAfterSnapshots() { return visibleAfterSnapshots; }, set visibleAfterSnapshots(value: number) { visibleAfterSnapshots = value; },
    get groupLive() { return groupLive; }, set groupLive(value: boolean) { groupLive = value; },
    get panes() { return panes; }, set panes(value: PaneInfo[]) { panes = value; }, set agents(value: AgentInfo[]) { agents = value; }, closedPanes, closedTabs,
  };
}
function intent(entries: PiBranchEntry[]) {
  entries.push({ type: "message", id: "leaf", parentId: null });
  const journal = new ActiveBranchOwnershipJournal({ appendEntry(customType, data) { entries.push({ type: "custom", id: `${entries.length}`, parentId: entries.at(-1)?.id ?? null, customType, data }); } });
  return { journal, state: journal.begin({ runId: "run-1", runNonce: "nonce-1", branchEntryId: "leaf", sessionId: "session-1", intended: { workspaceId: "w1", group: "g", worktreeRequested: false } }) };
}

test("dedicated no-focus group creation serializes concurrent mutations and records an anchor baseline", async () => {
  const fake = fakeClient(); const manager = new DelegationGroupManager(fake.client);
  const [left, right] = await Promise.all([manager.ensure("w1", "g"), manager.ensure("w1", "g")]);
  assert.equal(fake.creates, 1); assert.equal(left, right); assert.equal(left.rootTerminalId, "term_anchor"); assert.match(left.rootProcessBaseline, /^[a-f0-9]{64}$/);
});

test("group creation waits for exact delayed placement visibility", async () => {
  const fake = fakeClient(); fake.visibleAfterSnapshots = 2; const manager = new DelegationGroupManager(fake.client);
  const group = await manager.ensure("w1", "g");
  assert.equal(group.tabId, "w1:group"); assert.equal(fake.snapshots, 3); assert.equal(fake.creates, 1);
});

test("never-visible created placement is bounded and retained as a partial", async () => {
  const fake = fakeClient(); fake.visibleAfterSnapshots = Number.MAX_SAFE_INTEGER; const manager = new DelegationGroupManager(fake.client);
  await assert.rejects(manager.ensure("w1", "g"), /not ready: exact workspace\/tab\/root-pane\/root-terminal identity is not yet visible/);
  assert.equal(fake.creates, 1); assert.equal(manager.partial("w1", "g")?.tab.tab_id, "w1:group");
});

test("cached group reuse performs a fresh exact topology and process check", async () => {
  const fake = fakeClient(); const manager = new DelegationGroupManager(fake.client);
  const group = await manager.ensure("w1", "g"); const afterCreate = fake.snapshots;
  assert.equal(await manager.ensure("w1", "g"), group); assert.ok(fake.snapshots > afterCreate);
  fake.panes = [{ ...fake.panes[0]!, tab_id: "w1:other" }];
  await assert.rejects(manager.ensure("w1", "g"), /moved|no longer matches/);
  assert.equal(fake.creates, 1, "stale cached provenance must not be silently replaced");
});

test("group creation exposes returned identities before later baseline failure", async () => {
  const fake = fakeClient(); const manager = new DelegationGroupManager(fake.client); const entries: PiBranchEntry[] = []; const started = intent(entries); const recorder = new PartialStartRecorder(started.journal, started.state);
  (fake.client.getPaneProcessInfo as any) = async () => { throw new Error("process probe failed"); };
  await assert.rejects(manager.ensure("w1", "g", undefined, (created) => recorder.recordCreatedGroupIdentity(created)), /process probe failed/);
  assert.equal(recorder.current.resources.tabId, "w1:group"); assert.equal(recorder.current.resources.rootTerminalId, "term_anchor"); assert.equal(recorder.current.resources.rootProcessBaseline, undefined);
  recorder.fail();
  const report = await cleanupPartialStart({ client: fake.client, groupManager: manager, journal: recorder.current, groupCreatedThisAttempt: true });
  assert.deepEqual(fake.closedTabs, []); assert.ok(report.retained.some((reason) => reason.includes("baseline is unavailable")));
  await assert.rejects(manager.ensure("w1", "g"), /retained partial tab/); assert.equal(fake.creates, 1);
});

test("partial start records every returned identity before identity-verified moved-pane cleanup", async () => {
  const fake = fakeClient(); const manager = new DelegationGroupManager(fake.client); const group = await manager.ensure("w1", "g"); const entries: PiBranchEntry[] = []; const started = intent(entries); const recorder = new PartialStartRecorder(started.journal, started.state);
  recorder.recordGroup(group);
  const child = { ...agent, terminal_id: "term_child", pane_id: "w1:old", focused: false, agent_session: { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "child-session" } };
  recorder.recordAgent(child); recorder.fail();
  fake.panes = [fake.panes[0]!, { ...pane, pane_id: "w1:moved", terminal_id: "term_child", tab_id: "w1:group", focused: false }]; fake.agents = [child];
  const report = await cleanupPartialStart({ client: fake.client, groupManager: manager, group, journal: recorder.current, groupCreatedThisAttempt: true });
  assert.deepEqual(fake.closedPanes, ["w1:moved"]); assert.deepEqual(fake.closedTabs, ["w1:group"]); assert.deepEqual(report.retained, []); assert.ok(entries.length >= 4);
  assert.equal(manager.get("w1", "g"), undefined);
  await manager.ensure("w1", "g");
  assert.equal(fake.creates, 2, "retry must create a new tab instead of returning the closed group");
});

test("partial cleanup retains uncertain/stale resources and never closes a replacement pane", async () => {
  const fake = fakeClient(); const manager = new DelegationGroupManager(fake.client); const group = await manager.ensure("w1", "g"); const entries: PiBranchEntry[] = []; const started = intent(entries);
  const created = started.journal.append(started.state, "created", { tabId: group.tabId, rootPaneId: group.rootPaneId, rootTerminalId: group.rootTerminalId, rootProcessBaseline: group.rootProcessBaseline });
  const uncertain: OwnershipJournalData = started.journal.append(created, "failed", { paneId: "w1:stale" });
  fake.panes = [fake.panes[0]!, { ...pane, pane_id: "w1:stale", terminal_id: "term_replacement", tab_id: "w1:group", focused: false }];
  const report = await cleanupPartialStart({ client: fake.client, groupManager: manager, group, journal: uncertain, groupCreatedThisAttempt: true });
  assert.deepEqual(fake.closedPanes, []); assert.deepEqual(fake.closedTabs, []); assert.ok(report.retained.some((reason) => reason.includes("terminal identity was never recorded"))); assert.ok(report.retained.some((reason) => reason.includes("unknown")));
});

test("an active foreground process prevents dedicated tab cleanup", async () => {
  const fake = fakeClient(); const manager = new DelegationGroupManager(fake.client); const group = await manager.ensure("w1", "g"); const entries: PiBranchEntry[] = []; const started = intent(entries); const created = started.journal.append(started.state, "created", { tabId: group.tabId, rootPaneId: group.rootPaneId, rootTerminalId: group.rootTerminalId, rootProcessBaseline: group.rootProcessBaseline }); const state = started.journal.append(created, "failed", {});
  (fake.client.getPaneProcessInfo as any) = async (paneId: string) => ({ pane_id: paneId, shell_pid: 999, foreground_processes: [{ pid: 1001, name: "active-command" }] });
  const report = await cleanupPartialStart({ client: fake.client, groupManager: manager, group, journal: state, groupCreatedThisAttempt: true }); assert.deepEqual(fake.closedTabs, []); assert.ok(report.retained.some((reason) => reason.includes("idle shell")));
});
