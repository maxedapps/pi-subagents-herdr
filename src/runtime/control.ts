import { isDeepStrictEqual } from "node:util";
import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import type { HerdrStatus } from "../contracts/state.ts";
import type { HerdrRequestClient } from "../herdr/client.ts";
import type { AgentInfo, PaneInfo, SessionSnapshot } from "../herdr/protocol.ts";
import type { DelegationGroup } from "./groups.ts";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2_000;

export interface RuntimeOwnershipAuthorization {
  /** Re-evaluate the current Pi active branch/session against this exact run and live snapshot. */
  readonly verify: (input: {
    readonly runId: string;
    readonly runNonce: string;
    readonly terminalId: string;
    readonly nativeSession?: NativeSessionIdentity;
    readonly snapshot: SessionSnapshot;
  }) => boolean | Promise<boolean>;
}

export interface OwnedRunTarget {
  readonly runId: string;
  readonly runNonce: string;
  readonly harness: "pi" | "claude" | "codex";
  readonly terminalId: string;
  readonly nativeSession?: NativeSessionIdentity;
  readonly activeBranchOwned: true;
  readonly authorization: RuntimeOwnershipAuthorization;
  readonly group?: DelegationGroup;
}

export interface ResolvedOwnedPane {
  readonly target: OwnedRunTarget;
  readonly snapshot: SessionSnapshot;
  readonly pane: PaneInfo;
  readonly agent: AgentInfo;
}

export interface BoundedOutput {
  readonly text: string;
  readonly source: "recent_unwrapped";
  readonly revision: number;
  readonly truncated: boolean;
  readonly herdrTruncated: boolean;
  readonly localTruncated: boolean;
  readonly returnedBytes: number;
  readonly returnedLines: number;
  readonly maxBytes: number;
  readonly maxLines: number;
}

export class RuntimeIdentityError extends Error {
  constructor(message: string) { super(message); this.name = "RuntimeIdentityError"; }
}

export class RuntimeTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "RuntimeTimeoutError";
  }
}

function sameNative(actual: AgentInfo["agent_session"], expected: NativeSessionIdentity): boolean {
  return actual !== undefined && actual !== null
    && actual.kind === expected.kind && actual.value === expected.value && actual.source === expected.source;
}

export async function resolveOwnedPaneFresh(
  client: HerdrRequestClient,
  target: OwnedRunTarget,
  signal?: AbortSignal,
): Promise<ResolvedOwnedPane> {
  if (target.activeBranchOwned !== true || !target.runId || !target.runNonce || !target.terminalId) {
    throw new RuntimeIdentityError("Current active-branch run/nonce/terminal ownership proof is required");
  }
  const snapshot = await client.snapshot(signal);
  const authorized = await target.authorization.verify({
    runId: target.runId,
    runNonce: target.runNonce,
    terminalId: target.terminalId,
    ...(target.nativeSession === undefined ? {} : { nativeSession: target.nativeSession }),
    snapshot,
  });
  if (!authorized) throw new RuntimeIdentityError("Current Pi active branch/session no longer authorizes this run identity");
  const pane = snapshot.panes.find((candidate) => candidate.terminal_id === target.terminalId);
  const agent = snapshot.agents.find((candidate) => candidate.terminal_id === target.terminalId);
  if (!pane || !agent) throw new RuntimeIdentityError("Owned terminal is absent or only partially represented in the live Herdr snapshot");
  if (pane.pane_id !== agent.pane_id || pane.tab_id !== agent.tab_id || pane.workspace_id !== agent.workspace_id) {
    throw new RuntimeIdentityError("Owned pane and agent topology disagree");
  }
  if (agent.agent !== undefined && agent.agent !== null && agent.agent !== target.harness) {
    throw new RuntimeIdentityError(`Owned terminal harness changed from ${target.harness} to ${agent.agent}`);
  }
  if (target.nativeSession !== undefined && !sameNative(agent.agent_session, target.nativeSession)) {
    throw new RuntimeIdentityError("Owned native session identity changed or disappeared");
  }
  return { target, snapshot, pane, agent };
}

/** Revalidate an owned journal identity after its child terminal has exited. */
export async function revalidateRecordedOwnershipFresh(
  client: HerdrRequestClient,
  target: OwnedRunTarget,
  signal?: AbortSignal,
): Promise<SessionSnapshot> {
  const snapshot = await client.snapshot(signal);
  const authorized = await target.authorization.verify({
    runId: target.runId,
    runNonce: target.runNonce,
    terminalId: target.terminalId,
    ...(target.nativeSession === undefined ? {} : { nativeSession: target.nativeSession }),
    snapshot,
  });
  if (!authorized) throw new RuntimeIdentityError("Current Pi active branch/session no longer authorizes this recorded run identity");
  return snapshot;
}

/** Terminal-preferred focus after immediate active-branch and live identity proof. */
export async function focusOwnedPaneFresh(
  client: HerdrRequestClient,
  target: OwnedRunTarget,
  signal?: AbortSignal,
): Promise<{ readonly before: ResolvedOwnedPane; readonly after?: AgentInfo }> {
  const before = await resolveOwnedPaneFresh(client, target, signal);
  await client.focusAgent(target.terminalId, signal);
  const snapshot = await client.snapshot(signal);
  const after = snapshot.agents.find((agent) => agent.terminal_id === target.terminalId);
  return { before, ...(after === undefined ? {} : { after }) };
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timer); signal!.removeEventListener("abort", onAbort); reject(abortError(signal!)); };
    function finish() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function truncateUtf8Tail(text: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text, truncated: false };
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), truncated: true };
}

export function boundRecentOutput(text: string, herdrTruncated: boolean, revision: number): BoundedOutput {
  const lines = text.split("\n");
  const lineTruncated = lines.length > MAX_OUTPUT_LINES;
  const lineBounded = lineTruncated ? lines.slice(-MAX_OUTPUT_LINES).join("\n") : text;
  const byteBounded = truncateUtf8Tail(lineBounded, MAX_OUTPUT_BYTES);
  const output = byteBounded.text;
  return {
    text: output,
    source: "recent_unwrapped",
    revision,
    truncated: herdrTruncated || lineTruncated || byteBounded.truncated,
    herdrTruncated,
    localTruncated: lineTruncated || byteBounded.truncated,
    returnedBytes: Buffer.byteLength(output, "utf8"),
    returnedLines: output.length === 0 ? 0 : output.split("\n").length,
    maxBytes: MAX_OUTPUT_BYTES,
    maxLines: MAX_OUTPUT_LINES,
  };
}

export async function readBoundedOutput(
  client: HerdrRequestClient,
  target: OwnedRunTarget,
  signal?: AbortSignal,
): Promise<BoundedOutput> {
  await resolveOwnedPaneFresh(client, target, signal);
  const read = await client.readAgent(target.terminalId, {
    source: "recent_unwrapped",
    lines: MAX_OUTPUT_LINES,
    strip_ansi: true,
    format: "text",
  }, signal);
  if (read.pane_id.length === 0) throw new RuntimeIdentityError("Herdr output omitted pane identity");
  return boundRecentOutput(read.text, read.truncated, read.revision);
}

export interface TurnBaseline {
  readonly agentRevision: number;
  readonly status: HerdrStatus;
  readonly outputRevision: number;
}

export async function captureTurnBaseline(client: HerdrRequestClient, target: OwnedRunTarget, signal?: AbortSignal): Promise<TurnBaseline> {
  const resolved = await resolveOwnedPaneFresh(client, target, signal);
  const read = await client.readAgent(target.terminalId, { source: "recent_unwrapped", lines: 20, strip_ansi: true }, signal);
  return { agentRevision: resolved.agent.revision, status: resolved.agent.agent_status, outputRevision: read.revision };
}

export function hasUnambiguousTurnEvidence(agent: AgentInfo, outputRevision: number, baseline: TurnBaseline): boolean {
  if (agent.agent_status === "working" && (agent.revision >= baseline.agentRevision || outputRevision >= baseline.outputRevision)) return true;
  return (agent.agent_status === "done" || agent.agent_status === "idle" || agent.agent_status === "blocked")
    && (agent.revision > baseline.agentRevision || outputRevision > baseline.outputRevision);
}

export async function waitForTurnEvidence(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly baseline: TurnBaseline;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly agent: AgentInfo; readonly output: BoundedOutput }> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    if (input.signal?.aborted) throw abortError(input.signal);
    const resolved = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    const read = await input.client.readAgent(input.target.terminalId, { source: "recent_unwrapped", lines: MAX_OUTPUT_LINES, strip_ansi: true }, input.signal);
    if (hasUnambiguousTurnEvidence(resolved.agent, read.revision, input.baseline)) {
      return { agent: resolved.agent, output: boundRecentOutput(read.text, read.truncated, read.revision) };
    }
    if (Date.now() >= deadline) throw new RuntimeTimeoutError("Turn-start confirmation", input.timeoutMs);
    await delay(Math.min(input.pollIntervalMs ?? 50, Math.max(1, deadline - Date.now())), input.signal);
  }
}

export function nativeIdentityFromAgent(agent: AgentInfo): NativeSessionIdentity | undefined {
  const native = agent.agent_session;
  return native === undefined || native === null ? undefined : { kind: native.kind, value: native.value, source: native.source };
}

export function sameNativeIdentity(left: NativeSessionIdentity | undefined, right: NativeSessionIdentity | undefined): boolean {
  return isDeepStrictEqual(left, right);
}
