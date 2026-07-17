import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeResultId,
  createCapturedResult,
  capturedToEnvelope,
  formatResultRequestWire,
  parseResultEnvelope,
  parseResultRequestWire,
  sha256Text,
} from "../../src/results/contracts.ts";
import {
  generationResultFileName,
  listResultEnvelopes,
  parseGenerationResultFileName,
  readResultEnvelope,
  updateResultEnvelope,
  writeResultEnvelope,
} from "../../src/results/store.ts";

test("result filenames use one six-digit positive-generation contract", () => {
  assert.equal(generationResultFileName(1), "000001.json");
  assert.equal(generationResultFileName(999_999), "999999.json");
  assert.equal(parseGenerationResultFileName("000001.json"), 1);
  assert.equal(parseGenerationResultFileName("999999.json"), 999_999);
  for (const value of [0, -1, 1_000_000, 1.5, Number.NaN]) assert.throws(() => generationResultFileName(value), /1 through 999999/);
  for (const name of ["000000.json", "generation-1.json", "000001.txt", "1000000.json", "owner.json"]) {
    assert.equal(parseGenerationResultFileName(name), undefined);
  }
});

test("result IDs are deterministic from immutable facts", () => {
  const a = computeResultId({
    runId: "run-1",
    runNonce: "nonce",
    generation: 1,
    requestNonce: "req",
    rawTextSha256: sha256Text("hello"),
    source: "pi-final-assistant",
  });
  const b = computeResultId({
    runId: "run-1",
    runNonce: "nonce",
    generation: 1,
    requestNonce: "req",
    rawTextSha256: sha256Text("hello"),
    source: "pi-final-assistant",
  });
  assert.equal(a, b);
  assert.notEqual(a, computeResultId({
    runId: "run-1",
    runNonce: "nonce",
    generation: 2,
    requestNonce: "req",
    rawTextSha256: sha256Text("hello"),
    source: "pi-final-assistant",
  }));
});

test("request wire format parses only exact first-line markers", () => {
  const wire = formatResultRequestWire({
    runId: "run-1",
    runNonce: "nonce",
    generation: 2,
    requestNonce: "req-2",
  }, "do the work");
  const parsed = parseResultRequestWire(wire);
  assert.deepEqual(parsed?.marker, { runId: "run-1", runNonce: "nonce", generation: 2, requestNonce: "req-2" });
  assert.equal(parsed?.task, "do the work");
  assert.equal(parseResultRequestWire("not a marker\n---\n\"x\""), undefined);
  assert.equal(parseResultRequestWire("hello\nHERDR_RESULT_REQUEST_V1 {}\n---\n\"x\""), undefined);
});

test("result store persists envelopes atomically and refuses immutable collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "result-store-"));
  try {
    const captured = createCapturedResult({
      source: "pi-final-assistant",
      runId: "run-1",
      runNonce: "nonce",
      generation: 1,
      requestNonce: "req",
      rawText: "final answer",
      stopReason: "stop",
    });
    const envelope = capturedToEnvelope(captured, {
      stage: "captured",
      parentSessionId: "parent",
    });
    await writeResultEnvelope(root, envelope);
    const loaded = await readResultEnvelope(root, "run-1", 1);
    assert.equal(loaded?.rawText, "final answer");
    assert.equal(parseResultEnvelope(loaded).resultId, envelope.resultId);

    await writeResultEnvelope(root, envelope);

    const other = capturedToEnvelope(createCapturedResult({
      source: "pi-final-assistant",
      runId: "run-1",
      runNonce: "nonce",
      generation: 1,
      requestNonce: "req",
      rawText: "different",
    }), { stage: "captured", parentSessionId: "parent" });
    await assert.rejects(writeResultEnvelope(root, other), /collision|differs/i);

    const updated = await updateResultEnvelope(root, "run-1", 1, (current) => ({
      ...current,
      deliveredText: "bounded payload",
      delivery: { ...current.delivery, stage: "dispatched", deliveryId: "del-1" },
    }));
    assert.equal(updated.deliveredText, "bounded payload");
    assert.equal(updated.delivery.stage, "dispatched");
    await assert.rejects(updateResultEnvelope(root, "run-1", 1, (current) => ({
      ...current,
      deliveredText: "changed",
    })), /deliveredText is assigned once/);

    const listed = await listResultEnvelopes(root, "run-1");
    assert.equal(listed.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result envelope parser enforces source-specific terminal metadata", () => {
  const captured = createCapturedResult({
    source: "pi-final-assistant",
    runId: "run-1",
    runNonce: "n",
    generation: 1,
    requestNonce: "r",
    rawText: "x",
  });
  const envelope = capturedToEnvelope(captured, { stage: "captured", parentSessionId: "p" });
  assert.throws(() => parseResultEnvelope({ ...envelope, rawTextSha256: "0".repeat(64) }), /rawTextSha256/);
  assert.throws(() => parseResultEnvelope({ ...envelope, resultId: "res-wrong" }), /resultId/);
  assert.throws(() => parseResultEnvelope({ ...envelope, source: "terminal-fallback" }), /result source/);
  assert.throws(() => parseResultEnvelope({ ...envelope, terminalOutput: { outputRevision: 1, truncated: false } }), /must not include terminalOutput/);

  const terminal = capturedToEnvelope(createCapturedResult({
    source: "herdr-terminal-output",
    terminalOutput: { outputRevision: 7, truncated: true },
    runId: "run-1", runNonce: "n", generation: 2, requestNonce: "r2", rawText: "bounded transcript",
  }), { stage: "captured", parentSessionId: "p" });
  assert.deepEqual(parseResultEnvelope(terminal).terminalOutput, { outputRevision: 7, truncated: true });
  assert.throws(() => parseResultEnvelope({ ...terminal, terminalOutput: undefined }), /terminalOutput/);
  assert.throws(() => createCapturedResult({ source: "herdr-terminal-output", terminalOutput: { outputRevision: 1, truncated: false }, runId: "r", runNonce: "n", generation: 1, requestNonce: "q", rawText: "   " }), /non-empty/);
});
