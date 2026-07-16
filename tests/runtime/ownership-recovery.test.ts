import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRecord } from "../../src/contracts/state.ts";
import { decodeEvent } from "../../src/herdr/protocol.ts";
import { ActiveBranchOwnershipJournal, OWNERSHIP_ENTRY_TYPE, reconcileOwnership, recoverActiveBranchOwnership, type PiBranchEntry } from "../../src/runtime/ownership.ts";
import { RuntimeRecovery } from "../../src/runtime/recovery.ts";
import { RegistryIdentityError, SubagentRegistry } from "../../src/runtime/registry.ts";
import { agent, pane, snapshot } from "../herdr/fixtures.ts";

const currentParent = { sessionId: "session-1", sessionPath: "/tmp/parent.jsonl" } as const;
function branchEntries(): PiBranchEntry[] { return [{ type: "message", id: "parent-leaf", parentId: null }]; }
function appender(entries: PiBranchEntry[]) { return { appendEntry(customType: string, data: unknown) { const id = `e${entries.length}`; entries.push({ type: "custom", id, parentId: entries.at(-1)?.id ?? null, customType, data }); } }; }
function activeJournal(entries: PiBranchEntry[]) {
  const journal = new ActiveBranchOwnershipJournal(appender(entries));
  let state = journal.begin({ runId: "run-1", runNonce: "nonce-1", branchEntryId: "parent-leaf", sessionId: currentParent.sessionId, sessionPath: currentParent.sessionPath, intended: { workspaceId: "w1", group: "phase3", worktreeRequested: false } });
  state = journal.append(state, "created", { tabId: "w1:t2", rootPaneId: "w1:anchor", rootTerminalId: "term_anchor" });
  state = journal.append(state, "started", { paneId: "w1:p2", terminalId: "term_child", nativeSession: { source: "herdr:pi", kind: "path", value: "/tmp/child.jsonl" } });
  return state;
}
const childPane = { ...pane, pane_id: "w1:p2", terminal_id: "term_child", focused: false };
const childAgent = { ...agent, pane_id: "w1:p2", terminal_id: "term_child", focused: false, agent_session: { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/tmp/child.jsonl" } };
const childSnapshot = { ...snapshot, panes: [...snapshot.panes, childPane], agents: [...snapshot.agents, childAgent] };

function record(terminalId = "term_child"): SubagentRecord {
  return { schemaVersion: 1, id: "run-1", ownership: { runNonce: "nonce-1", parentSession: { id: "session-1", branchEntryId: "leaf" }, createdFrom: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_parent" }, child: { terminalId } }, profileName: "worker", harness: "pi", lifecycle: "running", herdrStatus: "working", terminalId, paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", createdAt: 1, updatedAt: 1 };
}

test("write-ahead journal proves its parent branch entry and enforces a monotonic FSM", () => {
  const entries = branchEntries(); const state = activeJournal(entries); assert.equal(entries[1]?.customType, OWNERSHIP_ENTRY_TYPE); assert.equal(state.sequence, 2);
  const recovered = recoverActiveBranchOwnership(entries); assert.equal(recovered.get("run-1")?.state, "owned");
  const onlyIntent = recoverActiveBranchOwnership(entries.slice(0, 2)); assert.equal(reconcileOwnership({ runId: "run-1", active: onlyIntent, snapshot: childSnapshot, currentParent }).state, "uncertain");

  const separate = branchEntries(); const journal = new ActiveBranchOwnershipJournal(appender(separate)); const intent = journal.begin({ runId: "run-2", runNonce: "nonce-2", branchEntryId: "parent-leaf", sessionId: currentParent.sessionId, intended: { workspaceId: "w1", group: "g", worktreeRequested: false } });
  assert.throws(() => journal.append(intent, "started", { paneId: "p", terminalId: "t" }), /transition/);
  const failed = journal.append(intent, "failed", {}); assert.throws(() => journal.append(failed, "created", { tabId: "t", rootPaneId: "p", rootTerminalId: "term" }), /transition/);

  const missingParent = entries.slice(1); assert.equal(recoverActiveBranchOwnership(missingParent).get("run-1")?.state, "uncertain");
  const reversed = [...entries]; reversed[1] = { ...reversed[1]!, parentId: "future" }; assert.equal(recoverActiveBranchOwnership(reversed).get("run-1")?.state, "uncertain");
  const forged = [...entries, { type: "custom", id: "forged", parentId: entries.at(-1)!.id, customType: OWNERSHIP_ENTRY_TYPE, data: { ...(entries.at(-1)!.data as object), sequence: 3, phase: "created" } }];
  assert.equal(recoverActiveBranchOwnership(forged).get("run-1")?.state, "uncertain");
});

test("worktree ownership journal persists canonical repository, initial root, group tab, and child identities monotonically", () => {
  const entries = branchEntries(); const journal = new ActiveBranchOwnershipJournal(appender(entries));
  let state = journal.begin({ runId: "run-wt", runNonce: "nonce-wt", branchEntryId: "parent-leaf", sessionId: currentParent.sessionId, intended: { workspaceId: "w1", group: "writer", worktreeRequested: true } });
  state = journal.append(state, "worktree_created", { repositoryId: "repo-id", commonGitDir: "/repo/.git", herdrRepositoryKey: "repo-key", worktreeSourceWorkspaceId: "w1", worktreeWorkspaceId: "w2", checkoutPath: "/repo-wt", worktreeBranch: "writer", worktreeBase: "abc", worktreeInitialTabId: "w2:t1", worktreeInitialRootPaneId: "w2:p1", worktreeInitialRootTerminalId: "term-root" });
  state = journal.append(state, "created", { tabId: "w2:t2", rootPaneId: "w2:p2", rootTerminalId: "term-group", rootProcessBaseline: "baseline" });
  state = journal.append(state, "started", { paneId: "w2:p3", terminalId: "term-writer", nativeSession: { kind: "id", value: "native-writer", source: "herdr:pi" } });
  assert.equal(state.resources.worktreeInitialRootTerminalId, "term-root"); assert.equal(state.resources.rootTerminalId, "term-group"); assert.equal(state.resources.terminalId, "term-writer");
  assert.equal(recoverActiveBranchOwnership(entries).get("run-wt")?.state, "owned");
});

test("tampered metadata, current parent identity, and journal identities never grant ownership", () => {
  const entries = branchEntries(); activeJournal(entries); const active = recoverActiveBranchOwnership(entries);
  assert.equal(reconcileOwnership({ runId: "run-1", active, snapshot: childSnapshot, currentParent }).state, "uncertain");
  assert.equal(reconcileOwnership({ runId: "run-1", active, snapshot: childSnapshot, currentParent, metadata: { runId: "run-1", runNonce: "tampered", terminalId: "term_child" } }).state, "uncertain");
  assert.equal(reconcileOwnership({ runId: "run-1", active, snapshot: childSnapshot, currentParent: { sessionId: "different", sessionPath: currentParent.sessionPath } }).state, "orphaned");
  const tampered = [...entries, { type: "custom", id: "evil", parentId: entries.at(-1)!.id, customType: OWNERSHIP_ENTRY_TYPE, data: { ...(entries.at(-1)!.data as object), sequence: 3, runNonce: "other", phase: "failed" } }];
  assert.equal(recoverActiveBranchOwnership(tampered).get("run-1")?.state, "uncertain");
});

test("tree navigation and fork/new sessions keep inherited journals observational", () => {
  const entries = branchEntries(); activeJournal(entries); const recovery = new RuntimeRecovery();
  const metadata = [{ runId: "run-1", runNonce: "nonce-1", terminalId: "term_child", nativeSession: { source: "herdr:pi", kind: "path" as const, value: "/tmp/child.jsonl" } }];
  assert.equal(recovery.sessionStart("reload", entries, childSnapshot, currentParent, metadata)[0]?.disposition, "owned");
  recovery.sessionBeforeTree(); const after = recovery.sessionTree(entries.slice(0, 1), childSnapshot, currentParent, metadata); assert.deepEqual(after, [{ runId: "run-1", disposition: "orphaned", reason: "Run belongs to the abandoned Pi /tree branch" }]);
  assert.equal(recovery.sessionStart("fork", entries, childSnapshot, currentParent, metadata)[0]?.disposition, "orphaned");
  assert.equal(recovery.sessionStart("new", entries, childSnapshot, currentParent, metadata)[0]?.disposition, "orphaned");
  assert.equal(recovery.sessionStart("resume", entries, childSnapshot, { sessionId: "another-session", sessionPath: "/tmp/other.jsonl" }, metadata)[0]?.disposition, "orphaned");
});

test("shutdown stops extension services idempotently but never invokes child termination", async () => {
  const recovery = new RuntimeRecovery(); let stopped = 0; recovery.registerService({ stop() { stopped += 1; } }); await recovery.sessionShutdown(); await recovery.sessionShutdown(); assert.equal(stopped, 1);
});

test("terminal-keyed registry follows moved panes and stale pane ids cannot transfer identity", () => {
  const registry = new SubagentRegistry(); registry.register(record());
  registry.applyEvent(decodeEvent({ event: "pane_moved", data: { type: "pane_moved", previous_pane_id: "w1:p2", previous_workspace_id: "w1", previous_tab_id: "w1:t1", pane: { ...childPane, pane_id: "w2:p8", workspace_id: "w2", tab_id: "w2:t1" } } }), 2);
  assert.deepEqual({ pane: registry.get("run-1")?.paneId, terminal: registry.get("run-1")?.terminalId }, { pane: "w2:p8", terminal: "term_child" });
  registry.applyEvent(decodeEvent({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p2", workspace_id: "w1" } }), 3); assert.equal(registry.get("run-1")?.lifecycle, "running");
});

test("registry run and terminal bindings are one-time and never leave stale reverse mappings", () => {
  const registry = new SubagentRegistry(); registry.register(record("term_A"));
  assert.throws(() => registry.register({ ...record("term_B"), ownership: { ...record("term_B").ownership, child: { terminalId: "term_B" } }, terminalId: "term_B" }), RegistryIdentityError);
  assert.equal(registry.getByTerminal("term_A")?.id, "run-1"); assert.equal(registry.getByTerminal("term_B"), undefined);

  const unbound = record("term_placeholder"); const { terminalId: _terminalId, ...withoutTerminal } = unbound; const initial: SubagentRecord = { ...withoutTerminal, id: "run-2", ownership: { ...unbound.ownership, runNonce: "nonce-2", child: {} } };
  registry.register(initial); const bound = registry.bindTerminal("run-2", { terminalId: "term_B", nativeSession: { source: "herdr:pi", kind: "id", value: "child" } }, 2);
  assert.equal(bound.ownership.child.terminalId, "term_B"); assert.equal(registry.getByTerminal("term_B")?.id, "run-2");
  assert.throws(() => registry.bindTerminal("run-2", { terminalId: "term_C" }), RegistryIdentityError);
  assert.equal(registry.getByTerminal("term_C"), undefined);
  assert.throws(() => registry.update({ ...bound, ownership: { ...bound.ownership, parentSession: { id: "changed", branchEntryId: "leaf" } } }), RegistryIdentityError);
});
