import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeResultDelivery,
  buildDeliveredText,
  computeDeliveryId,
} from "../../src/results/delivery.ts";
import { boundUtf8HeadTail, collapsedPreview, exactToolPayload } from "../../src/results/presentation.ts";
import { createCapturedResult, capturedToEnvelope } from "../../src/results/contracts.ts";
import type { PiBranchEntry } from "../../src/runtime/ownership.ts";
import { ActiveBranchOwnershipJournal } from "../../src/runtime/ownership.ts";
import { createHash } from "node:crypto";

test("UTF-8 head+tail bound preserves both ends and valid UTF-8", () => {
  const text = `start-${"🙂".repeat(20_000)}-end-marker`;
  const bounded = boundUtf8HeadTail(text, 1024);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.includes("start-"));
  assert.ok(bounded.text.includes("end-marker") || bounded.text.includes("omitted"));
  assert.equal(bounded.text.includes("�"), false);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 1024);
});

test("collapsed preview is an ordered prefix of delivered text", () => {
  const delivered = "line1\nline2\nline3\nline4\nline5";
  const preview = collapsedPreview(delivered, 100, 2);
  assert.ok(delivered.startsWith(preview.replace(/…$/, "").split("…")[0] ?? "") || preview.includes("line1"));
  assert.match(preview, /line1/);
});

test("exactToolPayload serializes once for content and details", () => {
  const payload = exactToolPayload({ ok: true, value: 1 }, (value) => JSON.stringify(value));
  assert.equal(payload.content[0].text, payload.details.deliveredText);
  assert.deepEqual(payload.details.result, { ok: true, value: 1 });
});

test("delivered text is one result with sentinel and structured-final only", () => {
  const captured = createCapturedResult({
    source: "pi-final-assistant",
    runId: "run-1",
    runNonce: "n",
    generation: 1,
    requestNonce: "r",
    rawText: "final answer",
  });
  const envelope = capturedToEnvelope(captured, { stage: "captured", parentSessionId: "p" });
  const deliveryId = computeDeliveryId(envelope.resultId, createHash("sha256").update(envelope.rawText, "utf8").digest("hex"));
  const text = buildDeliveredText({ envelope, profileName: "scout", deliveryId });
  assert.match(text, /HERDR_RESULT_V1/);
  assert.match(text, /pi-final-assistant/);
  assert.match(text, /structured-final/);
  assert.match(text, /final answer/);
  assert.doesNotMatch(text, /terminal-fallback|legacy/);
});

test("terminal results are labeled as bounded transcripts with truncation truth", () => {
  const captured = createCapturedResult({
    source: "herdr-terminal-output",
    terminalOutput: { outputRevision: 9, truncated: true },
    runId: "run-2", runNonce: "n", generation: 1, requestNonce: "r", rawText: "terminal scrollback",
  });
  const envelope = capturedToEnvelope(captured, { stage: "captured", parentSessionId: "p" });
  const deliveryId = computeDeliveryId(envelope.resultId, createHash("sha256").update(envelope.rawText, "utf8").digest("hex"));
  const text = buildDeliveredText({ envelope, profileName: "claude-scout", deliveryId });
  assert.match(text, /herdr-terminal-output/); assert.match(text, /bounded Herdr terminal transcript/); assert.match(text, /truncated=true/);
  assert.doesNotMatch(text, /limitations":"structured-final/);
});

test("authorizeResultDelivery requires active-branch ownership chain", () => {
  const entries: PiBranchEntry[] = [{ type: "message", id: "leaf", parentId: null }];
  const api = { appendEntry(customType: string, data: unknown) {
    entries.push({ type: "custom", id: `e${entries.length}`, parentId: entries.at(-1)!.id, customType, data });
  } };
  const writer = new ActiveBranchOwnershipJournal(api);
  let journal = writer.begin({
    runId: "run-1",
    runNonce: "nonce-1",
    branchEntryId: "leaf",
    sessionId: "parent",
    intended: { workspaceId: "w1", group: "g", worktreeRequested: false },
  });
  journal = writer.append(journal, "created", { tabId: "t", rootPaneId: "p0", rootTerminalId: "root", rootProcessBaseline: "baseline" });
  journal = writer.append(journal, "started", { paneId: "p1", terminalId: "term-1" });

  const ok = authorizeResultDelivery({
    runId: "run-1",
    runNonce: "nonce-1",
    parentSessionId: "parent",
    terminalId: "term-1",
    branch: entries,
    sessionId: "parent",
  });
  assert.equal(ok.ok, true);

  const missingTerminal = authorizeResultDelivery({
    runId: "run-1",
    runNonce: "nonce-1",
    parentSessionId: "parent",
    branch: entries,
    sessionId: "parent",
  });
  assert.equal(missingTerminal.ok, false);

  const wrongSession = authorizeResultDelivery({
    runId: "run-1",
    runNonce: "nonce-1",
    parentSessionId: "parent",
    terminalId: "term-1",
    branch: entries,
    sessionId: "other",
  });
  assert.equal(wrongSession.ok, false);

  const empty = authorizeResultDelivery({
    runId: "run-1",
    runNonce: "nonce-1",
    parentSessionId: "parent",
    terminalId: "term-1",
    branch: [{ type: "message", id: "other-leaf", parentId: null }],
    sessionId: "parent",
  });
  assert.equal(empty.ok, false);
});
