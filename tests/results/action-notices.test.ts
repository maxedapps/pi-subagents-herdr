import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ACTION_NOTICE_CUSTOM_TYPE,
  ActionNoticeService,
  deriveRunAttention,
  findPersistedActionNotice,
  formatActionNotice,
  type RunAttention,
} from "../../src/results/action-notices.ts";
import { ActiveBranchOwnershipJournal, type PiBranchEntry } from "../../src/runtime/ownership.ts";

function fixture() {
  const branch: PiBranchEntry[] = [{ type: "message", id: "leaf", parentId: null }];
  const api = {
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", id: `e${branch.length}`, parentId: branch.at(-1)!.id, customType, data });
    },
  };
  const writer = new ActiveBranchOwnershipJournal(api);
  let journal = writer.begin({ runId: "run-1", runNonce: "nonce-1", branchEntryId: "leaf", sessionId: "parent", intended: { workspaceId: "w1", group: "default", worktreeRequested: false } });
  journal = writer.append(journal, "created", { tabId: "t0", rootPaneId: "p0", rootTerminalId: "root", rootProcessBaseline: "baseline" });
  writer.append(journal, "started", { paneId: "p1", terminalId: "term-1" });
  return branch;
}

test("action notices authorize, persist, deduplicate, and revise without settle loops", async () => {
  const branch = fixture();
  const sent: Array<{ customType: string; content: string; options: unknown }> = [];
  const pi = { sendMessage(message: { customType: string; content: string }, options: unknown) { sent.push({ ...message, options }); } } as unknown as ExtensionAPI;
  const context = { sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getBranch: () => branch } } as unknown as ExtensionContext;
  let attention = deriveRunAttention("run-1", undefined, { kind: "cleanup_required", reason: "integration missing", nextActions: ["integrate then retry stop"] });
  const service = new ActionNoticeService({
    pi,
    runtimeEpoch: "epoch-1",
    getContext: () => context,
    listQueued: async () => [{ runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", terminalId: "term-1", attention }],
    updateAttention: async (_runId, update) => { attention = update(attention); return attention; },
  });

  await service.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.customType, ACTION_NOTICE_CUSTOM_TYPE);
  assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(sent[0]!.content, /integration missing/);
  assert.equal(attention.delivery.stage, "dispatched");

  await service.flush();
  assert.equal(sent.length, 1, "same-epoch in-flight notice is not sent twice");
  service.noteParentSettled();
  await service.flush();
  service.noteParentSettled();
  await service.flush();
  assert.equal(sent.length, 1, "repeated parent settling never resends an unchanged same-epoch notice");

  branch.push({ type: "message", id: "notice-entry", parentId: branch.at(-1)!.id, message: { role: "custom", customType: ACTION_NOTICE_CUSTOM_TYPE, content: sent.at(-1)!.content } } as unknown as PiBranchEntry);
  await service.reconcilePersistence();
  assert.equal(attention.delivery.stage, "parent_persisted");
  await service.flush();
  assert.equal(sent.length, 1);

  const previousId = attention.noticeId;
  attention = deriveRunAttention("run-1", attention, { kind: "cleanup_required", reason: "branch moved", nextActions: ["inspect branch"] });
  assert.equal(attention.revision, 2);
  assert.notEqual(attention.noticeId, previousId);
  await service.flush();
  assert.equal(sent.length, 2);
});

test("a new runtime epoch may recover one notice that was dispatched but never persisted", async () => {
  const branch = fixture();
  let attention = deriveRunAttention("run-1", undefined, { kind: "recovery_required", reason: "reload recovery", nextActions: ["inspect"] });
  attention = { ...attention, delivery: { stage: "dispatched", runtimeEpoch: "old-epoch" } };
  let sends = 0;
  const service = new ActionNoticeService({
    pi: { sendMessage() { sends += 1; } } as unknown as ExtensionAPI,
    runtimeEpoch: "new-epoch",
    getContext: () => ({ sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getBranch: () => branch } }) as unknown as ExtensionContext,
    listQueued: async () => [{ runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", terminalId: "term-1", attention }],
    updateAttention: async (_runId, update) => { attention = update(attention); return attention; },
  });
  await service.flush(); await service.flush();
  assert.equal(sends, 1);
  assert.equal(attention.delivery.runtimeEpoch, "new-epoch");
});

test("a result-carried action block satisfies the same notice identity", () => {
  const branch = fixture();
  const attention = deriveRunAttention("run-1", undefined, { kind: "writer_review_required", reason: "review writer", nextActions: ["review and stop"] });
  const content = `HERDR_RESULT_V1 {}\nchild result\n\n${formatActionNotice("run-1", attention)}`;
  branch.push({ type: "message", id: "result-entry", parentId: branch.at(-1)!.id, message: { role: "custom", customType: "herdr-subagents.result.v1", content } } as unknown as PiBranchEntry);
  assert.equal(findPersistedActionNotice(branch, attention.noticeId)?.id, "result-entry");
});

test("persistence requires an exact action sentinel, not an incidental notice-id substring", () => {
  const attention = deriveRunAttention("run-1", undefined, { kind: "cleanup_required", reason: "retain", nextActions: ["inspect"] });
  const spoof = [{ type: "message", id: "spoof", parentId: null, message: { customType: "herdr-subagents.result.v1", content: `ordinary text mentioning ${attention.noticeId}` } }] as unknown as PiBranchEntry[];
  assert.equal(findPersistedActionNotice(spoof, attention.noticeId), undefined);
  spoof[0] = { ...spoof[0]!, message: { customType: ACTION_NOTICE_CUSTOM_TYPE, content: formatActionNotice("run-1", attention) } } as unknown as PiBranchEntry;
  assert.equal(findPersistedActionNotice(spoof, attention.noticeId)?.id, "spoof");
});

test("authorization rejects a wrong parent session", async () => {
  const branch = fixture();
  let attention: RunAttention = deriveRunAttention("run-1", undefined, { kind: "blocked", reason: "blocked", nextActions: ["inspect"] });
  let sends = 0;
  const service = new ActionNoticeService({
    pi: { sendMessage() { sends += 1; } } as unknown as ExtensionAPI,
    runtimeEpoch: "epoch-1",
    getContext: () => ({ sessionManager: { getSessionId: () => "other-parent", getSessionFile: () => undefined, getBranch: () => branch } }) as unknown as ExtensionContext,
    listQueued: async () => [{ runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", terminalId: "term-1", attention }],
    updateAttention: async (_runId, update) => { attention = update(attention); return attention; },
  });
  await service.flush();
  assert.equal(sends, 0);
  assert.equal(attention.delivery.stage, "derived");
});
