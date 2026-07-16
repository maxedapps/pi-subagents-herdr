import type { HerdrRequestClient } from "../herdr/client.ts";
import { harnessAdapter } from "../harnesses/index.ts";
import {
  abortError,
  delay,
  readBoundedOutput,
  resolveOwnedPaneFresh,
  type BoundedOutput,
  type OwnedRunTarget,
} from "./control.ts";

export interface InterruptResult {
  readonly sent: boolean;
  readonly confirmed: boolean;
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
  if (before.agent.agent_status !== "working") {
    return {
      sent: false,
      confirmed: true,
      previousState: before.agent.agent_status,
      state: before.agent.agent_status,
      output: await readBoundedOutput(input.client, input.target, input.signal),
      reason: "Pane was not working; no interrupt key was sent",
    };
  }
  const adapter = harnessAdapter(input.target.harness);
  await input.client.sendKeys(before.pane.pane_id, adapter.capabilities.interruptKeys, input.signal);
  const timeoutMs = input.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (input.signal?.aborted) throw abortError(input.signal);
    const current = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    if (current.agent.agent_status !== "working") {
      return {
        sent: true,
        confirmed: true,
        previousState: before.agent.agent_status,
        state: current.agent.agent_status,
        output: await readBoundedOutput(input.client, input.target, input.signal),
      };
    }
    if (Date.now() >= deadline) {
      return {
        sent: true,
        confirmed: false,
        previousState: before.agent.agent_status,
        state: current.agent.agent_status,
        output: await readBoundedOutput(input.client, input.target, input.signal),
        reason: `Interrupt key ${adapter.capabilities.interruptKeys.join("+")} was sent but the pane remained working after ${timeoutMs}ms`,
      };
    }
    await delay(Math.min(input.pollIntervalMs ?? 50, Math.max(1, deadline - Date.now())), input.signal);
  }
}
