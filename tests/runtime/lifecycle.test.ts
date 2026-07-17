import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrApiError, type AgentInfo, type AgentStartInput, type PaneInfo, type PaneProcessInfo, type ReadResult, type SessionSnapshot, type TabInfo, type WorkspaceInfo } from "../../src/herdr/protocol.ts";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import { HerdrUnavailableError } from "../../src/herdr/transport.ts";
import type { EffectiveLaunchPolicy } from "../../src/contracts/harness.ts";
import type { AgentProfile } from "../../src/contracts/profile.ts";
import { assembleChildInstructions } from "../../src/harnesses/prompt.ts";
import { prepareHarnessLaunch, type PreparedHarnessLaunch } from "../../src/harnesses/index.ts";
import { boundRecentOutput, hasUnambiguousTurnEvidence, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, type OwnedRunTarget, type TurnBaseline } from "../../src/runtime/control.ts";
import { processBaseline, type DelegationGroup } from "../../src/runtime/groups.ts";
import { interruptSubagent } from "../../src/runtime/interrupt.ts";
import { sendToSubagent } from "../../src/runtime/send.ts";
import { PlacementStartExhaustedError, StartCleanupError, TurnSubmissionUncertainError, startSubagent } from "../../src/runtime/start.ts";
import { stopSubagent } from "../../src/runtime/stop.ts";
import { waitForSubagent } from "../../src/runtime/wait.ts";
import { createFakeCliFixture } from "../support/fake-cli.ts";

const workspace: WorkspaceInfo = { workspace_id: "w1", number: 1, label: "main", focused: false, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" };
const tab: TabInfo = { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "subagents:test", focused: false, pane_count: 2, agent_status: "idle" };
const anchorProcess: PaneProcessInfo = { pane_id: "w1:p0", shell_pid: 100, tty: "/dev/ttys001", foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "zsh", argv: ["zsh"] }] };
const anchor: PaneInfo = { pane_id: "w1:p0", terminal_id: "term_anchor", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle", revision: 1, agent: null };
const native = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "550e8400-e29b-41d4-a716-446655440000" };

class FakeLifecycleClient {
  readonly startCalls: AgentStartInput[] = [];
  readonly inputs: Array<{ paneId: string; text: string; keys: readonly string[] }> = [];
  readonly keyInputs: Array<{ paneId: string; keys: readonly string[] }> = [];
  readonly closedPanes: string[] = [];
  readonly closedTabs: string[] = [];
  childLive = false;
  tabLive = true;
  childTerminal = "term_child";
  childPane = "w1:p1";
  childStatus: AgentInfo["agent_status"] = "idle";
  childRevision = 1;
  outputRevision = 1;
  output = "ready";
  initialNative = true;
  interruptWorks = true;
  gracefulExitWorks = true;
  taskTransition: AgentInfo["agent_status"] = "working";
  replaceOnGraceful = false;
  exitBeforeReady = false;
  inputMutationChangesEvidence = true;
  failNextInputResponse = false;
  failNextKeysResponse = false;
  placementRejections = 0;
  startError: unknown;

  childAgent(): AgentInfo {
    return {
      terminal_id: this.childTerminal, workspace_id: "w1", tab_id: "w1:t1", pane_id: this.childPane,
      focused: false, agent_status: this.childStatus, revision: this.childRevision, agent: "pi",
      ...(this.initialNative && this.childTerminal === "term_child" ? { agent_session: native } : {}),
    };
  }
  childPaneInfo(): PaneInfo { return { ...this.childAgent(), pane_id: this.childPane }; }
  async startAgent(input: AgentStartInput): Promise<AgentInfo> {
    this.startCalls.push(input);
    if (this.placementRejections > 0) { this.placementRejections -= 1; throw new HerdrApiError(`placement-${this.startCalls.length}`, "agent_placement_not_found", "placement is not visible yet"); }
    if (this.startError !== undefined) throw this.startError;
    this.childLive = true; const started = this.childAgent(); if (this.exitBeforeReady) this.childLive = false; return started;
  }
  async snapshot(): Promise<SessionSnapshot> {
    const panes = this.tabLive ? [anchor, ...(this.childLive ? [this.childPaneInfo()] : [])] : [];
    const agents = this.childLive ? [this.childAgent()] : [];
    return { version: "0.7.3", protocol: 16, workspaces: this.tabLive ? [workspace] : [], tabs: this.tabLive ? [tab] : [], panes, layouts: [], agents };
  }
  async readAgent(_target: string, input: { source: "visible" | "recent" | "recent_unwrapped" | "detection"; format?: "text" | "ansi" }): Promise<ReadResult> {
    return { pane_id: this.childPane, workspace_id: "w1", tab_id: "w1:t1", source: input.source, format: input.format ?? "text", text: this.output, revision: this.outputRevision, truncated: false };
  }
  async sendInput(paneId: string, text: string, keys: readonly string[]): Promise<void> {
    this.inputs.push({ paneId, text, keys });
    if (text === "/exit") this.graceful();
    else if (this.inputMutationChangesEvidence) {
      this.childStatus = this.taskTransition; this.childRevision += 1; this.outputRevision += 1; this.output += `\nsubmitted:${text.slice(0, 30)}`;
    }
    if (this.failNextInputResponse) { this.failNextInputResponse = false; throw new Error("input response lost"); }
  }
  async sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
    this.keyInputs.push({ paneId, keys });
    if (keys.includes("ctrl+c") || keys.includes("escape")) {
      if (this.interruptWorks) { this.childStatus = "idle"; this.childRevision += 1; this.outputRevision += 1; this.output += "\ninterrupted-final"; }
    } else if (keys.includes("ctrl+d")) this.graceful();
    if (this.failNextKeysResponse) { this.failNextKeysResponse = false; throw new Error("keys response lost"); }
  }
  graceful(): void {
    if (this.replaceOnGraceful) { this.childTerminal = "term_replacement"; this.initialNative = false; this.childStatus = "idle"; return; }
    if (this.gracefulExitWorks) this.childLive = false;
  }
  async closePane(paneId: string): Promise<void> {
    this.closedPanes.push(paneId);
    if (this.childLive && paneId === this.childPane && this.childTerminal === "term_child") this.childLive = false;
  }
  async closeTab(tabId: string): Promise<void> { this.closedTabs.push(tabId); if (tabId === "w1:t1") this.tabLive = false; }
  async getPaneProcessInfo(paneId: string): Promise<PaneProcessInfo> { return { ...anchorProcess, pane_id: paneId }; }
}

async function preparedFixture(): Promise<{ prepared: PreparedHarnessLaunch; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p5-runtime-"))); const cwd = join(root, "checkout"); const sessions = join(root, "sessions");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(sessions, { mode: 0o700 });
  const system = join(root, "system.md"); await writeFile(system, "boundary", { mode: 0o600 }); await chmod(system, 0o600);
  const cli = await createFakeCliFixture();
  const profile: AgentProfile = { name: "scout", description: "test", body: "Inspect only.", harness: "pi", permissions: "read-only", source: { path: "/profile.md", scope: "bundled", namespace: "shared", priority: 0 } };
  const policy: EffectiveLaunchPolicy = { harness: "pi", allowedModels: [], thinking: "low", cwd, trustedRoots: [cwd], tools: [{ name: "read", capabilities: ["read"] }], permissions: { mutation: false, network: false }, requireWorktree: false, broadeningReasons: [] };
  const prepared = await prepareHarnessLaunch({ policy, profile, executable: cli.executable, sessionId: native.value, sessionName: "run-life", sessionDirectory: sessions, systemPromptPath: system, metadata: { runId: "run-life", runNonce: "nonce-life", profileName: "scout", parentSessionId: "parent-life" } });
  return { prepared, cleanup: async () => { await cli.cleanup(); await rm(root, { recursive: true, force: true }); } };
}

function instructions(prepared: PreparedHarnessLaunch): string {
  return assembleChildInstructions({ profile: prepared.context.profile, task: "Inspect package metadata", cwd: prepared.launch.cwd, runId: "run-life", parentSessionId: "parent-life", artifacts: [] });
}

const authorization = { verify: async () => true } as const;
function client(fake: FakeLifecycleClient): HerdrRequestClient { return fake as unknown as HerdrRequestClient; }
function group(): DelegationGroup { return { key: "w1\0test", workspaceId: "w1", group: "test", tabId: "w1:t1", rootPaneId: "w1:p0", rootTerminalId: "term_anchor", rootProcessBaseline: processBaseline(anchorProcess) }; }
function targetWithGroup(target: OwnedRunTarget): OwnedRunTarget { return { ...target, group: group() }; }

test("fake lifecycle starts without task argv, waits for readiness, submits atomically, and proves working", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient();
  try {
    const prompt = instructions(fx.prepared); let recorded = false;
    const result = await startSubagent({
      client: client(fake), prepared: fx.prepared, placement: group(), instructions: prompt, authorization,
      recordStarted: (agent) => { assert.equal(agent.terminal_id, "term_child"); assert.equal(fake.inputs.length, 0); recorded = true; },
      startupTimeoutMs: 100, turnStartTimeoutMs: 100, pollIntervalMs: 1,
    });
    assert.equal(recorded, true);
    assert.equal(result.started, true);
    assert.equal(fake.startCalls.length, 1);
    assert.equal(fake.startCalls[0]!.argv.some((argument) => argument.includes("Inspect package metadata")), false);
    assert.deepEqual(fake.inputs, [{ paneId: "w1:p1", text: prompt, keys: ["enter"] }]);
    assert.equal(result.agent.agent_status, "working");
    assert.deepEqual(result.target.nativeSession, { kind: "id", value: native.value, source: native.source });
  } finally { await fx.cleanup(); }
});

test("explicit placement rejection retries are bounded, revalidated, and submit exactly once", async () => {
  for (const rejections of [1, 2]) {
    const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.placementRejections = rejections;
    try {
      let recorded = 0;
      const result = await startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => { recorded += 1; }, startupTimeoutMs: 50, turnStartTimeoutMs: 50, pollIntervalMs: 1 });
      assert.equal(result.started, true); assert.equal(fake.startCalls.length, rejections + 1); assert.equal(recorded, 1); assert.equal(fake.inputs.length, 1); assert.equal(fake.childLive, true);
    } finally { await fx.cleanup(); }
  }
});

test("placement exhaustion returns a proven-no-child error after exactly three calls", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.placementRejections = 3;
  try {
    await assert.rejects(
      startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => assert.fail("rejected placement must not bind a child"), startupTimeoutMs: 50, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof PlacementStartExhaustedError && error.attempts === 3 && error.cleanup === "not-created",
    );
    assert.equal(fake.startCalls.length, 3); assert.equal(fake.childLive, false); assert.equal(fake.inputs.length, 0);
  } finally { await fx.cleanup(); }
});

test("other API and transport launch errors are never retried", async () => {
  const errors = [
    new HerdrApiError("launch-1", "invalid_params", "rejected"),
    new HerdrUnavailableError("socket disconnected"),
  ];
  for (const startError of errors) {
    const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.startError = startError;
    try {
      await assert.rejects(
        startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined }),
        (error: unknown) => error instanceof StartCleanupError && !(error instanceof PlacementStartExhaustedError),
      );
      assert.equal(fake.startCalls.length, 1); assert.equal(fake.childLive, false);
    } finally { await fx.cleanup(); }
  }
});

test("abort after an explicit placement rejection stops before retry", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); const abort = new AbortController();
  fake.startAgent = async (input) => { fake.startCalls.push(input); abort.abort(new Error("parent cancelled placement retry")); throw new HerdrApiError("placement-abort", "agent_placement_not_found", "not visible"); };
  try {
    await assert.rejects(
      startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined, signal: abort.signal }),
      /parent cancelled placement retry/,
    );
    assert.equal(fake.startCalls.length, 1); assert.equal(fake.childLive, false);
  } finally { await fx.cleanup(); }
});

test("initial send response loss is submission-uncertain and retains the child without pre-submit cleanup", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.failNextInputResponse = true;
  try {
    await assert.rejects(
      startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined, startupTimeoutMs: 50, turnStartTimeoutMs: 20, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof TurnSubmissionUncertainError && /must not be retried automatically/.test(error.message),
    );
    assert.equal(fake.childLive, true);
    assert.deepEqual(fake.closedPanes, []);
    assert.equal(fake.inputs.length, 1);
  } finally { await fx.cleanup(); }
});

test("explicit initial input rejection remains a pre-submit failure and permits proven cleanup", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient();
  fake.sendInput = async () => { throw new HerdrApiError("request-1", "invalid_params", "rejected"); };
  try {
    await assert.rejects(
      startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined, startupTimeoutMs: 50, turnStartTimeoutMs: 20, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof StartCleanupError && error.cleanup === "closed",
    );
    assert.deepEqual(fake.closedPanes, ["w1:p1"]);
  } finally { await fx.cleanup(); }
});

test("initial blocked state preserves pane and never submits the task", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.childStatus = "blocked";
  try {
    const result = await startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined, startupTimeoutMs: 50, pollIntervalMs: 1 });
    assert.equal(result.started, false); assert.equal(result.blocked, true); assert.equal(fake.inputs.length, 0); assert.equal(fake.childLive, true); assert.equal(fake.closedPanes.length, 0);
  } finally { await fx.cleanup(); }
});

test("startup timeout performs only identity-verified pre-submit cleanup", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.childStatus = "unknown"; fake.initialNative = false;
  try {
    await assert.rejects(
      startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined, startupTimeoutMs: 10, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof StartCleanupError && error.cleanup === "closed",
    );
    assert.deepEqual(fake.closedPanes, ["w1:p1"]); assert.equal(fake.inputs.length, 0);
  } finally { await fx.cleanup(); }
});

test("pre-submit harness exit reports bounded root-cause output and truthful already-gone cleanup", async () => {
  const fx = await preparedFixture(); const fake = new FakeLifecycleClient(); fake.exitBeforeReady = true; fake.output = "Invalid MCP configuration: mcpServers: expected record";
  try {
    await assert.rejects(
      startSubagent({ client: client(fake), prepared: fx.prepared, placement: group(), instructions: instructions(fx.prepared), authorization, recordStarted: () => undefined, startupTimeoutMs: 50, pollIntervalMs: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof StartCleanupError);
        assert.equal(error.cleanup, "closed");
        assert.match(error.cleanupReason, /already exited/);
        assert.match(error.output?.text ?? "", /Invalid MCP configuration/);
        assert.match(error.message, /bounded output: Invalid MCP configuration/);
        return true;
      },
    );
    assert.deepEqual(fake.closedPanes, [], "already-gone child needs no destructive cleanup call");
  } finally { await fx.cleanup(); }
});

test("turn evidence requires a state transition or strict revision advance", () => {
  const baseline: TurnBaseline = { status: "working", agentRevision: 4, outputRevision: 7 };
  const working = { ...new FakeLifecycleClient().childAgent(), agent_status: "working" as const, revision: 4 };
  assert.equal(hasUnambiguousTurnEvidence(working, 7, baseline), false);
  assert.equal(hasUnambiguousTurnEvidence({ ...working, revision: 5 }, 7, baseline), true);
  assert.equal(hasUnambiguousTurnEvidence(working, 8, baseline), true);
  assert.equal(hasUnambiguousTurnEvidence(working, 7, { ...baseline, status: "idle" }), true);
});

test("send reports confirmed, unconfirmed, and uncertain delivery without retrying", async () => {
  const target: OwnedRunTarget = { runId: "run-life", runNonce: "nonce-life", harness: "pi", terminalId: "term_child", nativeSession: { kind: native.kind, value: native.value, source: native.source }, activeBranchOwned: true, authorization };
  const confirmedFake = new FakeLifecycleClient(); confirmedFake.childLive = true;
  const sent = await sendToSubagent({ client: client(confirmedFake), target, message: "Focus on exports", timeoutMs: 50, pollIntervalMs: 1 });
  assert.equal(sent.delivery, "confirmed"); assert.equal(sent.state, "working"); assert.deepEqual(confirmedFake.inputs[0]!.keys, ["enter"]);

  const unconfirmedFake = new FakeLifecycleClient(); unconfirmedFake.childLive = true; unconfirmedFake.childStatus = "working"; unconfirmedFake.inputMutationChangesEvidence = false;
  const unconfirmed = await sendToSubagent({ client: client(unconfirmedFake), target, message: "Do not duplicate", timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(unconfirmed.delivery, "unconfirmed"); assert.equal(unconfirmedFake.inputs.length, 1);

  const uncertainFake = new FakeLifecycleClient(); uncertainFake.childLive = true; uncertainFake.failNextInputResponse = true;
  const uncertain = await sendToSubagent({ client: client(uncertainFake), target, message: "May be accepted", timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(uncertain.delivery, "uncertain"); assert.equal(uncertainFake.inputs.length, 1); assert.match(uncertain.reason ?? "", /must not be retried automatically/);

  const rejectedFake = new FakeLifecycleClient(); rejectedFake.childLive = true;
  rejectedFake.sendInput = async () => { throw new HerdrApiError("request-2", "invalid_params", "rejected"); };
  await assert.rejects(sendToSubagent({ client: client(rejectedFake), target, message: "Rejected", timeoutMs: 5, pollIntervalMs: 1 }), HerdrApiError);

  const fake = confirmedFake;
  setTimeout(() => { fake.childStatus = "done"; fake.childRevision += 1; fake.outputRevision += 1; fake.output += "\ncomplete"; }, 2);
  const waited = await waitForSubagent({ client: client(fake), target, states: ["done", "blocked"], timeoutMs: 100, pollIntervalMs: 1 });
  assert.equal(waited.state, "done"); assert.match(waited.output.text, /complete/);
});

test("adapter interrupts report confirmed, unconfirmed, and uncertain delivery", async () => {
  const target: OwnedRunTarget = { runId: "run-life", runNonce: "nonce-life", harness: "pi", terminalId: "term_child", nativeSession: { kind: native.kind, value: native.value, source: native.source }, activeBranchOwned: true, authorization };
  const confirmedFake = new FakeLifecycleClient(); confirmedFake.childLive = true; confirmedFake.childStatus = "working";
  const confirmed = await interruptSubagent({ client: client(confirmedFake), target, timeoutMs: 20, pollIntervalMs: 1 });
  assert.equal(confirmed.delivery, "confirmed"); assert.deepEqual(confirmedFake.keyInputs[0]!.keys, ["ctrl+c"]);

  const unconfirmedFake = new FakeLifecycleClient(); unconfirmedFake.childLive = true; unconfirmedFake.childStatus = "working"; unconfirmedFake.interruptWorks = false;
  const unconfirmed = await interruptSubagent({ client: client(unconfirmedFake), target, timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(unconfirmed.delivery, "unconfirmed"); assert.equal(unconfirmed.state, "working");

  const uncertainFake = new FakeLifecycleClient(); uncertainFake.childLive = true; uncertainFake.childStatus = "working"; uncertainFake.failNextKeysResponse = true;
  const uncertain = await interruptSubagent({ client: client(uncertainFake), target, timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(uncertain.delivery, "uncertain"); assert.equal(uncertain.state, "idle"); assert.equal(uncertainFake.keyInputs.length, 1);

  const rejectedFake = new FakeLifecycleClient(); rejectedFake.childLive = true; rejectedFake.childStatus = "working";
  rejectedFake.sendKeys = async () => { throw new HerdrApiError("request-3", "invalid_params", "rejected"); };
  await assert.rejects(interruptSubagent({ client: client(rejectedFake), target, timeoutMs: 5, pollIntervalMs: 1 }), HerdrApiError);
});

test("graceful stop captures fresh post-interrupt output before exiting", async () => {
  const fake = new FakeLifecycleClient(); fake.childLive = true; fake.childStatus = "working"; fake.output = "before-interrupt";
  const target: OwnedRunTarget = targetWithGroup({ runId: "run-life", runNonce: "nonce-life", harness: "pi", terminalId: "term_child", nativeSession: { kind: native.kind, value: native.value, source: native.source }, activeBranchOwned: true, authorization });
  const result = await stopSubagent({ client: client(fake), target, mode: "graceful", timeoutMs: 30, pollIntervalMs: 1 });
  assert.equal(result.stopped, true); assert.match(result.output.text, /interrupted-final/);
});

test("graceful stop exits first and closes a dedicated tab only with untouched anchor", async () => {
  const fake = new FakeLifecycleClient(); fake.childLive = true; fake.childStatus = "idle";
  const target: OwnedRunTarget = targetWithGroup({ runId: "run-life", runNonce: "nonce-life", harness: "pi", terminalId: "term_child", nativeSession: { kind: native.kind, value: native.value, source: native.source }, activeBranchOwned: true, authorization });
  const result = await stopSubagent({ client: client(fake), target, mode: "graceful", timeoutMs: 30, pollIntervalMs: 1 });
  assert.equal(result.stopped, true); assert.equal(result.forced, false); assert.equal(result.tabClosed, true);
  assert.deepEqual(fake.closedPanes, []); assert.deepEqual(fake.closedTabs, ["w1:t1"]); assert.deepEqual(fake.keyInputs[0]!.keys, ["ctrl+d"]);
});

test("graceful and force are separate; force revalidates identity and stale replacement is retained", async () => {
  const baseTarget: OwnedRunTarget = { runId: "run-life", runNonce: "nonce-life", harness: "pi", terminalId: "term_child", nativeSession: { kind: native.kind, value: native.value, source: native.source }, activeBranchOwned: true, authorization };
  const graceful = new FakeLifecycleClient(); graceful.childLive = true; graceful.gracefulExitWorks = false;
  const retained = await stopSubagent({ client: client(graceful), target: baseTarget, mode: "graceful", timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(retained.stopped, false); assert.equal(retained.forced, false); assert.deepEqual(graceful.closedPanes, []);

  const force = new FakeLifecycleClient(); force.childLive = true; force.gracefulExitWorks = false;
  const forced = await stopSubagent({ client: client(force), target: baseTarget, mode: "force", timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(forced.stopped, true); assert.equal(forced.forced, true); assert.deepEqual(force.closedPanes, ["w1:p1"]);

  const stale = new FakeLifecycleClient(); stale.childLive = true; stale.gracefulExitWorks = false; stale.replaceOnGraceful = true;
  const replacement = await stopSubagent({ client: client(stale), target: targetWithGroup(baseTarget), mode: "force", timeoutMs: 5, pollIntervalMs: 1 });
  assert.equal(replacement.stopped, true); assert.equal(replacement.forced, false); assert.equal(replacement.tabClosed, false);
  assert.deepEqual(stale.closedPanes, []); assert.deepEqual(stale.closedTabs, []); assert.equal(stale.childTerminal, "term_replacement");
});

test("control revalidates current active-branch authorization before terminal input or destruction", async () => {
  const fake = new FakeLifecycleClient(); fake.childLive = true;
  const target: OwnedRunTarget = {
    runId: "run-life", runNonce: "nonce-life", harness: "pi", terminalId: "term_child",
    nativeSession: { kind: native.kind, value: native.value, source: native.source }, activeBranchOwned: true,
    authorization: { verify: async () => false },
  };
  await assert.rejects(stopSubagent({ client: client(fake), target, mode: "force", timeoutMs: 5 }), /active branch\/session no longer authorizes/);
  assert.deepEqual(fake.keyInputs, []); assert.deepEqual(fake.inputs, []); assert.deepEqual(fake.closedPanes, []);
});

test("recent-unwrapped output is bounded by UTF-8 bytes and lines with explicit truncation metadata", () => {
  const huge = `${"🙂".repeat(20_000)}\n${Array.from({ length: 3_000 }, (_, index) => `line-${index}`).join("\n")}`;
  const output = boundRecentOutput(huge, true, 9);
  assert.equal(output.source, "recent_unwrapped"); assert.equal(output.truncated, true); assert.equal(output.herdrTruncated, true); assert.equal(output.localTruncated, true);
  assert.ok(output.returnedBytes <= MAX_OUTPUT_BYTES); assert.ok(output.returnedLines <= MAX_OUTPUT_LINES); assert.equal(output.text.includes("�"), false);
});
