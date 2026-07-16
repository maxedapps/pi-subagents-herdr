import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import type { SessionSnapshot } from "../../src/herdr/protocol.ts";
import { FocusOutcomeUncertainError, focusOwnedPaneFresh, revalidateRecordedOwnershipFresh, RuntimeIdentityError, type OwnedRunTarget } from "../../src/runtime/control.ts";
import { sendToSubagent } from "../../src/runtime/send.ts";

function snapshot(status: "done" | "idle" = "done", paneId = "moved:p9"): SessionSnapshot {
  const pane = { pane_id: paneId, terminal_id: "term-owned", workspace_id: "w2", tab_id: "w2:t4", focused: status === "idle", agent_status: status, revision: status === "done" ? 3 : 4, agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "child-session" } };
  return {
    version: "0.7.3", protocol: 16,
    workspaces: [{ workspace_id: "w2", number: 2, label: "moved", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w2:t4", agent_status: status }],
    tabs: [{ tab_id: "w2:t4", workspace_id: "w2", number: 4, label: "children", focused: true, pane_count: 1, agent_status: status }],
    panes: [pane], layouts: [], agents: [pane], focused_workspace_id: "w2", focused_tab_id: "w2:t4", focused_pane_id: paneId,
  };
}

function target(verify: OwnedRunTarget["authorization"]["verify"]): OwnedRunTarget {
  return {
    runId: "run-1", runNonce: "nonce-1", harness: "pi", terminalId: "term-owned", activeBranchOwned: true,
    nativeSession: { source: "herdr:pi", kind: "id", value: "child-session" }, authorization: { verify },
  };
}

test("focus validates returned post-focus identity/state without a redundant normal-path snapshot", async () => {
  const snapshots = [snapshot("done", "moved:p9")];
  const focused: string[] = [];
  const client = {
    snapshot: async () => snapshots.shift()!,
    focusAgent: async (id: string) => { focused.push(id); return snapshot("idle", "moved:p9").agents[0]!; },
  } as unknown as HerdrRequestClient;
  const result = await focusOwnedPaneFresh(client, target(() => true));
  assert.equal(result.before.pane.pane_id, "moved:p9");
  assert.equal(result.before.agent.agent_status, "done");
  assert.equal(result.after.agent_status, "idle");
  assert.equal(result.reconciled, false);
  assert.deepEqual(focused, ["term-owned"]);
  assert.equal(snapshots.length, 0);
});

test("lost focus response performs one fresh reconciliation without retrying focus", async () => {
  const snapshots = [snapshot("done", "moved:p9"), snapshot("idle", "moved:p9")];
  let focusCalls = 0;
  const client = {
    snapshot: async () => snapshots.shift()!,
    focusAgent: async () => { focusCalls += 1; throw new Error("response lost"); },
  } as unknown as HerdrRequestClient;
  const result = await focusOwnedPaneFresh(client, target(() => true));
  assert.equal(result.reconciled, true);
  assert.equal(result.after.focused, true);
  assert.equal(focusCalls, 1);
  assert.equal(snapshots.length, 0);
});

test("unreconciled focus response loss reports uncertainty without retry", async () => {
  const snapshots = [snapshot("done", "moved:p9"), snapshot("done", "moved:p9")];
  let focusCalls = 0;
  const client = {
    snapshot: async () => snapshots.shift()!,
    focusAgent: async () => { focusCalls += 1; throw new Error("response lost"); },
  } as unknown as HerdrRequestClient;
  await assert.rejects(focusOwnedPaneFresh(client, target(() => true)), FocusOutcomeUncertainError);
  assert.equal(focusCalls, 1);
  assert.equal(snapshots.length, 0);
});

test("focus rejects stale active-branch authorization before mutating Herdr", async () => {
  let focused = false;
  const client = {
    snapshot: async () => snapshot(),
    focusAgent: async () => { focused = true; },
  } as unknown as HerdrRequestClient;
  await assert.rejects(focusOwnedPaneFresh(client, target(() => false)), RuntimeIdentityError);
  assert.equal(focused, false);
});

test("send re-resolves a moved pane immediately before input", async () => {
  const snapshots = [snapshot("idle", "old:p1"), snapshot("idle", "moved:p9"), snapshot("idle", "moved:p9"), snapshot("done", "moved:p9")];
  const sent: string[] = [];
  let readRevision = 1;
  const client = {
    snapshot: async () => snapshots.shift()!,
    readAgent: async () => ({ pane_id: "moved:p9", workspace_id: "w2", tab_id: "w2:t4", source: "recent_unwrapped", format: "text", text: "output", revision: readRevision++, truncated: false }),
    sendInput: async (paneId: string) => { sent.push(paneId); },
  } as unknown as HerdrRequestClient;
  const result = await sendToSubagent({ client, target: target(() => true), message: "continue", timeoutMs: 50, pollIntervalMs: 1 });
  assert.equal(result.delivery, "confirmed");
  assert.deepEqual(sent, ["moved:p9"]);
});

test("cleanup revalidation uses a fresh post-exit snapshot and fails closed", async () => {
  const empty = { ...snapshot(), panes: [], agents: [] };
  let observed: SessionSnapshot | undefined;
  const owned = target(({ snapshot: value }) => { observed = value; return false; });
  const client = { snapshot: async () => empty } as unknown as HerdrRequestClient;
  await assert.rejects(revalidateRecordedOwnershipFresh(client, owned), /active branch\/session no longer authorizes/);
  assert.equal(observed, empty);
});
