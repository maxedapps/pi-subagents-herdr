import { randomUUID } from "node:crypto";
import type { HerdrStatus } from "../contracts/state.ts";
import type { Harness } from "../contracts/harness.ts";
import {
  capturedToEnvelope,
  formatResultRequestWire,
  generationAwaitingCapture,
  sha256Text,
  type GenerationSummary,
  type ResultEnvelopeV1,
  type SubmissionCertainty,
} from "./contracts.ts";
import { writeResultRequestFile } from "./child-bridge.ts";
import { captureHerdrTerminalOutput, tryCapturePiBridge, type CaptureOutcome, type PendingGeneration, type TerminalOutputCapture } from "./extractors.ts";
import { listResultEnvelopes, writeResultEnvelope } from "./store.ts";

export interface CoordinatorRunView {
  readonly id: string;
  readonly runNonce: string;
  readonly harness: Harness;
  readonly profileName: string;
  readonly lifecycle: string;
  readonly herdrStatus: HerdrStatus;
  readonly parentSessionId: string;
  readonly parentSessionPath?: string;
  activeGeneration?: GenerationSummary;
  nextGeneration: number;
  readonly ephemeral?: {
    readonly directory: string;
    readonly resultExchangeDirectory?: string;
  };
}

export interface CoordinatorHooks {
  readonly getCheckout: () => string | undefined;
  readonly listRuns: () => readonly CoordinatorRunView[];
  readonly getRun: (runId: string) => CoordinatorRunView | undefined;
  readonly persistRunMetadata: (runId: string) => Promise<void>;
  readonly captureTerminalOutput?: (runId: string) => Promise<TerminalOutputCapture>;
  readonly onResultCaptured?: (envelope: ResultEnvelopeV1) => void;
  readonly settlementGraceMs?: number;
  readonly reconcileIntervalMs?: number;
}

class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    const result = previous.then(operation, operation);
    void result.finally(() => { release(); });
    return result;
  }
}

export class ResultCoordinator {
  readonly #hooks: CoordinatorHooks;
  readonly #runQueues = new Map<string, SerialQueue>();
  readonly #submittedAt = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(hooks: CoordinatorHooks) {
    this.#hooks = hooks;
  }

  start(): void {
    this.#stopped = false;
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const queue of this.#runQueues.values()) {
      await queue.run(async () => undefined);
    }
  }

  /** Event-driven wake; also covered by the single periodic safety scan. */
  wake(): void {
    if (this.#stopped) return;
    void this.reconcileAll().catch(() => undefined);
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const interval = this.#hooks.reconcileIntervalMs ?? 2_000;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.reconcileAll()
        .catch(() => undefined)
        .finally(() => this.#schedule());
    }, interval);
    this.#timer.unref?.();
  }

  #queueFor(runId: string): SerialQueue {
    let queue = this.#runQueues.get(runId);
    if (!queue) {
      queue = new SerialQueue();
      this.#runQueues.set(runId, queue);
    }
    return queue;
  }

  canSubmitGeneration(run: CoordinatorRunView): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (run.lifecycle === "stopped" || run.lifecycle === "failed" || run.lifecycle === "lost") {
      return { ok: false, reason: `Run lifecycle ${run.lifecycle} cannot accept a new generation` };
    }
    if (run.herdrStatus === "working") {
      return { ok: false, reason: "Cannot submit a new model generation while the child is working" };
    }
    const active = run.activeGeneration;
    if (!active) return { ok: true };
    if (active.phase === "preparing") {
      return { ok: false, reason: "A generation is mid-submit; wait for confirmation before sending another" };
    }
    if (active.phase === "submitted") {
      if (active.certainty === "uncertain" || active.certainty === "unconfirmed") {
        return { ok: false, reason: "Previous generation submission is uncertain and must not be retried automatically" };
      }
      if (run.herdrStatus === "blocked" || run.herdrStatus === "done" || run.herdrStatus === "idle") {
        return { ok: true };
      }
      return { ok: false, reason: "Previous generation has not been captured or closed yet" };
    }
    if (run.herdrStatus !== "blocked" && run.herdrStatus !== "done" && run.herdrStatus !== "idle") {
      return { ok: false, reason: `Cannot submit while child status is ${run.herdrStatus}` };
    }
    return { ok: true };
  }

  runExclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return this.#queueFor(runId).run(operation);
  }

  async prepareGeneration(input: {
    readonly runId: string;
    readonly originalInput: string;
  }): Promise<{ readonly generation: number; readonly requestNonce: string; readonly wrappedInput: string; readonly summary: GenerationSummary }> {
    return this.#queueFor(input.runId).run(() => this.prepareGenerationUnlocked(input));
  }

  async prepareGenerationUnlocked(input: {
    readonly runId: string;
    readonly originalInput: string;
  }): Promise<{ readonly generation: number; readonly requestNonce: string; readonly wrappedInput: string; readonly summary: GenerationSummary }> {
    const run = this.#hooks.getRun(input.runId);
    if (!run) throw new Error(`Unknown run for generation prepare: ${input.runId}`);
    const allowed = this.canSubmitGeneration(run);
    if (!allowed.ok) throw new Error(allowed.reason);

    if (
      run.activeGeneration
      && generationAwaitingCapture(run.activeGeneration)
      && (run.herdrStatus === "blocked" || run.herdrStatus === "done" || run.herdrStatus === "idle")
    ) {
      try {
        await this.#reconcileRun(run.id);
      } catch { /* best-effort capture before close */ }
      const refreshed = this.#hooks.getRun(input.runId) ?? run;
      if (refreshed.activeGeneration && generationAwaitingCapture(refreshed.activeGeneration)) {
        refreshed.activeGeneration = {
          ...refreshed.activeGeneration,
          phase: "closed",
          closedReason: `closed-before-next-generation:${refreshed.herdrStatus}`,
        };
        await this.#hooks.persistRunMetadata(input.runId);
      }
    }

    const current = this.#hooks.getRun(input.runId) ?? run;
    const recheck = this.canSubmitGeneration(current);
    if (!recheck.ok) throw new Error(recheck.reason);

    const generation = current.nextGeneration;
    const requestNonce = randomUUID();
    const summary: GenerationSummary = {
      generation,
      requestNonce,
      inputSha256: sha256Text(input.originalInput),
      phase: "preparing",
      preparedAt: Date.now(),
    };
    current.nextGeneration = generation + 1;
    current.activeGeneration = summary;

    // Structured capture only exists for Pi with a private exchange directory.
    if (current.harness === "pi" && current.ephemeral?.resultExchangeDirectory) {
      await writeResultRequestFile(current.ephemeral.resultExchangeDirectory, {
        runId: current.id,
        runNonce: current.runNonce,
        generation,
        requestNonce,
      });
    }

    const wrappedInput = current.harness === "pi" && current.ephemeral?.resultExchangeDirectory
      ? formatResultRequestWire({
          runId: current.id,
          runNonce: current.runNonce,
          generation,
          requestNonce,
        }, input.originalInput)
      : input.originalInput;

    await this.#hooks.persistRunMetadata(current.id);
    this.#submittedAt.set(`${current.id}:${generation}`, Date.now());
    return { generation, requestNonce, wrappedInput, summary };
  }

  async recordSubmission(runId: string, certainty: SubmissionCertainty | "blocked" | "closed"): Promise<void> {
    return this.#queueFor(runId).run(() => this.recordSubmissionUnlocked(runId, certainty));
  }

  async recordSubmissionUnlocked(runId: string, certainty: SubmissionCertainty | "blocked" | "closed"): Promise<void> {
    const run = this.#hooks.getRun(runId);
    if (!run?.activeGeneration) return;
    if (run.activeGeneration.phase === "captured" || run.activeGeneration.phase === "closed" || run.activeGeneration.phase === "blocked") {
      return;
    }
    if (certainty === "blocked") {
      run.activeGeneration = {
        ...run.activeGeneration,
        phase: "blocked",
        closedReason: "blocked-before-completion",
      };
    } else if (certainty === "closed") {
      run.activeGeneration = {
        ...run.activeGeneration,
        phase: "closed",
        closedReason: "closed-before-completion",
      };
    } else {
      run.activeGeneration = {
        ...run.activeGeneration,
        phase: "submitted",
        certainty,
      };
    }
    await this.#hooks.persistRunMetadata(runId);
    if (certainty === "confirmed" || certainty === "unconfirmed" || certainty === "uncertain") this.wake();
  }

  async reconcileAll(): Promise<void> {
    if (this.#stopped) return;
    for (const run of this.#hooks.listRuns()) {
      await this.#queueFor(run.id).run(() => this.#reconcileRun(run.id));
    }
  }

  async reconcileRun(runId: string): Promise<void> {
    await this.#queueFor(runId).run(() => this.#reconcileRun(runId));
  }

  async #capturePending(run: CoordinatorRunView, active: GenerationSummary, graceExpired: boolean): Promise<CaptureOutcome> {
    const pending: PendingGeneration = { generation: active.generation, requestNonce: active.requestNonce, summary: active };
    const extractorRun = { id: run.id, runNonce: run.runNonce, harness: run.harness, ...(run.ephemeral === undefined ? {} : { ephemeral: run.ephemeral }) };
    if (run.harness === "pi") return tryCapturePiBridge({ run: extractorRun, generation: pending, graceExpired });
    if (active.certainty !== "confirmed") return { kind: "unavailable", reason: "Non-Pi submission is not confirmed" };
    if (run.herdrStatus !== "done" && run.herdrStatus !== "idle" && run.herdrStatus !== "blocked") {
      return { kind: "unavailable", reason: `Non-Pi generation is not at a terminal Herdr state (${run.herdrStatus})` };
    }
    if (!this.#hooks.captureTerminalOutput) return { kind: "unavailable", reason: "Herdr terminal capture hook is unavailable" };
    let reason = "Herdr terminal capture failed";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const outcome = captureHerdrTerminalOutput({ run: extractorRun, generation: pending, output: await this.#hooks.captureTerminalOutput(run.id) });
        if (outcome.kind === "captured") return outcome;
        reason = outcome.kind === "unavailable" ? outcome.reason : "Herdr terminal output is not ready";
      } catch (error) {
        reason = `Herdr terminal read failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    }
    return { kind: "unavailable", reason };
  }

  async #existingEnvelope(runId: string, generation: number): Promise<ResultEnvelopeV1 | undefined> {
    const checkout = this.#hooks.getCheckout();
    if (!checkout) return undefined;
    return (await listResultEnvelopes(checkout, runId)).find((item) => item.generation === generation);
  }

  async #adoptExisting(run: CoordinatorRunView, active: GenerationSummary): Promise<ResultEnvelopeV1 | undefined> {
    const existing = await this.#existingEnvelope(run.id, active.generation);
    if (!existing) return undefined;
    const still = this.#hooks.getRun(run.id);
    if (!still?.activeGeneration || still.activeGeneration.generation !== active.generation || !generationAwaitingCapture(still.activeGeneration)) return existing;
    still.activeGeneration = { ...active, phase: "captured", resultId: existing.resultId, source: existing.source };
    await this.#hooks.persistRunMetadata(run.id);
    this.#hooks.onResultCaptured?.(existing);
    return existing;
  }

  async #reconcileRun(runId: string): Promise<void> {
    if (this.#stopped) return;
    const run = this.#hooks.getRun(runId);
    if (!run) return;
    const active = run.activeGeneration;
    if (!active || !generationAwaitingCapture(active)) return;

    const terminalState = run.herdrStatus === "done" || run.herdrStatus === "idle" || run.herdrStatus === "blocked"
      || run.herdrStatus === "unknown"
      ? run.herdrStatus
      : "unknown";
    if (terminalState === "unknown" && run.herdrStatus === "working") return;

    const submittedAt = this.#submittedAt.get(`${runId}:${active.generation}`) ?? active.preparedAt;
    const graceMs = this.#hooks.settlementGraceMs ?? 1_500;
    const graceExpired = Date.now() - submittedAt >= graceMs
      || terminalState === "done"
      || terminalState === "idle"
      || terminalState === "blocked";

    if (await this.#adoptExisting(run, active)) return;
    const outcome = await this.#capturePending(run, active, graceExpired);

    if (outcome.kind === "not-ready") return;

    if (outcome.kind === "unavailable") {
      if (!graceExpired) return;
      // No invented terminal result: close without an envelope once grace expires.
      const still = this.#hooks.getRun(runId);
      if (!still?.activeGeneration || still.activeGeneration.generation !== active.generation) return;
      if (!generationAwaitingCapture(still.activeGeneration)) return;
      still.activeGeneration = {
        ...active,
        phase: "closed",
        closedReason: `capture-unavailable:${outcome.reason}`,
      };
      await this.#hooks.persistRunMetadata(runId);
      return;
    }

    const checkout = this.#hooks.getCheckout();
    if (!checkout) return;

    const still = this.#hooks.getRun(runId);
    if (!still?.activeGeneration || still.activeGeneration.generation !== active.generation) return;
    if (!generationAwaitingCapture(still.activeGeneration)) return;

    const envelope = capturedToEnvelope(outcome.result, {
      stage: "captured",
      parentSessionId: run.parentSessionId,
      ...(run.parentSessionPath === undefined ? {} : { parentSessionPath: run.parentSessionPath }),
    });

    try {
      await writeResultEnvelope(checkout, envelope);
    } catch (error) {
      if (error instanceof Error && /collision|differs/i.test(error.message)) {
        still.activeGeneration = {
          ...active,
          phase: "closed",
          closedReason: `result-collision:${error.message}`,
        };
        await this.#hooks.persistRunMetadata(runId);
        return;
      }
      throw error;
    }

    still.activeGeneration = {
      ...active,
      phase: "captured",
      resultId: envelope.resultId,
      source: envelope.source,
    };
    await this.#hooks.persistRunMetadata(runId);
    this.#hooks.onResultCaptured?.(envelope);
  }

  /** Stop capture barrier: exact Pi bridge or confirmed terminal-state non-Pi transcript. */
  async captureBarrier(
    runId: string,
  ): Promise<{ readonly envelope?: ResultEnvelopeV1; readonly durable: boolean; readonly uncertain: boolean }> {
    return this.#queueFor(runId).run(() => this.#captureBarrierLocked(runId));
  }

  async #captureBarrierLocked(
    runId: string,
  ): Promise<{ readonly envelope?: ResultEnvelopeV1; readonly durable: boolean; readonly uncertain: boolean }> {
    const run = this.#hooks.getRun(runId);
    const checkout = this.#hooks.getCheckout();
    if (!run?.activeGeneration) {
      if (!checkout) return { durable: false, uncertain: true };
      const existing = await listResultEnvelopes(checkout, runId);
      const last = existing.at(-1);
      return last ? { envelope: last, durable: true, uncertain: false } : { durable: true, uncertain: false };
    }
    if (run.activeGeneration.phase === "captured") {
      if (!checkout) return { durable: false, uncertain: true };
      const existing = await listResultEnvelopes(checkout, runId);
      const found = existing.find((item) => item.generation === run.activeGeneration!.generation) ?? existing.at(-1);
      return found
        ? { envelope: found, durable: true, uncertain: false }
        : { durable: false, uncertain: true };
    }

    const active = run.activeGeneration;
    if (active.phase === "preparing") {
      run.activeGeneration = {
        ...active,
        phase: "closed",
        closedReason: "stopped-before-submission",
      };
      await this.#hooks.persistRunMetadata(runId);
      return { durable: true, uncertain: false };
    }

    if (active.phase === "closed" || active.phase === "blocked") {
      if (!checkout) return { durable: true, uncertain: false };
      const existing = await listResultEnvelopes(checkout, runId);
      const found = existing.find((item) => item.generation === active.generation);
      return found
        ? { envelope: found, durable: true, uncertain: false }
        : { durable: true, uncertain: false };
    }

    // phase === submitted: reuse a durable envelope before any fresh read.
    const adopted = await this.#adoptExisting(run, active);
    if (adopted) return { envelope: adopted, durable: true, uncertain: false };
    const outcome = await this.#capturePending(run, active, true);

    if (outcome.kind !== "captured") {
      run.activeGeneration = {
        ...active,
        phase: "closed",
        closedReason: outcome.kind === "unavailable"
          ? `capture-unavailable-at-stop:${outcome.reason}`
          : "capture-unavailable-at-stop",
      };
      await this.#hooks.persistRunMetadata(runId);
      return { durable: false, uncertain: true };
    }

    if (!checkout) return { durable: false, uncertain: true };
    const existing = await listResultEnvelopes(checkout, runId);
    const already = existing.find((item) => item.generation === active.generation);
    if (already) {
      run.activeGeneration = {
        ...active,
        phase: "captured",
        resultId: already.resultId,
        source: already.source,
      };
      await this.#hooks.persistRunMetadata(runId);
      return { envelope: already, durable: true, uncertain: false };
    }
    const envelope = capturedToEnvelope(outcome.result, {
      stage: "captured",
      parentSessionId: run.parentSessionId,
      ...(run.parentSessionPath === undefined ? {} : { parentSessionPath: run.parentSessionPath }),
    });
    try {
      await writeResultEnvelope(checkout, envelope);
    } catch (error) {
      if (error instanceof Error && /collision|differs/i.test(error.message)) {
        const latest = (await listResultEnvelopes(checkout, runId)).find((item) => item.generation === active.generation);
        if (latest) {
          run.activeGeneration = {
            ...active,
            phase: "captured",
            resultId: latest.resultId,
            source: latest.source,
          };
          await this.#hooks.persistRunMetadata(runId);
          return { envelope: latest, durable: true, uncertain: false };
        }
        run.activeGeneration = {
          ...active,
          phase: "closed",
          closedReason: `result-collision:${error.message}`,
        };
        await this.#hooks.persistRunMetadata(runId);
        return { durable: false, uncertain: true };
      }
      return { durable: false, uncertain: true };
    }
    run.activeGeneration = {
      ...active,
      phase: "captured",
      resultId: envelope.resultId,
      source: envelope.source,
    };
    await this.#hooks.persistRunMetadata(runId);
    this.#hooks.onResultCaptured?.(envelope);
    return { envelope, durable: true, uncertain: false };
  }
}
