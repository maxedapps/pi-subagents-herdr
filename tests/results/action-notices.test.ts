import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  deriveRunAttention,
  findLegacyPersistedFailedAction,
  LEGACY_ACTION_NOTICE_CUSTOM_TYPE,
  LEGACY_ACTION_NOTICE_SENTINEL,
  parseRunAttention,
} from "../../src/results/action-notices.ts";
import {
  FAILURE_EVIDENCE_CUSTOM_TYPE,
  appendFailureEvidence,
  findPersistedFailureEvidence,
  parseFailureEvidence,
} from "../../src/results/failure-evidence.ts";
import { ActiveBranchOwnershipJournal } from "../../src/runtime/ownership.ts";

function fixture(sessionId = "parent", runNonce = "nonce-1") {
  const session = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const anchorId = session.appendCustomMessageEntry("fixture.anchor", "anchor", false);
  const api = {
    appendEntry(customType: string, data: unknown) { session.appendCustomEntry(customType, data); },
    sendMessage() { throw new Error("failure/passive attention must not send a message"); },
  } as unknown as ExtensionAPI;
  const writer = new ActiveBranchOwnershipJournal(api);
  let journal = writer.begin({ runId: "run-1", runNonce, branchEntryId: anchorId, sessionId, intended: { workspaceId: "w1", group: "default", worktreeRequested: false } });
  journal = writer.append(journal, "failed", {});
  const context = { sessionManager: session } as unknown as ExtensionContext;
  return { session, api, context, journal, anchorId };
}

test("authorized current-branch failures append one exact non-model-visible entry", () => {
  const value = fixture();
  const first = appendFailureEvidence({ pi: value.api, context: value.context, journal: value.journal, reason: "placement failed", now: () => 10 });
  const second = appendFailureEvidence({ pi: value.api, context: value.context, journal: value.journal, reason: "placement failed", now: () => 20 });
  assert.equal(first?.failureId, second?.failureId);
  const entries = value.session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === FAILURE_EVIDENCE_CUSTOM_TYPE);
  assert.equal(entries.length, 1, "stable failure identity is deduplicated");
  assert.equal(entries[0]!.type, "custom");
  assert.equal(findPersistedFailureEvidence(value.session.getBranch(), {
    runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", branchEntryId: value.anchorId,
  })?.id, entries[0]!.id);
});

test("failure evidence rejects wrong session, nonce, branch, malformed data, and passive attention", () => {
  const value = fixture();
  appendFailureEvidence({ pi: value.api, context: value.context, journal: value.journal, reason: "failed" });
  const expected = { runId: "run-1", runNonce: "nonce-1", parentSessionId: "parent", branchEntryId: value.anchorId };
  assert.equal(findPersistedFailureEvidence(value.session.getBranch(), { ...expected, runNonce: "wrong" }), undefined);
  assert.equal(findPersistedFailureEvidence(value.session.getBranch(), { ...expected, parentSessionId: "wrong" }), undefined);
  assert.equal(findPersistedFailureEvidence(value.session.getBranch(), { ...expected, branchEntryId: "wrong" }), undefined);
  const wrongContext = { sessionManager: SessionManager.inMemory(process.cwd(), { id: "other" }) } as unknown as ExtensionContext;
  assert.equal(appendFailureEvidence({ pi: value.api, context: wrongContext, journal: value.journal, reason: "failed" }), undefined);
  assert.throws(() => parseFailureEvidence({ schemaVersion: 1, failureId: "spoof" }), /malformed/);
  const attention = deriveRunAttention("run-1", undefined, { kind: "failed", reason: "failed", nextActions: ["inspect"] });
  assert.equal(attention.delivery.stage, "derived");
});

test("schema-v5 attention remains inert, round-trips legacy stages, and malformed mixed shapes fail closed", () => {
  const derived = deriveRunAttention("run-1", undefined, { kind: "blocked", reason: "blocked", nextActions: ["inspect status"] });
  assert.equal(parseRunAttention(JSON.parse(JSON.stringify(derived))).delivery.stage, "derived");
  const legacy = { ...derived, delivery: { stage: "parent_persisted" as const } };
  assert.equal(parseRunAttention(legacy).delivery.stage, "parent_persisted");
  for (const malformed of [
    { ...derived, delivery: { stage: "captured" } },
    { ...derived, delivery: { stage: "derived", unknown: true } },
    { ...derived, nextActions: [""] },
  ]) assert.throws(() => parseRunAttention(malformed), /malformed|unknown/);
});

test("legacy parent-persisted failed action evidence is recognized exactly and read-only", () => {
  const session = SessionManager.inMemory();
  const content = `${LEGACY_ACTION_NOTICE_SENTINEL} ${JSON.stringify({ noticeId: "act-1", runId: "run-1", kind: "failed", revision: 1 })}\nlegacy failure`;
  const entryId = session.appendCustomMessageEntry(LEGACY_ACTION_NOTICE_CUSTOM_TYPE, content, true);
  assert.equal(findLegacyPersistedFailedAction(session.getBranch(), "run-1", "act-1")?.id, entryId);
  assert.equal(findLegacyPersistedFailedAction(session.getBranch(), "run-2", "act-1"), undefined);
  assert.equal(findLegacyPersistedFailedAction(session.getBranch(), "run-1", "act"), undefined);
});
