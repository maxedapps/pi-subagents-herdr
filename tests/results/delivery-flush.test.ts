import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createCapturedResult,
  capturedToEnvelope,
} from "../../src/results/contracts.ts";
import { ResultDeliveryService } from "../../src/results/delivery.ts";
import { readResultEnvelope, writeResultEnvelope } from "../../src/results/store.ts";
import { ActiveBranchOwnershipJournal, type PiBranchEntry } from "../../src/runtime/ownership.ts";

test("store-backed flush freezes deliveredText once and calls sendMessage with matching bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-flush-"));
  try {
    const branch: PiBranchEntry[] = [{ type: "message", id: "leaf", parentId: null }];
    const journalApi = {
      appendEntry(customType: string, data: unknown) {
        branch.push({ type: "custom", id: `e${branch.length}`, parentId: branch.at(-1)!.id, customType, data });
      },
    };
    const writer = new ActiveBranchOwnershipJournal(journalApi);
    let journal = writer.begin({
      runId: "run-1",
      runNonce: "nonce-1",
      branchEntryId: "leaf",
      sessionId: "parent-session",
      intended: { workspaceId: "w1", group: "g", worktreeRequested: false },
    });
    journal = writer.append(journal, "created", {
      tabId: "t", rootPaneId: "p0", rootTerminalId: "root", rootProcessBaseline: "baseline",
    });
    journal = writer.append(journal, "started", { paneId: "p1", terminalId: "term-1" });

    const captured = createCapturedResult({
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

    const messages: Array<{ content: string; customType: string }> = [];
    const pi = {
      sendMessage(message: { customType: string; content: string }) {
        messages.push({ customType: message.customType, content: message.content });
      },
    } as unknown as ExtensionAPI;

    const context = {
      sessionManager: {
        getSessionId: () => "parent-session",
        getSessionFile: () => undefined,
        getBranch: () => branch,
      },
    } as unknown as ExtensionContext;

    const delivery = new ResultDeliveryService({
      pi,
      getContext: () => context,
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

    await delivery.flush();

    assert.equal(messages.length, 1, "sendMessage must be called once");
    assert.equal(messages[0]!.customType, "herdr-subagents.result.v1");
    assert.match(messages[0]!.content, /structured final answer from child/);
    assert.match(messages[0]!.content, /HERDR_RESULT_V1/);
    assert.match(messages[0]!.content, /deliveryId/);
    assert.match(messages[0]!.content, /HERDR_ACTION_REQUIRED_V1/);
    assert.match(messages[0]!.content, /review and stop/);

    const onDisk = await readResultEnvelope(root, "run-1", 1);
    assert.ok(onDisk);
    assert.equal(onDisk.deliveredText, messages[0]!.content, "disk deliveredText must equal sent content");
    assert.equal(onDisk.delivery.stage, "dispatched");
    assert.ok(onDisk.delivery.deliveryId);

    await delivery.flush();
    assert.equal((await readResultEnvelope(root, "run-1", 1))!.deliveredText, messages[0]!.content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
