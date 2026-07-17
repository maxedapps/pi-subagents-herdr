import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createCapturedResult,
  capturedToEnvelope,
  RESULT_CUSTOM_TYPE,
} from "../../src/results/contracts.ts";
import {
  findPersistedResultMessage,
  ResultDeliveryService,
} from "../../src/results/delivery.ts";
import { readResultEnvelope, writeResultEnvelope } from "../../src/results/store.ts";
import { ActiveBranchOwnershipJournal } from "../../src/runtime/ownership.ts";

function ownedSession(): SessionManager {
  const session = SessionManager.inMemory(process.cwd(), { id: "parent-session" });
  const anchorId = session.appendCustomMessageEntry("fixture.anchor", "anchor", false);
  const writer = new ActiveBranchOwnershipJournal({
    appendEntry(customType: string, data: unknown) {
      session.appendCustomEntry(customType, data);
    },
  });
  let journal = writer.begin({
    runId: "run-1",
    runNonce: "nonce-1",
    branchEntryId: anchorId,
    sessionId: "parent-session",
    intended: { workspaceId: "w1", group: "g", worktreeRequested: false },
  });
  journal = writer.append(journal, "created", {
    tabId: "t", rootPaneId: "p0", rootTerminalId: "root", rootProcessBaseline: "baseline",
  });
  writer.append(journal, "started", { paneId: "p1", terminalId: "term-1" });
  return session;
}

async function capturedEnvelope(root: string) {
  const captured = createCapturedResult({
    source: "pi-final-assistant",
    runId: "run-1",
    runNonce: "nonce-1",
    generation: 1,
    requestNonce: "req-1",
    rawText: "structured final answer from child",
    stopReason: "stop",
    capturedAt: Date.now(),
  });
  const envelope = capturedToEnvelope(captured, {
    stage: "captured",
    parentSessionId: "parent-session",
  });
  await writeResultEnvelope(root, envelope);
  return envelope;
}

test("real Pi custom messages reconcile an immutable send-once result", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-flush-"));
  const session = ownedSession();
  const messages: Array<{ content: string; customType: string }> = [];
  const delivery = new ResultDeliveryService({
    pi: {
      sendMessage(message: { customType: string; content: string }) {
        messages.push({ customType: message.customType, content: message.content });
      },
    } as unknown as ExtensionAPI,
    getContext: () => ({ sessionManager: session }) as unknown as ExtensionContext,
    getCheckout: () => root,
    runtimeEpoch: "epoch-1",
    listQueued: async () => {
      const loaded = await readResultEnvelope(root, "run-1", 1);
      assert.ok(loaded);
      return [{
        envelope: loaded,
        profileName: "scout",
        terminalId: "term-1",
        actionText: "HERDR_ACTION_REQUIRED_V1 {\"noticeId\":\"act-1\"}\nACTION REQUIRED — writer review required\nnext=review and stop",
      }];
    },
  });

  try {
    await capturedEnvelope(root);
    await delivery.flush();

    assert.equal(messages.length, 1, "sendMessage must be called once");
    assert.equal(messages[0]!.customType, RESULT_CUSTOM_TYPE);
    assert.match(messages[0]!.content, /structured final answer from child/);
    assert.match(messages[0]!.content, /HERDR_RESULT_V1/);
    assert.match(messages[0]!.content, /deliveryId/);
    assert.match(messages[0]!.content, /HERDR_ACTION_REQUIRED_V1/);
    assert.match(messages[0]!.content, /review and stop/);

    let onDisk = await readResultEnvelope(root, "run-1", 1);
    assert.ok(onDisk);
    assert.equal(onDisk.deliveredText, messages[0]!.content, "disk deliveredText must equal sent content");
    assert.equal(onDisk.delivery.stage, "dispatched");
    assert.ok(onDisk.delivery.deliveryId);

    delivery.noteParentSettled();
    await delivery.flush();
    delivery.noteParentSettled();
    await delivery.flush();
    assert.equal(messages.length, 1, "settlement cannot resend in the same runtime epoch");

    const entryId = session.appendCustomMessageEntry(RESULT_CUSTOM_TYPE, messages[0]!.content, true);
    await delivery.reconcilePersistence();
    onDisk = await readResultEnvelope(root, "run-1", 1);
    assert.ok(onDisk);
    assert.equal(onDisk.delivery.stage, "parent_persisted");
    assert.equal(onDisk.delivery.parentEntryId, entryId);
    assert.equal(onDisk.deliveredText, messages[0]!.content);
    await delivery.flush();
    assert.equal(messages.length, 1);
  } finally {
    delivery.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a new runtime epoch replays one genuinely absent result", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-replay-"));
  const session = ownedSession();
  let sends = 0;
  const makeService = (runtimeEpoch: string) => new ResultDeliveryService({
    pi: { sendMessage() { sends += 1; } } as unknown as ExtensionAPI,
    getContext: () => ({ sessionManager: session }) as unknown as ExtensionContext,
    getCheckout: () => root,
    runtimeEpoch,
    listQueued: async () => {
      const envelope = await readResultEnvelope(root, "run-1", 1);
      assert.ok(envelope);
      return [{ envelope, profileName: "scout", terminalId: "term-1" }];
    },
  });

  try {
    await capturedEnvelope(root);
    const first = makeService("epoch-1");
    await first.flush();
    await first.flush();
    first.stop();
    assert.equal(sends, 1);

    const second = makeService("epoch-2");
    await second.flush();
    await second.flush();
    second.stop();
    assert.equal(sends, 2, "a new epoch may replay once when exact persistence is absent");
    assert.equal((await readResultEnvelope(root, "run-1", 1))!.delivery.attempt, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result persistence requires the first exact sentinel identity", () => {
  const session = SessionManager.inMemory();
  const first = { resultId: "res-first", deliveryId: "del-first", runId: "run-1", generation: 1 };
  const second = { resultId: "res-second", deliveryId: "del-second", runId: "run-2", generation: 2 };
  const content = [
    `HERDR_RESULT_V1 ${JSON.stringify(first)}`,
    "child body",
    `HERDR_RESULT_V1 ${JSON.stringify(second)}`,
    "ordinary text mentioning res-second and del-second",
  ].join("\n");
  const entryId = session.appendCustomMessageEntry(RESULT_CUSTOM_TYPE, content, true);
  assert.equal(findPersistedResultMessage(session.getBranch(), first)?.id, entryId);
  assert.equal(findPersistedResultMessage(session.getBranch(), second), undefined);

  for (const candidate of [
    { ...first, deliveryId: "wrong" },
    { ...first, resultId: "wrong" },
    { ...first, runId: "wrong" },
    { ...first, generation: 3 },
  ]) assert.equal(findPersistedResultMessage(session.getBranch(), candidate), undefined);

  const malformed = SessionManager.inMemory();
  malformed.appendCustomMessageEntry(RESULT_CUSTOM_TYPE, "HERDR_RESULT_V1 not-json\nres-first", true);
  assert.equal(findPersistedResultMessage(malformed.getBranch(), first), undefined);
  const wrongType = SessionManager.inMemory();
  wrongType.appendCustomMessageEntry("other", `HERDR_RESULT_V1 ${JSON.stringify(first)}`, true);
  assert.equal(findPersistedResultMessage(wrongType.getBranch(), first), undefined);
});
