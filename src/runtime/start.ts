import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import { revalidateLaunchFilesystemBoundary } from "../policy/capabilities.ts";
import { HerdrApiError, type AgentInfo } from "../herdr/protocol.ts";
import type { HerdrRequestClient } from "../herdr/client.ts";
import { assertPreparedHarnessLaunch, validateResolvedExecutable, type PreparedHarnessLaunch } from "../harnesses/index.ts";
import {
  abortError,
  boundRecentOutput,
  captureTurnBaseline,
  delay,
  nativeIdentityFromAgent,
  readBoundedOutput,
  resolveOwnedPaneFresh,
  RuntimeIdentityError,
  RuntimeTimeoutError,
  waitForTurnEvidence,
  type BoundedOutput,
  type OwnedRunTarget,
  type RuntimeOwnershipAuthorization,
} from "./control.ts";

export interface StartSubagentInput {
  readonly client: HerdrRequestClient;
  readonly prepared: PreparedHarnessLaunch;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly instructions: string;
  /** Must consult current active-branch journal/session state on every invocation. */
  readonly authorization: RuntimeOwnershipAuthorization;
  /** Persist the returned terminal/topology in the write-ahead journal before any later validation/await. */
  readonly recordStarted: (agent: AgentInfo) => void | Promise<void>;
  /** Persist readiness-time native identity before task submission when it was not present in agent.start. */
  readonly recordReady?: (agent: AgentInfo) => void | Promise<void>;
  /**
   * Called after readiness and before baseline capture/input mutation.
   * May wrap instructions with a result-request marker and persist generation state.
   */
  readonly prepareSubmission?: (instructions: string) => string | Promise<string>;
  readonly startupTimeoutMs?: number;
  readonly turnStartTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export type StartSubagentResult =
  | {
      readonly started: true;
      readonly submitted: true;
      readonly target: OwnedRunTarget;
      readonly agent: AgentInfo;
      readonly output: BoundedOutput;
    }
  | {
      readonly started: false;
      readonly submitted: false;
      readonly blocked: true;
      readonly reason: string;
      readonly target: OwnedRunTarget;
      readonly agent: AgentInfo;
      readonly output: BoundedOutput;
    };

export class StartCleanupError extends Error {
  constructor(
    message: string,
    readonly cleanup: "closed" | "retained" | "not-created",
    readonly cleanupReason: string,
    readonly output?: BoundedOutput,
    options?: ErrorOptions,
  ) {
    super(message, options); this.name = "StartCleanupError";
  }
}

export class TurnSubmissionUncertainError extends Error {
  constructor(message: string, readonly target: OwnedRunTarget, options?: ErrorOptions) {
    super(message, options); this.name = "TurnSubmissionUncertainError";
  }
}

function nativeRequired(prepared: PreparedHarnessLaunch): boolean {
  if (prepared.adapter.kind === "claude") return (prepared.context.integrationPolicy ?? "integrated") === "integrated";
  return true;
}

function nativeFor(agent: AgentInfo): NativeSessionIdentity | undefined {
  return nativeIdentityFromAgent(agent);
}

async function waitForReadiness(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly requireNative: boolean;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly agent: AgentInfo; readonly target: OwnedRunTarget }> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    if (input.signal?.aborted) throw abortError(input.signal);
    const resolved = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    const native = nativeFor(resolved.agent);
    const readyState = resolved.agent.agent_status === "idle" || resolved.agent.agent_status === "done" || resolved.agent.agent_status === "blocked";
    if (readyState && (!input.requireNative || native !== undefined)) {
      return {
        agent: resolved.agent,
        target: native === undefined ? input.target : { ...input.target, nativeSession: native },
      };
    }
    if (Date.now() >= deadline) throw new RuntimeTimeoutError("Initial harness readiness", input.timeoutMs);
    await delay(Math.min(input.pollIntervalMs, Math.max(1, deadline - Date.now())), input.signal);
  }
}

function rootCauseMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message && !messages.includes(current.message)) messages.push(current.message);
    current = current.cause;
  }
  if (messages.length === 0) messages.push(String(error));
  return messages.join(" <- ");
}

async function preSubmitOutput(client: HerdrRequestClient, target: OwnedRunTarget, signal?: AbortSignal): Promise<BoundedOutput | undefined> {
  try {
    const read = await client.readAgent(target.terminalId, { source: "recent_unwrapped", lines: 160, strip_ansi: true, format: "text" }, signal);
    return boundRecentOutput(read.text, read.truncated, read.revision);
  } catch { return undefined; }
}

async function cleanupPreSubmitFailure(
  client: HerdrRequestClient,
  target: OwnedRunTarget,
  signal?: AbortSignal,
): Promise<{ cleanup: "closed" | "retained"; reason: string }> {
  try {
    const before = await client.snapshot(signal);
    const pane = before.panes.find((candidate) => candidate.terminal_id === target.terminalId);
    const agent = before.agents.find((candidate) => candidate.terminal_id === target.terminalId);
    if (!pane && !agent) return { cleanup: "closed", reason: "fresh snapshot proves the started terminal already exited; no pane remained to close" };
    if (!pane) return { cleanup: "retained", reason: "fresh snapshot still reports an agent but no matching terminal pane" };
    const authorized = await target.authorization.verify({ snapshot: before, runId: target.runId, runNonce: target.runNonce, terminalId: target.terminalId, ...(target.nativeSession === undefined ? {} : { nativeSession: target.nativeSession }) });
    if (!authorized) return { cleanup: "retained", reason: "fresh active-branch/terminal authorization could not prove the remaining pane" };
    if (agent && (agent.pane_id !== pane.pane_id || agent.tab_id !== pane.tab_id || agent.workspace_id !== pane.workspace_id)) return { cleanup: "retained", reason: "remaining pane/agent topology is split; identity-safe close refused" };
    await client.closePane(pane.pane_id, signal);
    const after = await client.snapshot(signal);
    const remains = after.panes.some((candidate) => candidate.terminal_id === target.terminalId) || after.agents.some((candidate) => candidate.terminal_id === target.terminalId);
    return remains
      ? { cleanup: "retained", reason: "identity-verified pane close returned but the terminal/agent remains live" }
      : { cleanup: "closed", reason: "identity-verified remaining pane closed and fresh snapshot proves terminal/agent absence" };
  } catch (error) {
    return { cleanup: "retained", reason: `cleanup proof failed: ${rootCauseMessage(error)}` };
  }
}

export async function startSubagent(input: StartSubagentInput): Promise<StartSubagentResult> {
  assertPreparedHarnessLaunch(input.prepared);
  if (!input.instructions.trim()) throw new Error("Child instructions must be assembled before start");
  if (input.instructions.includes("\0")) throw new Error("Child instructions must not contain NUL bytes");
  if (input.prepared.launch.argv.some((argument) => argument === input.instructions)) {
    throw new Error("Delegated instructions must never be placed in argv");
  }
  await validateResolvedExecutable(input.prepared.launch.argv[0]!);
  const launchBoundary = revalidateLaunchFilesystemBoundary(input.prepared.context.policy);
  if (!launchBoundary.valid) {
    throw new StartCleanupError(`Launch filesystem revalidation failed before agent.start: ${launchBoundary.reasons.join("; ")}`, "not-created", "agent.start was never called");
  }

  let target: OwnedRunTarget | undefined;
  try {
    const started = await input.client.startAgent({
      name: input.prepared.context.sessionName,
      argv: input.prepared.launch.argv,
      workspace_id: input.workspaceId,
      tab_id: input.tabId,
      cwd: launchBoundary.cwd,
      env: input.prepared.launch.env,
      focus: false,
    }, input.signal);
    const initialNative = nativeFor(started);
    const initialTarget: OwnedRunTarget = {
      runId: input.prepared.context.metadata.runId,
      runNonce: input.prepared.context.metadata.runNonce,
      harness: input.prepared.adapter.kind,
      terminalId: started.terminal_id,
      activeBranchOwned: true,
      authorization: input.authorization,
      ...(initialNative === undefined ? {} : { nativeSession: initialNative }),
    };
    target = initialTarget;
    await input.recordStarted(started);
    if (started.workspace_id !== input.workspaceId || started.tab_id !== input.tabId) {
      throw new RuntimeIdentityError("agent.start returned a child outside the requested dedicated tab/workspace");
    }
    if (started.agent !== undefined && started.agent !== null && started.agent !== input.prepared.adapter.kind) {
      throw new RuntimeIdentityError(`agent.start returned ${started.agent}, not requested ${input.prepared.adapter.kind}`);
    }
    const readiness = await waitForReadiness({
      client: input.client,
      target: initialTarget,
      requireNative: nativeRequired(input.prepared),
      timeoutMs: input.startupTimeoutMs ?? 30_000,
      pollIntervalMs: input.pollIntervalMs ?? 50,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    target = readiness.target;
    await input.recordReady?.(readiness.agent);
    const output = await readBoundedOutput(input.client, target, input.signal);
    if (readiness.agent.agent_status === "blocked") {
      return {
        started: false,
        submitted: false,
        blocked: true,
        reason: "Harness became blocked before readiness; task was not submitted and the pane was preserved",
        target,
        agent: readiness.agent,
        output,
      };
    }
    const instructions = input.prepareSubmission
      ? await input.prepareSubmission(input.instructions)
      : input.instructions;
    if (!instructions.trim()) throw new Error("Child instructions must be assembled before start");
    if (instructions.includes("\0")) throw new Error("Child instructions must not contain NUL bytes");
    const baseline = await captureTurnBaseline(input.client, target, input.signal);
    try {
      await input.client.sendInput(readiness.agent.pane_id, instructions, ["enter"], input.signal);
    } catch (error) {
      if (error instanceof HerdrApiError) throw error;
      throw new TurnSubmissionUncertainError(
        "Task submission outcome is uncertain after pane.send_input was attempted; child retained for inspection and input must not be retried automatically",
        target,
        { cause: error },
      );
    }
    try {
      const turn = await waitForTurnEvidence({
        client: input.client,
        target,
        baseline,
        timeoutMs: input.turnStartTimeoutMs ?? 10_000,
        ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return { started: true, submitted: true, target, agent: turn.agent, output: turn.output };
    } catch (error) {
      throw new TurnSubmissionUncertainError(
        "Task was accepted but a new working cycle could not be proven; child retained for inspection and input must not be retried automatically",
        target,
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof TurnSubmissionUncertainError) throw error;
    if (target === undefined) throw new StartCleanupError(rootCauseMessage(error), "not-created", "agent.start returned no resource identity", undefined, { cause: error });
    const output = await preSubmitOutput(input.client, target, input.signal);
    const cleanup = await cleanupPreSubmitFailure(input.client, target, input.signal);
    const boundedDiagnostic = output?.text.trim();
    throw new StartCleanupError(
      `Harness failed before task submission: ${rootCauseMessage(error)}; cleanup ${cleanup.cleanup}: ${cleanup.reason}${boundedDiagnostic ? `; bounded output: ${boundedDiagnostic}` : ""}`,
      cleanup.cleanup,
      cleanup.reason,
      output,
      { cause: error },
    );
  }
}
