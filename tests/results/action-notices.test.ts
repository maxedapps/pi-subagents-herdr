import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ACTION_NOTICE_CUSTOM_TYPE,
  ACTION_NOTICE_SENTINEL,
  ActionNoticeService,
  deriveRunAttention,
  findPersistedActionNotice,
  formatActionNotice,
  type RunAttention,
} from "../../src/results/action-notices.ts";
import { ActiveBranchOwnershipJournal } from "../../src/runtime/ownership.ts";

function fixture(): SessionManager {
  const session = SessionManager.inMemory(process.cwd(), { id: "parent" });
  const anchorId = session.appendCustomMessageEntry("fixture.anchor", "anchor", false);
  const writer = new ActiveBranchOwnershipJournal({
    appendEntry(customType: string, data: unknown) {
      session.appendCustomEntry(customType, data);
    },
  });
  let journal = writer.begin({ runId: "run-1", runNonce: "nonce-1", branchEntryId: anchorId, sessionId: "parent", intended: { workspaceId: "w1", group: "default", worktreeRequested: false } });
  journal = writer.append(journal, "created", { tabId: "t0", rootPaneId: "p0", rootTerminalId: "root", rootProcessBaseline: "baseline" });
  writer.append(journal, "started", { paneId: "p1", terminalId: "term-1" });
  return session;
}

test("action notices authorize, persist, deduplicate, and revise without settle loops", async () => {
  const session = fixture();
  const sent: Array<{ customType: string; content: string; options: unknown }> = [];
  const pi = { sendMessage(message: { customType: string; content: string }, options: unknown) { sent.push({ ...message, options }); } } as unknown as ExtensionAPI;
  const context = { sessionManager: session } as unknown as ExtensionContext;
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

  const entryId = session.appendCustomMessageEntry(ACTION_NOTICE_CUSTOM_TYPE, sent.at(-1)!.content, true);
  await service.reconcilePersistence();
  assert.equal(attention.delivery.stage, "parent_persisted");
  assert.equal(findPersistedActionNotice(session.getBranch(), attention.noticeId)?.id, entryId);
  await service.flush();
  assert.equal(sent.length, 1);

  const previousId = attention.noticeId;
  attention = deriveRunAttention("run-1", attention, { kind: "cleanup_required", reason: "branch moved", nextActions: ["inspect branch"] });
  assert.equal(attention.revision, 2);
  assert.notEqual(attention.noticeId, previousId);
  await service.flush();
  assert.equal(sent.length, 2);
  service.stop();
});

test("a new runtime epoch may recover one notice that was dispatched but never persisted", async () => {
  const session = fixture();
  let attention = deriveRunAttention("run-1", undefined, { kind: "recovery_required", reason: "reload recovery", nextActions: ["inspect"] });
  attention = { ...attention, delivery: { stage: "dispatched", runtimeEpoch: "old-epoch" } };
  let sends = 0;
  const service = new ActionNoticeService({
    pi: { sendMessage() { sends += 1; } } as unknown as ExtensionAPI,
    runtimeEpoch: "new-epoch",
    getContext: () => ({ sessionManager: session }) as unknown as ExtensionContext,
    listQueued: async () => [{ runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", terminalId: "term-1", attention }],
    updateAttention: async (_runId, update) => { attention = update(attention); return attention; },
  });
  await service.flush(); await service.flush();
  assert.equal(sends, 1);
  assert.equal(attention.delivery.runtimeEpoch, "new-epoch");
  service.stop();
});

test("a real result custom message can satisfy the carried action identity", () => {
  const session = fixture();
  const attention = deriveRunAttention("run-1", undefined, { kind: "writer_review_required", reason: "review writer", nextActions: ["review and stop"] });
  const content = `HERDR_RESULT_V1 {}\nchild result\n\n${formatActionNotice("run-1", attention)}`;
  const entryId = session.appendCustomMessageEntry("herdr-subagents.result.v1", content, true);
  assert.equal(findPersistedActionNotice(session.getBranch(), attention.noticeId)?.id, entryId);
});

test("persistence requires an exact action sentinel, not an incidental notice-id substring", () => {
  const attention = deriveRunAttention("run-1", undefined, { kind: "cleanup_required", reason: "retain", nextActions: ["inspect"] });
  const spoof = SessionManager.inMemory();
  spoof.appendCustomMessageEntry("herdr-subagents.result.v1", `ordinary text mentioning ${attention.noticeId}`, true);
  assert.equal(findPersistedActionNotice(spoof.getBranch(), attention.noticeId), undefined);
  const exactId = spoof.appendCustomMessageEntry(ACTION_NOTICE_CUSTOM_TYPE, formatActionNotice("run-1", attention), true);
  assert.equal(findPersistedActionNotice(spoof.getBranch(), attention.noticeId)?.id, exactId);
});

test("consolidated sentinels satisfy exact validated noticeIds membership only", () => {
  const content = `${ACTION_NOTICE_SENTINEL} ${JSON.stringify({ noticeId: "summary", noticeIds: ["act-a", "act-b"] })}\nsummary`;
  const session = SessionManager.inMemory();
  const entryId = session.appendCustomMessageEntry(ACTION_NOTICE_CUSTOM_TYPE, content, true);
  assert.equal(findPersistedActionNotice(session.getBranch(), "act-a")?.id, entryId);
  assert.equal(findPersistedActionNotice(session.getBranch(), "act"), undefined);
  for (const noticeIds of [[], ["act-a", 1], ["act-a", ""], ["act-a", "act-a"], "act-a"] as unknown[]) {
    const malformed = SessionManager.inMemory();
    malformed.appendCustomMessageEntry(ACTION_NOTICE_CUSTOM_TYPE, `${ACTION_NOTICE_SENTINEL} ${JSON.stringify({ noticeId: "summary", noticeIds })}`, true);
    assert.equal(findPersistedActionNotice(malformed.getBranch(), "act-a"), undefined);
  }
  const wrongType = SessionManager.inMemory();
  wrongType.appendCustomMessageEntry("other", content, true);
  assert.equal(findPersistedActionNotice(wrongType.getBranch(), "act-a"), undefined);
});

test("one consolidated branch message reconciles multiple dispatched notices", async () => {
  const session = fixture();
  let first = deriveRunAttention("run-1", undefined, { kind: "recovery_required", reason: "first", nextActions: ["inspect"] });
  let second = deriveRunAttention("run-2", undefined, { kind: "cleanup_required", reason: "second", nextActions: ["retry"] });
  first = { ...first, delivery: { stage: "dispatched", runtimeEpoch: "epoch" } }; second = { ...second, delivery: { stage: "dispatched", runtimeEpoch: "epoch" } };
  const content = `${ACTION_NOTICE_SENTINEL} ${JSON.stringify({ noticeId: "summary", noticeIds: [first.noticeId, second.noticeId] })}\nsummary`;
  session.appendCustomMessageEntry(ACTION_NOTICE_CUSTOM_TYPE, content, true);
  const items = () => [
    { runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", terminalId: "term-1", attention: first },
    { runId: "run-2", runNonce: "nonce-2", parentSessionId: "parent", terminalId: "term-2", attention: second },
  ];
  const service = new ActionNoticeService({
    pi: { sendMessage() { throw new Error("must not send per-run duplicates"); } } as unknown as ExtensionAPI, runtimeEpoch: "epoch",
    getContext: () => ({ sessionManager: session }) as unknown as ExtensionContext,
    listQueued: async () => items(),
    updateAttention: async (runId, update) => runId === "run-1" ? (first = update(first)) : (second = update(second)),
  });
  await service.reconcilePersistence(); await service.flush();
  assert.equal(first.delivery.stage, "parent_persisted"); assert.equal(second.delivery.stage, "parent_persisted");
  service.stop();
});

test("authorization rejects a wrong parent session", async () => {
  const session = fixture();
  let attention: RunAttention = deriveRunAttention("run-1", undefined, { kind: "blocked", reason: "blocked", nextActions: ["inspect"] });
  let sends = 0;
  const service = new ActionNoticeService({
    pi: { sendMessage() { sends += 1; } } as unknown as ExtensionAPI,
    runtimeEpoch: "epoch-1",
    getContext: () => ({ sessionManager: { getSessionId: () => "other-parent", getSessionFile: () => undefined, getBranch: () => session.getBranch() } }) as unknown as ExtensionContext,
    listQueued: async () => [{ runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", terminalId: "term-1", attention }],
    updateAttention: async (_runId, update) => { attention = update(attention); return attention; },
  });
  await service.flush();
  assert.equal(sends, 0);
  assert.equal(attention.delivery.stage, "derived");
  service.stop();
});
