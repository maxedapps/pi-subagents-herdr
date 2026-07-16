import type { HerdrStatus } from "../contracts/state.ts";
import type { HerdrRequestClient } from "../herdr/client.ts";
import {
  abortError,
  delay,
  readBoundedOutput,
  resolveOwnedPaneFresh,
  RuntimeTimeoutError,
  type BoundedOutput,
  type OwnedRunTarget,
} from "./control.ts";

const SEMANTIC_STATES = new Set<HerdrStatus>(["working", "blocked", "done", "idle", "unknown"]);

export interface WaitSubagentResult {
  readonly matched: true;
  readonly state: HerdrStatus;
  readonly output: BoundedOutput;
  readonly elapsedMs: number;
}

export async function waitForSubagent(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly states: readonly HerdrStatus[];
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}): Promise<WaitSubagentResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Wait timeout must be a positive integer");
  if (input.states.length === 0 || input.states.some((state) => !SEMANTIC_STATES.has(state))) {
    throw new Error("Wait requires at least one valid semantic Herdr state");
  }
  const wanted = new Set(input.states);
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  while (true) {
    if (input.signal?.aborted) throw abortError(input.signal);
    const resolved = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    if (wanted.has(resolved.agent.agent_status)) {
      return {
        matched: true,
        state: resolved.agent.agent_status,
        output: await readBoundedOutput(input.client, input.target, input.signal),
        elapsedMs: Date.now() - startedAt,
      };
    }
    if (Date.now() >= deadline) throw new RuntimeTimeoutError(`Wait for ${[...wanted].join("/")}`, input.timeoutMs);
    await delay(Math.min(input.pollIntervalMs ?? 100, Math.max(1, deadline - Date.now())), input.signal);
  }
}
