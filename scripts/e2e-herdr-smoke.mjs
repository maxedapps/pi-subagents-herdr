#!/usr/bin/env -S node --throw-deprecation
import "tsx/esm";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const harness = value("--harness") ?? "pi";
const confirmed = flag("--confirm-model");
const scenario = value("--scenario") ?? "completion";
const exerciseFocus = flag("--exercise-focus");
const forceCleanup = flag("--force-cleanup");
const timeoutMs = Number(value("--timeout-ms") ?? "180000");
const parentSessionId = value("--parent-session-id");
const parentSessionPath = value("--parent-session-path");
const cwd = resolve(value("--cwd") ?? process.cwd());

if (!["pi", "claude", "codex", "grok"].includes(harness)) throw new Error("--harness must be pi, claude, codex, or grok");
if (!["completion", "interrupt"].includes(scenario)) throw new Error("--scenario must be completion or interrupt");
if (!confirmed) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    modelStarted: false,
    harness,
    scenario,
    safety: [
      "No Herdr resource, model, file, setting, focus, or Git state was changed.",
      "The confirmed run creates a collision-resistant no-focus dedicated tab, uses bounded timeouts, and records identity-safe cleanup/retention.",
      "Focus is not exercised unless --exercise-focus is explicitly supplied; force cleanup is not attempted unless --force-cleanup is explicitly supplied.",
    ],
    preconditions: [
      "Run from the owning Herdr Pi pane with HERDR_ENV=1 and HERDR socket/pane/tab/workspace variables.",
      "Provide exactly one current Pi identity: --parent-session-id <id> or --parent-session-path <jsonl>.",
      `Ensure ${harness} is installed, integrated with Herdr, authenticated, and authorized to consume model quota.`,
    ],
    command: `node --throw-deprecation scripts/e2e-herdr-smoke.mjs --harness ${harness} --scenario ${scenario} --confirm-model --parent-session-path <current-pi-session.jsonl>`,
  }, null, 2)}\n`);
  process.exit(0);
}
if ((!parentSessionId && !parentSessionPath) || (parentSessionId && parentSessionPath)) throw new Error("Provide exactly one of --parent-session-id or --parent-session-path");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) throw new Error("--timeout-ms must be an integer from 10000 to 900000");
if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID || !process.env.HERDR_TAB_ID || !process.env.HERDR_WORKSPACE_ID) throw new Error("Confirmed E2E must run inside the owning Herdr pane with complete HERDR_* identity variables");

const [clientModule, harnessModule, promptModule, policyModule, groupsModule, startModule, waitModule, sendModule, interruptModule, stopModule] = await Promise.all([
  import("../src/herdr/client.ts"), import("../src/harnesses/index.ts"), import("../src/harnesses/prompt.ts"), import("../src/policy/capabilities.ts"),
  import("../src/runtime/groups.ts"), import("../src/runtime/start.ts"), import("../src/runtime/wait.ts"), import("../src/runtime/send.ts"),
  import("../src/runtime/interrupt.ts"), import("../src/runtime/stop.ts"),
]);
const { createHerdrClientFromEnvironment, preflightOwningParent } = clientModule;
const { prepareHarnessLaunch, resolveExecutable } = harnessModule;
const { assembleChildInstructions } = promptModule;
const { revalidateLaunchFilesystemBoundary } = policyModule;
const { DelegationGroupManager } = groupsModule;
const { startSubagent } = startModule;
const { waitForSubagent } = waitModule;
const { sendToSubagent } = sendModule;
const { interruptSubagent } = interruptModule;
const { stopSubagent } = stopModule;

const uuid = randomUUID();
const runId = `e2e-${harness}-${uuid.slice(0, 8)}`;
const runNonce = uuid.replaceAll("-", "");
const privateRoot = join(cwd, ".subagents", "real-e2e", runId);
const reportPath = resolve(value("--report") ?? join(cwd, ".subagents", "e2e-reports", `${runId}.json`));
const sessionDirectory = join(privateRoot, "sessions");
const systemPromptPath = join(privateRoot, "system.md");
const report = {
  schemaVersion: 1,
  runId,
  harness,
  scenario,
  startedAt: new Date().toISOString(),
  noFocus: true,
  boundedTimeoutMs: timeoutMs,
  created: [],
  checks: [],
  closed: [],
  retained: [],
  cleanup: { forceAuthorizedByOperator: forceCleanup, attempted: [] },
};
let group;
let target;
let childStopped = false;
let parentPreflight;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error(`Global E2E timeout after ${timeoutMs}ms`)), timeoutMs);
deadline.unref?.();
const client = createHerdrClientFromEnvironment(process.env);
const parentIdentity = parentSessionId ? { id: parentSessionId } : { path: parentSessionPath };

async function verifyParent() { return preflightOwningParent(client, process.env, parentIdentity, controller.signal); }
function failureDetails(error) {
  const causes = []; let current = error;
  while (current instanceof Error) { if (current.message && !causes.includes(current.message)) causes.push(current.message); current = current.cause; }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    causes,
    ...(typeof error?.cleanup === "string" ? { cleanup: error.cleanup } : {}),
    ...(typeof error?.cleanupReason === "string" ? { cleanupReason: error.cleanupReason } : {}),
    ...(error?.output ? { output: error.output } : {}),
  };
}
async function closeAnchorOnlyGroup() {
  if (!group) return;
  try {
    const snapshot = await client.snapshot(controller.signal);
    const tabStillLive = snapshot.tabs.some((tab) => tab.tab_id === group.tabId);
    const rootStillLive = snapshot.panes.some((pane) => pane.terminal_id === group.rootTerminalId);
    if (!tabStillLive && !rootStillLive) { report.closed.push({ type: "tab", tabId: group.tabId, rootTerminalId: group.rootTerminalId, alreadyClosedByChildStop: true }); group = undefined; return; }
    const verification = await new DelegationGroupManager(client).verifyAnchor(group, controller.signal);
    const panes = (await client.listPanes(group.workspaceId, controller.signal)).filter((pane) => pane.tab_id === group.tabId);
    if (!verification.verified || panes.length !== 1 || panes[0]?.terminal_id !== group.rootTerminalId) {
      report.retained.push({ type: "tab", tabId: group.tabId, rootTerminalId: group.rootTerminalId, reason: verification.verified ? "unknown/non-anchor panes remain" : verification.reason });
      return;
    }
    await client.closeTab(group.tabId, controller.signal);
    report.closed.push({ type: "tab", tabId: group.tabId, rootTerminalId: group.rootTerminalId });
    group = undefined;
  } catch (error) { report.retained.push({ type: "tab", tabId: group.tabId, rootTerminalId: group.rootTerminalId, reason: error instanceof Error ? error.message : String(error) }); }
}

try {
  // Identity, protocol, executable, and cwd are checked before any script file or topology is created.
  parentPreflight = await verifyParent();
  const executable = await resolveExecutable(harness, undefined);
  report.checks.push({ preflight: { parentTerminalId: parentPreflight.pane.terminal_id, server: `${parentPreflight.snapshot.version}/${parentPreflight.snapshot.protocol}` }, executable });
  const policy = { harness, allowedModels: [], thinking: "low", cwd, trustedRoots: [cwd], tools: [], permissions: { mutation: false, network: false }, requireWorktree: false, broadeningReasons: [] };
  const boundary = revalidateLaunchFilesystemBoundary(policy);
  if (!boundary.valid) throw new Error(boundary.reasons.join("; "));
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(systemPromptPath, "Audited real Herdr E2E child. Do only the bounded task. Never delegate, mutate files, use tools, or start another agent.", { mode: 0o600, flag: "wx" });
  await chmod(systemPromptPath, 0o600);
  const profile = { name: `e2e-${harness}`, description: "Audited real Herdr lifecycle smoke", body: "Answer directly without tools or delegation.", harness, thinking: "low", permissions: "read-only", tools: [], context: { project: false, parent: false }, worktree: "forbidden", source: { path: "<operator-real-e2e>", scope: "bundled", namespace: "shared", priority: 0 } };
  const prepared = await prepareHarnessLaunch({ policy, profile, executable, sessionId: uuid, sessionName: runId, sessionDirectory, systemPromptPath, ...(harness === "claude" ? { integrationPolicy: "integrated" } : {}), metadata: { runId, runNonce, profileName: profile.name, parentSessionId: parentSessionId ?? uuid, ...(parentSessionPath === undefined ? {} : { parentSessionPath }) } });
  const groups = new DelegationGroupManager(client);
  // DelegationGroupManager creates the dedicated tab with focus: false.
  group = await groups.ensure(parentPreflight.pane.workspace_id, runId, controller.signal);
  report.created.push({ type: "dedicated-no-focus-tab", workspaceId: group.workspaceId, tabId: group.tabId, rootPaneId: group.rootPaneId, rootTerminalId: group.rootTerminalId, rootProcessBaseline: group.rootProcessBaseline });
  const authorization = { verify: async ({ snapshot, terminalId }) => { const parent = await verifyParent(); return snapshot.protocol === 16 && parent.pane.terminal_id === parentPreflight.pane.terminal_id && terminalId.length > 0; } };
  const initialTask = scenario === "interrupt" ? "Begin a careful internal analysis of the word visibility and keep working until interrupted. Do not use tools or delegate." : `Reply with exactly: ${runId.toUpperCase()}_OK`;
  const instructions = assembleChildInstructions({ profile, task: initialTask, artifacts: [], cwd, runId, parentSessionId: parentSessionId ?? parentSessionPath });
  const started = await startSubagent({ client, prepared, workspaceId: group.workspaceId, tabId: group.tabId, instructions, authorization, recordStarted: (agent) => report.created.push({ type: "child", terminalId: agent.terminal_id, paneId: agent.pane_id, tabId: agent.tab_id, workspaceId: agent.workspace_id, nativeSession: agent.agent_session }), startupTimeoutMs: Math.min(30_000, timeoutMs), turnStartTimeoutMs: Math.min(30_000, timeoutMs), signal: controller.signal });
  target = { ...started.target, group };
  if (!started.started) throw new Error(`Harness blocked before task submission: ${started.reason}`);
  report.checks.push({ turnStarted: true, status: started.agent.agent_status, outputRevision: started.output.revision });
  if (scenario === "interrupt") {
    const interrupted = await interruptSubagent({ client, target, timeoutMs: Math.min(15_000, timeoutMs), signal: controller.signal });
    report.checks.push({ interrupt: interrupted });
    if (!interrupted.confirmed) throw new Error("Interrupt was sent but a non-working state could not be confirmed");
    const marker = `${runId.toUpperCase()}_OK`;
    const sent = await sendToSubagent({ client, target, message: `Reply with exactly: ${marker}`, timeoutMs: Math.min(30_000, timeoutMs), signal: controller.signal });
    report.checks.push({ followUp: { confirmed: sent.confirmed, state: sent.state } });
  }
  const waited = await waitForSubagent({ client, target, states: ["done", "idle", "blocked"], timeoutMs: Math.max(10_000, timeoutMs - 5_000), signal: controller.signal });
  report.checks.push({ completion: { state: waited.state, output: waited.output } });
  if (waited.state === "blocked") throw new Error("Child blocked during the bounded completion scenario");
  if (!waited.output.text.includes(`${runId.toUpperCase()}_OK`)) throw new Error("Completion output lacks the run-unique expected marker");
  const recovered = await client.snapshot(controller.signal);
  const recoveredPane = recovered.panes.find((pane) => pane.terminal_id === target.terminalId);
  const recoveredAgent = recovered.agents.find((agent) => agent.terminal_id === target.terminalId);
  if (!recoveredPane || !recoveredAgent || recoveredPane.pane_id !== recoveredAgent.pane_id) throw new Error("Fresh-snapshot recovery could not reconcile stable terminal topology");
  report.checks.push({ freshSnapshotRecovery: { terminalId: target.terminalId, paneId: recoveredPane.pane_id, nativeSession: recoveredAgent.agent_session } });
  if (exerciseFocus) {
    const before = recoveredAgent.agent_status;
    await client.focusAgent(target.terminalId, controller.signal);
    const focused = await client.getAgent(target.terminalId, controller.signal);
    report.checks.push({ focus: { explicitlyAuthorized: true, before, after: focused.agent_status } });
    await client.focusAgent(parentPreflight.pane.terminal_id, controller.signal);
  } else report.checks.push({ focus: { skipped: true, reason: "--exercise-focus was not supplied; preserve operator focus/no-focus safety" } });
  const stopped = await stopSubagent({ client, target, mode: "graceful", timeoutMs: Math.min(20_000, timeoutMs), signal: controller.signal });
  report.cleanup.attempted.push({ mode: "graceful", result: stopped });
  childStopped = stopped.stopped;
  if (!childStopped && forceCleanup) {
    const forced = await stopSubagent({ client, target, mode: "force", timeoutMs: Math.min(20_000, timeoutMs), signal: controller.signal });
    report.cleanup.attempted.push({ mode: "force", result: forced });
    childStopped = forced.stopped;
  }
  if (!childStopped) report.retained.push({ type: "child", terminalId: target.terminalId, reason: "Bounded stop did not prove exit; retained for operator inspection" });
  else report.closed.push({ type: "child", terminalId: target.terminalId });
  await closeAnchorOnlyGroup();
  report.ok = childStopped && report.retained.length === 0;
} catch (error) {
  report.ok = false;
  report.failure = failureDetails(error);
  report.error = `${report.failure.name}: ${report.failure.message}`;
  if (!target && (error?.cleanup === "closed" || error?.cleanup === "retained")) {
    const child = [...report.created].reverse().find((item) => item.type === "child");
    report.cleanup.attempted.push({ mode: "pre-submit", result: { cleanup: error.cleanup, reason: error.cleanupReason, output: error.output } });
    if (error.cleanup === "closed") {
      childStopped = true;
      if (child) report.closed.push({ type: "child", terminalId: child.terminalId, preSubmit: true, reason: error.cleanupReason });
    } else if (child) report.retained.push({ type: "child", terminalId: child.terminalId, reason: error.cleanupReason ?? "pre-submit cleanup identity remains uncertain" });
  }
  if (target && !childStopped) {
    try {
      const stopped = await stopSubagent({ client, target, mode: "graceful", timeoutMs: 10_000 });
      report.cleanup.attempted.push({ mode: "graceful-after-error", result: stopped }); childStopped = stopped.stopped;
      if (stopped.stopped) report.closed.push({ type: "child", terminalId: target.terminalId });
    } catch (cleanupError) { report.retained.push({ type: "child", terminalId: target.terminalId, reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }); }
  }
  await closeAnchorOnlyGroup();
} finally {
  clearTimeout(deadline);
  if (group && !childStopped && !report.retained.some((item) => item.type === "child")) report.retained.push({ type: "child-or-tab", tabId: group.tabId, reason: "Cleanup completion was not proven" });
  report.finishedAt = new Date().toISOString();
  report.reportPath = reportPath;
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (report.ok) await rm(privateRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (!report.ok) process.exitCode = 1;
