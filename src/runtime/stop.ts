import type { HerdrRequestClient } from "../herdr/client.ts";
import { harnessAdapter } from "../harnesses/index.ts";
import { processBaseline } from "./groups.ts";
import {
  abortError,
  delay,
  readBoundedOutput,
  resolveOwnedPaneFresh,
  type BoundedOutput,
  type OwnedRunTarget,
} from "./control.ts";
import { interruptSubagent } from "./interrupt.ts";

export interface StopSubagentResult {
  readonly stopped: boolean;
  readonly forced: boolean;
  readonly tabClosed: boolean;
  readonly retained: boolean;
  readonly reason: string;
  readonly output: BoundedOutput;
}

async function waitForTerminalGone(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    if (input.signal?.aborted) throw abortError(input.signal);
    const snapshot = await input.client.snapshot(input.signal);
    const pane = snapshot.panes.find((candidate) => candidate.terminal_id === input.target.terminalId);
    const agent = snapshot.agents.find((candidate) => candidate.terminal_id === input.target.terminalId);
    if (!pane && !agent) return true;
    if (!pane || !agent || pane.pane_id !== agent.pane_id || pane.tab_id !== agent.tab_id || pane.workspace_id !== agent.workspace_id) return false;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(input.pollIntervalMs, Math.max(1, deadline - Date.now())), input.signal);
  }
}

async function closeDedicatedTabIfSafe(
  client: HerdrRequestClient,
  target: OwnedRunTarget,
  signal?: AbortSignal,
): Promise<{ closed: boolean; reason: string }> {
  const group = target.group;
  if (!group) return { closed: false, reason: "No dedicated group identity was supplied" };
  const snapshot = await client.snapshot(signal);
  const authorized = await target.authorization.verify({
    runId: target.runId,
    runNonce: target.runNonce,
    terminalId: target.terminalId,
    ...(target.nativeSession === undefined ? {} : { nativeSession: target.nativeSession }),
    snapshot,
  });
  if (!authorized) return { closed: false, reason: "Current active branch/session no longer authorizes dedicated-tab cleanup" };
  if (snapshot.panes.some((pane) => pane.terminal_id === target.terminalId)
    || snapshot.agents.some((agent) => agent.terminal_id === target.terminalId)) {
    return { closed: false, reason: "Child terminal still exists" };
  }
  const tab = snapshot.tabs.find((candidate) => candidate.tab_id === group.tabId);
  if (!tab || tab.workspace_id !== group.workspaceId) return { closed: false, reason: "Dedicated tab identity is absent or moved" };
  const panes = snapshot.panes.filter((candidate) => candidate.tab_id === group.tabId);
  const anchor = panes.find((candidate) => candidate.terminal_id === group.rootTerminalId);
  if (!anchor || panes.length !== 1 || anchor.workspace_id !== group.workspaceId) {
    return { closed: false, reason: "Dedicated tab contains an unknown pane or lacks the untouched anchor" };
  }
  if (snapshot.agents.some((agent) => agent.tab_id === group.tabId)) {
    return { closed: false, reason: "Dedicated tab still contains a detected agent" };
  }
  const baseline = processBaseline(await client.getPaneProcessInfo(anchor.pane_id, signal));
  if (baseline !== group.rootProcessBaseline) return { closed: false, reason: "Dedicated anchor process baseline changed" };
  await client.closeTab(group.tabId, signal);
  const finalSnapshot = await client.snapshot(signal);
  if (finalSnapshot.tabs.some((candidate) => candidate.tab_id === group.tabId)
    || finalSnapshot.panes.some((candidate) => candidate.tab_id === group.tabId)) {
    return { closed: false, reason: "tab.close returned but dedicated topology still exists" };
  }
  return { closed: true, reason: "Only the verified untouched anchor remained; dedicated tab closed" };
}

export async function stopSubagent(input: {
  readonly client: HerdrRequestClient;
  readonly target: OwnedRunTarget;
  readonly mode?: "graceful" | "force";
  readonly timeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}): Promise<StopSubagentResult> {
  const mode = input.mode ?? "graceful";
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  let resolved = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
  let output = await readBoundedOutput(input.client, input.target, input.signal);
  if (resolved.agent.agent_status === "working") {
    const interrupted = await interruptSubagent({
      client: input.client,
      target: input.target,
      timeoutMs: input.interruptTimeoutMs ?? 5_000,
      pollIntervalMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (interrupted.delivery !== "confirmed" && mode === "graceful") {
      return {
        stopped: false,
        forced: false,
        tabClosed: false,
        retained: true,
        reason: interrupted.reason ?? "Interrupt could not be confirmed; graceful stop retained the pane",
        output: interrupted.output,
      };
    }
    output = interrupted.output;
    resolved = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    if (interrupted.delivery === "confirmed") {
      output = await readBoundedOutput(input.client, input.target, input.signal);
    }
  }

  const adapter = harnessAdapter(input.target.harness);
  const action = adapter.capabilities.gracefulExit;
  if (action.kind === "keys") await input.client.sendKeys(resolved.pane.pane_id, action.keys, input.signal);
  else await input.client.sendInput(resolved.pane.pane_id, action.text, action.keys, input.signal);
  const exited = await waitForTerminalGone({
    client: input.client,
    target: input.target,
    timeoutMs: input.timeoutMs ?? 10_000,
    pollIntervalMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let forced = false;
  if (!exited) {
    if (mode === "graceful") {
      return {
        stopped: false,
        forced: false,
        tabClosed: false,
        retained: true,
        reason: "Graceful exit did not remove the identity-matched terminal within the bounded timeout; force was not implied",
        output,
      };
    }
    // Destructive boundary: resolve immutable terminal/native-session/topology again immediately before close.
    const current = await resolveOwnedPaneFresh(input.client, input.target, input.signal);
    await input.client.closePane(current.pane.pane_id, input.signal);
    forced = true;
    if (!await waitForTerminalGone({ client: input.client, target: input.target, timeoutMs: input.timeoutMs ?? 10_000, pollIntervalMs, ...(input.signal === undefined ? {} : { signal: input.signal }) })) {
      return {
        stopped: false,
        forced: true,
        tabClosed: false,
        retained: true,
        reason: "Identity-verified pane.close returned but terminal disappearance could not be proven",
        output,
      };
    }
  }
  const tab = await closeDedicatedTabIfSafe(input.client, input.target, input.signal);
  return {
    stopped: true,
    forced,
    tabClosed: tab.closed,
    retained: false,
    reason: `${forced ? "Force-closed" : "Gracefully exited"} identity-matched child. ${tab.reason}`,
    output,
  };
}
