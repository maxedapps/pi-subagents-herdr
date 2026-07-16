import type { HerdrRequestClient } from "../herdr/client.ts";
import {
  captureTurnBaseline,
  readBoundedOutput,
  resolveOwnedPaneFresh,
  waitForTurnEvidence,
  type BoundedOutput,
  type OwnedRunTarget,
} from "./control.ts";

export interface SendSubagentResult {
  readonly sent: true;
  readonly confirmed: boolean;
  readonly state: "working" | "blocked" | "done" | "idle" | "unknown";
  readonly output: BoundedOutput;
  readonly reason?: string;
}

export async function sendToSubagent(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly message: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}): Promise<SendSubagentResult> {
  const message = input.message.trim();
  if (!message) throw new Error("Subagent message must be non-empty");
  if (message.includes("\0")) throw new Error("Subagent message must not contain NUL bytes");
  if (Buffer.byteLength(message, "utf8") > 256 * 1024) throw new Error("Subagent message exceeds the 256KB lifecycle input limit");
  const baseline = await captureTurnBaseline(input.client, input.target, input.signal);
  // Pane IDs are mutable. Resolve terminal/native/active-branch ownership again
  // immediately before the input mutation rather than reusing baseline topology.
  const resolved = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
  await input.client.sendInput(resolved.pane.pane_id, message, ["enter"], input.signal);
  try {
    const evidence = await waitForTurnEvidence({
      client: input.client,
      target: input.target,
      baseline,
      timeoutMs: input.timeoutMs ?? 10_000,
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { sent: true, confirmed: true, state: evidence.agent.agent_status, output: evidence.output };
  } catch (error) {
    const latest = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    return {
      sent: true,
      confirmed: false,
      state: latest.agent.agent_status,
      output: await readBoundedOutput(input.client, input.target, input.signal),
      reason: `Input was sent but a new turn could not be proven: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
