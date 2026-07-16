import type { HerdrRequestClient } from "../herdr/client.ts";
import { HerdrApiError } from "../herdr/protocol.ts";
import { harnessAdapter } from "../harnesses/index.ts";
import {
  abortError,
  delay,
  readBoundedOutput,
  resolveOwnedPaneFresh,
  type BoundedOutput,
  type Delivery,
  type OwnedRunTarget,
} from "./control.ts";

export interface InterruptResult {
  readonly delivery: Delivery;
  readonly previousState: "working" | "blocked" | "done" | "idle" | "unknown";
  readonly state: "working" | "blocked" | "done" | "idle" | "unknown";
  readonly output: BoundedOutput;
  readonly reason?: string;
}

export async function interruptSubagent(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}): Promise<InterruptResult> {
  const before = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
  const beforeOutput = await readBoundedOutput(input.client, input.target, input.signal);
  if (before.agent.agent_status !== "working") {
    return {
      delivery: "confirmed",
      previousState: before.agent.agent_status,
      state: before.agent.agent_status,
      output: beforeOutput,
      reason: "Pane was not working; no interrupt key was sent",
    };
  }
  const adapter = harnessAdapter(input.target.harness);
  try {
    await input.client.sendKeys(before.pane.pane_id, adapter.capabilities.interruptKeys, input.signal);
  } catch (error) {
    if (error instanceof HerdrApiError) throw error;
    let state: InterruptResult["state"] = before.agent.agent_status;
    let output = beforeOutput;
    try {
      const latest = await resolveOwnedPaneFresh(input.client, input.target);
      state = latest.agent.agent_status;
      output = await readBoundedOutput(input.client, input.target);
    } catch { /* Preserve pre-request evidence. */ }
    return {
      delivery: "uncertain",
      previousState: before.agent.agent_status,
      state,
      output,
      reason: `Interrupt mutation response was lost or aborted after the key request was attempted; it may have succeeded and must not be retried automatically: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (input.signal?.aborted) throw abortError(input.signal);
      const current = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
      if (current.agent.agent_status !== "working") {
        return {
          delivery: "confirmed",
          previousState: before.agent.agent_status,
          state: current.agent.agent_status,
          output: await readBoundedOutput(input.client, input.target, input.signal),
        };
      }
      if (Date.now() >= deadline) {
        return {
          delivery: "unconfirmed",
          previousState: before.agent.agent_status,
          state: current.agent.agent_status,
          output: await readBoundedOutput(input.client, input.target, input.signal),
          reason: `Herdr accepted interrupt keys ${adapter.capabilities.interruptKeys.join("+")} but the pane remained working after ${timeoutMs}ms`,
        };
      }
      await delay(Math.min(input.pollIntervalMs ?? 50, Math.max(1, deadline - Date.now())), input.signal);
    }
  } catch (error) {
    let state: InterruptResult["state"] = before.agent.agent_status;
    let output = beforeOutput;
    try {
      const latest = await resolveOwnedPaneFresh(input.client, input.target);
      state = latest.agent.agent_status;
      output = await readBoundedOutput(input.client, input.target);
    } catch { /* Preserve pre-request evidence. */ }
    return {
      delivery: "unconfirmed",
      previousState: before.agent.agent_status,
      state,
      output,
      reason: `Herdr accepted the interrupt mutation but bounded follow-up evidence did not complete: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
