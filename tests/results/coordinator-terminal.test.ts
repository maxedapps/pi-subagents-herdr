import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrStatus } from "../../src/contracts/state.ts";
import type { GenerationSummary } from "../../src/results/contracts.ts";
import { ResultCoordinator, type CoordinatorRunView } from "../../src/results/coordinator.ts";
import { listResultEnvelopes } from "../../src/results/store.ts";

function fixture(root: string, overrides: Partial<CoordinatorRunView> = {}) {
  let activeGeneration: GenerationSummary | undefined;
  let nextGeneration = 1;
  let status: HerdrStatus = overrides.herdrStatus ?? "idle";
  const run = {
    id: "run-1", runNonce: "nonce-1", harness: "grok" as const, profileName: "grok-scout",
    lifecycle: "running", parentSessionId: "parent", nextGeneration: 1, herdrStatus: status,
    ...overrides,
  } as CoordinatorRunView;
  Object.defineProperties(run, {
    activeGeneration: { get: () => activeGeneration, set: (value) => { activeGeneration = value; }, enumerable: true },
    nextGeneration: { get: () => nextGeneration, set: (value) => { nextGeneration = value; }, enumerable: true },
    herdrStatus: { get: () => status, set: (value) => { status = value; }, enumerable: true },
  });
  return { run, setStatus(value: HerdrStatus) { status = value; }, active: () => activeGeneration };
}

test("confirmed terminal non-Pi generations retry bounded reads and persist one transcript envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "result-terminal-coordinator-"));
  try {
    const value = fixture(root);
    let reads = 0; let captured = 0;
    const coordinator = new ResultCoordinator({
      getCheckout: () => root, listRuns: () => [value.run], getRun: () => value.run,
      persistRunMetadata: async () => undefined,
      captureTerminalOutput: async () => {
        reads += 1;
        if (reads === 1) throw new Error("transient read");
        if (reads === 2) return { text: "", revision: 2, truncated: false };
        return { text: "bounded terminal transcript 🙂", revision: 3, truncated: true };
      },
      onResultCaptured: () => { captured += 1; },
    });
    await coordinator.prepareGeneration({ runId: value.run.id, originalInput: "do work" });
    await coordinator.recordSubmission(value.run.id, "confirmed");
    value.setStatus("done");
    await coordinator.reconcileRun(value.run.id);
    assert.equal(reads, 3); assert.equal(captured, 1); assert.equal(value.active()?.phase, "captured");
    const [envelope] = await listResultEnvelopes(root, value.run.id);
    assert.equal(envelope?.source, "herdr-terminal-output");
    assert.deepEqual(envelope?.terminalOutput, { outputRevision: 3, truncated: true });
    assert.equal(envelope?.rawText, "bounded terminal transcript 🙂");
    await coordinator.reconcileRun(value.run.id);
    assert.equal(reads, 3, "captured generations must not be read again");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-Pi capture rejects uncertain, nonterminal, empty, and failed reads without envelopes", async (t) => {
  for (const scenario of ["uncertain", "working", "empty", "failure"] as const) await t.test(scenario, async () => {
    const root = await mkdtemp(join(tmpdir(), `result-terminal-${scenario}-`));
    try {
      const value = fixture(root); let reads = 0;
      const coordinator = new ResultCoordinator({
        getCheckout: () => root, listRuns: () => [value.run], getRun: () => value.run, persistRunMetadata: async () => undefined,
        settlementGraceMs: 0,
        captureTerminalOutput: async () => { reads += 1; if (scenario === "failure") throw new Error("read failed"); return { text: "", revision: reads, truncated: false }; },
      });
      await coordinator.prepareGeneration({ runId: value.run.id, originalInput: "do work" });
      value.setStatus(scenario === "working" ? "working" : "done");
      await coordinator.recordSubmission(value.run.id, scenario === "uncertain" ? "uncertain" : "confirmed");
      await coordinator.reconcileRun(value.run.id);
      assert.equal((await listResultEnvelopes(root, value.run.id)).length, 0);
      if (scenario === "working") { assert.equal(value.active()?.phase, "submitted"); assert.equal(reads, 0); }
      else { assert.equal(value.active()?.phase, "closed"); assert.equal(reads, scenario === "uncertain" ? 0 : 3); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("stop barrier reuses a persisted terminal envelope without rereading", async () => {
  const root = await mkdtemp(join(tmpdir(), "result-terminal-barrier-"));
  try {
    const value = fixture(root); let reads = 0;
    const coordinator = new ResultCoordinator({
      getCheckout: () => root, listRuns: () => [value.run], getRun: () => value.run, persistRunMetadata: async () => undefined,
      captureTerminalOutput: async () => ({ text: `capture-${++reads}`, revision: reads, truncated: false }),
    });
    await coordinator.prepareGeneration({ runId: value.run.id, originalInput: "do work" }); await coordinator.recordSubmission(value.run.id, "confirmed"); value.setStatus("idle");
    const first = await coordinator.captureBarrier(value.run.id); assert.equal(first.durable, true); assert.equal(reads, 1);
    const { resultId: _resultId, source: _source, ...submitted } = value.run.activeGeneration!;
    value.run.activeGeneration = { ...submitted, phase: "submitted" };
    const second = await coordinator.captureBarrier(value.run.id); assert.equal(second.envelope?.resultId, first.envelope?.resultId); assert.equal(reads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
