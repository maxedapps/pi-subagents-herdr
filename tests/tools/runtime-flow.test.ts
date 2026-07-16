import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../src/contracts/protocol.ts";
import { HerdrToolRuntimeController } from "../../src/tools/service.ts";
import { startFakeHerdrServer, type FakeHerdrRequest } from "../support/fake-herdr-server.ts";

const parentNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "parent-session" };
const childNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "550e8400-e29b-41d4-a716-446655440001" };
const execFileAsync = promisify(execFile);

function fixtureApi(commands: readonly SlashCommandInfo[] = []) {
  const branch: Array<Record<string, unknown>> = [{ type: "message", id: "entry-0", parentId: null }];
  let entry = 0;
  const tools = ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name, description: name, parameters: {}, promptGuidelines: [], sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" } }));
  const api = {
    appendEntry(customType: string, data: unknown) {
      const previous = branch.at(-1)!;
      branch.push({ type: "custom", id: `custom-${++entry}`, parentId: previous.id, customType, data });
    },
    getAllTools() { return tools; },
    getCommands() { return commands; },
  } as unknown as ExtensionAPI;
  const context = (cwd: string) => ({
    cwd, mode: "tui", hasUI: true,
    isProjectTrusted: () => true,
    ui: { confirm: async () => false },
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => "/tmp/parent-session.jsonl",
      getLeafId: () => branch.at(-1)!.id as string,
      getBranch: () => branch,
    },
  }) as unknown as ExtensionContext;
  return { api, context, branch };
}

function reply(request: FakeHerdrRequest, result: JsonValue): JsonValue {
  return { id: request.id ?? "", result };
}

test("real tool runtime handles protected starts, explicit skills, bounded slots, and start → stop → start through the typed Herdr client", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p6-runtime-flow-")));
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(join(root, ".pi", "herdr-subagents"), { recursive: true });
  await mkdir(join(root, ".progress"), { recursive: true });
  await writeFile(join(root, ".progress", "existing.md"), "pre-existing untracked progress\n");
  await writeFile(join(root, ".pi", "herdr-subagents", "settings.json"), `${JSON.stringify({ concurrency: { maxRunning: 1, maxWriters: 1 } }, null, 2)}\n`);
  await writeFile(join(root, ".pi", "agents", "progress-scout.md"), `---\nname: progress-scout\ndescription: progress protection fixture\nharness: pi\npermissions: read-only\ntools: [read]\nartifacts:\n  progress: .progress/{id}.md\n---\nInspect only; do not delegate.\n`);
  await writeFile(join(root, ".pi", "agents", "skilled-scout.md"), `---\nname: skilled-scout\ndescription: reviewed skill fixture\nharness: pi\npermissions: read-only\ntools: [read]\nskills: [required-fixture]\npreferredSkills: [preferred-fixture, missing-fixture]\n---\nUse only the explicitly exposed reviewed skills.\n`);
  await writeFile(join(root, ".pi", "agents", "missing-skill-scout.md"), `---\nname: missing-skill-scout\ndescription: missing required skill fixture\nharness: pi\npermissions: read-only\ntools: [read]\nskills: [not-installed]\n---\nThis launch must be rejected before topology.\n`);
  const requiredSkill = join(root, ".pi", "skills", "required-fixture", "SKILL.md");
  const preferredSkill = join(root, ".pi", "skills", "preferred-fixture", "SKILL.md");
  await mkdir(join(root, ".pi", "skills", "required-fixture"), { recursive: true });
  await mkdir(join(root, ".pi", "skills", "preferred-fixture"), { recursive: true });
  await writeFile(requiredSkill, "---\nname: required-fixture\ndescription: required fixture\n---\nUse the required fixture.\n");
  await writeFile(preferredSkill, "---\nname: preferred-fixture\ndescription: preferred fixture\n---\nUse the preferred fixture.\n");
  const canonicalRequired = await realpath(requiredSkill);
  const canonicalPreferred = await realpath(preferredSkill);
  let groupLive = false;
  let childLive = false;
  let childStatus: "idle" | "working" | "done" | "blocked" = "idle";
  let childRevision = 1;
  let outputRevision = 1;
  let output = "ready";
  let induceSubmissionUncertain = false;
  let failNextTurnSnapshot = false;
  const parentPane = { pane_id: "w1:p1", terminal_id: "term-parent", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 1, agent: "pi", agent_session: parentNative, cwd: root };
  const parentAgent = { ...parentPane };
  const anchor = { pane_id: "w1:p2", terminal_id: "term-anchor", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "idle", revision: 1, agent: null };
  const groupTab = { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "subagents:default", focused: false, pane_count: 1, agent_status: "idle" };
  const child = () => ({ pane_id: "w1:p3", terminal_id: "term-child", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: childStatus, revision: childRevision, agent: "pi", agent_session: childNative, cwd: root });
  const snapshot = () => ({
    version: "0.7.3", protocol: 16,
    workspaces: [{ workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1 + Number(groupLive) + Number(childLive), tab_count: 1 + Number(groupLive), active_tab_id: "w1:t1", agent_status: childLive ? childStatus : "idle" }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "parent", focused: true, pane_count: 1, agent_status: "idle" },
      ...(groupLive ? [{ ...groupTab, pane_count: 1 + Number(childLive), agent_status: childLive ? childStatus : "idle" }] : []),
    ],
    panes: [parentPane, ...(groupLive ? [anchor] : []), ...(childLive ? [child()] : [])],
    layouts: [], agents: [parentAgent, ...(childLive ? [child()] : [])],
    focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1",
  });
  const server = await startFakeHerdrServer(async (request) => {
    switch (request.method) {
      case "ping": return reply(request, { type: "pong", version: "0.7.3", protocol: 16 });
      case "pane.current": return reply(request, { type: "pane_current", pane: parentPane });
      case "session.snapshot": {
        if (failNextTurnSnapshot) {
          failNextTurnSnapshot = false;
          return { id: request.id ?? "", error: { code: "unavailable", message: "turn evidence temporarily unavailable" } };
        }
        return reply(request, { type: "session_snapshot", snapshot: snapshot() });
      }
      case "events.subscribe": return reply(request, { type: "subscription_started" });
      case "tab.create": groupLive = true; return reply(request, { type: "tab_created", tab: groupTab, root_pane: anchor });
      case "pane.process_info": return reply(request, { type: "pane_process_info", process_info: { pane_id: String((request.params as Record<string, unknown>).pane_id), shell_pid: 10, tty: "/dev/ttys-test", foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["zsh"] }] } });
      case "agent.start": childLive = true; childStatus = "idle"; return reply(request, { type: "agent_started", agent: child(), argv: Array.isArray((request.params as Record<string, unknown>).argv) ? (request.params as Record<string, JsonValue>).argv as JsonValue : [] });
      case "agent.read": return reply(request, { type: "pane_read", read: { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", source: "recent_unwrapped", format: "text", text: output, revision: outputRevision, truncated: false } });
      case "pane.send_input": {
        childRevision += 1; outputRevision += 1; output += "\ntask submitted";
        if (induceSubmissionUncertain) {
          induceSubmissionUncertain = false;
          childStatus = "idle";
          failNextTurnSnapshot = true;
        } else childStatus = "working";
        return reply(request, { type: "ok" });
      }
      case "pane.send_keys": childLive = false; return reply(request, { type: "ok" });
      case "tab.close": groupLive = false; return reply(request, { type: "ok" });
      case "pane.close": childLive = false; return reply(request, { type: "ok" });
      default: throw new Error(`Unexpected method ${String(request.method)}`);
    }
  });
  const skillCommand = (name: string, path: string): SlashCommandInfo => ({ name: `skill:${name}`, description: name, source: "skill", sourceInfo: { path, source: "local", scope: "project", origin: "top-level", baseDir: join(path, "..") } });
  const fake = fixtureApi([skillCommand("required-fixture", canonicalRequired), skillCommand("preferred-fixture", canonicalPreferred)]);
  const environment = { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" };
  let runtime = new HerdrToolRuntimeController(fake.api, { environment });
  try {
    await runtime.startSession(fake.context(root));
    const topologyBefore = server.requests.filter((request) => request.method === "tab.create").length;
    await assert.rejects(runtime.start("tool-broadening", { profile: "scout", task: "Map package exports", model: "unreviewed/model" }), /trusted namespaced setting and interactive human confirmation/);
    const research = await runtime.start("tool-research-blocked", { profile: "researcher", task: "Research current API docs" });
    assert.equal(research.ok, false);
    if (!research.ok) assert.equal(research.status, "blocked");
    await assert.rejects(
      runtime.start("tool-required-skill-missing", { profile: "missing-skill-scout", task: "Do not launch" }),
      /Required Pi profile skill is unavailable.*not-installed/,
    );
    await assert.rejects(
      runtime.start("tool-progress-unprotected", { profile: "progress-scout", task: "Write progress safely" }),
      /Git-ignore protection is incomplete.*progress-ignore-confirmation-required/,
    );
    await assert.rejects(lstat(join(root, ".subagents")), /ENOENT/, "incomplete applicable protection must fail before artifact directories are written");
    assert.equal(server.requests.filter((request) => request.method === "tab.create").length, topologyBefore, "rejected/failed starts must create no topology");

    const fullAssignment = `Map every public package export to its defining source and explain any conditional export behavior.\n\n${"Preserve this detailed delegated assignment across runtime reload. ".repeat(8)}`;
    assert.equal(fullAssignment.length > 240, true);
    const started = await runtime.start("tool-start-1", { profile: "skilled-scout", task: fullAssignment });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.status, "started");
    assert.equal(started.run.ownership, "current_session");
    assert.equal(started.effective.harness, "pi");
    assert.equal(started.effective.isolatedWorktree, false);
    assert.deepEqual(started.effective.skills, ["required-fixture", "preferred-fixture"]);
    assert.equal(started.effective.skillDiagnostics.some((message) => message.includes("missing-fixture")), true);
    const launchRequest = server.requests.find((request) => request.method === "agent.start")!;
    const launchArgv = (launchRequest.params as { argv: string[] }).argv;
    assert.equal(launchArgv.includes("--no-skills"), true);
    assert.deepEqual(launchArgv.flatMap((value, index) => value === "--skill" ? [launchArgv[index + 1]!] : []), [canonicalRequired, canonicalPreferred]);

    const listed = await runtime.list({});
    assert.equal(listed.ok, true);
    if (listed.ok) assert.deepEqual(listed.runs.map((run) => run.id), [started.run.id]);
    const uiListed = await runtime.listUi({});
    assert.equal(uiListed.ok, true);
    if (uiListed.ok) assert.equal(uiListed.runs[0]?.outputRevision, outputRevision);
    const inspected = await runtime.get({ id: started.run.id, lines: 20 });
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.output.returnedLines <= 20, true); assert.equal("systemPrompt" in inspected, false);
      assert.deepEqual(Object.keys(inspected.artifacts).sort(), ["handoff", "metadata"]);
      assert.deepEqual(inspected.runtime, { ephemeralFiles: "retained", piSessionData: "retained" });
      const metadata = JSON.parse(await readFile(inspected.artifacts.metadata!, "utf8")) as { runId: string; runNonce: string; terminalId: string; assignment: string; nativeSession?: { value: string }; policy: { skills: Array<{ name: string; path: string }> }; artifacts: Record<string, string>; runtime: { ephemeralFiles: string; directory: string; systemPrompt: string; sessionDirectory: string } };
      assert.deepEqual({ runId: metadata.runId, terminalId: metadata.terminalId, native: metadata.nativeSession?.value }, { runId: started.run.id, terminalId: "term-child", native: childNative.value });
      assert.equal(metadata.assignment, fullAssignment);
      assert.deepEqual(metadata.policy.skills, [{ name: "required-fixture", path: canonicalRequired }, { name: "preferred-fixture", path: canonicalPreferred }]);
      assert.deepEqual(Object.keys(metadata.artifacts).sort(), ["handoff", "metadata"]);
      assert.equal(metadata.runtime.ephemeralFiles, "retained");
      assert.equal((await lstat(metadata.runtime.systemPrompt)).isFile(), true);
      assert.equal((await lstat(metadata.runtime.sessionDirectory)).isDirectory(), true);
    }

    childStatus = "blocked"; childRevision += 1; outputRevision += 1; output += "\nneeds clarification";
    const blocked = await runtime.wait({ id: started.run.id, states: ["blocked"], timeoutMs: 2_000 });
    assert.equal(blocked.ok, true);
    const sent = await runtime.send({ id: started.run.id, message: "Limit the map to exported symbols", timeoutMs: 2_000 });
    assert.equal(sent.ok, true);
    if (sent.ok) assert.equal((sent.result as { state: string }).state, "working");
    const abort = new AbortController(); abort.abort(new Error("parent cancelled wait"));
    await assert.rejects(runtime.wait({ id: started.run.id, states: ["done"], timeoutMs: 2_000 }, abort.signal), /parent cancelled wait/);

    childStatus = "done"; childRevision += 1; outputRevision += 1; output += "\ncompleted";
    const waited = await runtime.wait({ id: started.run.id, states: ["done"], timeoutMs: 2_000 });
    assert.equal(waited.ok, true);
    if (waited.ok) assert.equal((waited.result as { state: string }).state, "done");
    const repeatedWait = await runtime.wait({ id: started.run.id, states: ["done"], timeoutMs: 2_000 });
    assert.equal(repeatedWait.ok, true);
    const completed = await runtime.get({ id: started.run.id, lines: 20 });
    assert.equal(completed.ok, true);
    if (!completed.ok) return;
    await assert.rejects(readFile(completed.artifacts.handoff!, "utf8"), /ENOENT/, "wait/done observation must not create a partial or duplicate handoff");
    const metadataPath = completed.artifacts.metadata!;
    const beforeReloadMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as { assignment: string; output: { text: string }; runtime: Record<string, unknown> };
    assert.equal(beforeReloadMetadata.assignment, fullAssignment);
    assert.match(beforeReloadMetadata.output.text, /completed/);

    const { assignment: _removedAssignment, ...removedStateMetadata } = beforeReloadMetadata;
    await writeFile(metadataPath, `${JSON.stringify({ ...removedStateMetadata, runtime: { ephemeralFiles: "removed" } }, null, 2)}\n`);
    await runtime.stopSession();
    runtime = new HerdrToolRuntimeController(fake.api, { environment });
    await runtime.startSession(fake.context(root));
    const removedStateObserved = await runtime.list({ scope: "all_owned" });
    assert.equal(removedStateObserved.ok, true);
    if (removedStateObserved.ok) {
      const recoveredRun = removedStateObserved.runs.find((run) => run.id === started.run.id);
      assert.equal(recoveredRun?.ownership, "uncertain");
      assert.match(recoveredRun?.taskSynopsis ?? "", /requires retained run-bound ephemeral files and the full delegated assignment/);
    }
    await assert.rejects(runtime.stop({ id: started.run.id, mode: "graceful", cleanup: "retain", timeoutMs: 2_000 }), /Unknown subagent run/);
    await assert.rejects(readFile(completed.artifacts.handoff!, "utf8"), /ENOENT/, "tampered stopped-state metadata must not regain control or skip the final handoff");

    await writeFile(metadataPath, `${JSON.stringify(beforeReloadMetadata, null, 2)}\n`);
    await runtime.stopSession();
    runtime = new HerdrToolRuntimeController(fake.api, { environment });
    await runtime.startSession(fake.context(root));

    const externalPrivateDirectory = join(root, "external-private-runtime");
    await mkdir(join(externalPrivateDirectory, "sessions"), { recursive: true, mode: 0o700 });
    await chmod(externalPrivateDirectory, 0o700);
    await writeFile(join(externalPrivateDirectory, "system.md"), "must survive tampered metadata", { mode: 0o600 });
    const untamperedRuntime = beforeReloadMetadata.runtime;
    beforeReloadMetadata.runtime = { ephemeralFiles: "retained", directory: externalPrivateDirectory, systemPrompt: join(externalPrivateDirectory, "system.md"), sessionDirectory: join(externalPrivateDirectory, "sessions") };
    await writeFile(metadataPath, `${JSON.stringify(beforeReloadMetadata, null, 2)}\n`);
    await runtime.stopSession();
    runtime = new HerdrToolRuntimeController(fake.api, { environment });
    await runtime.startSession(fake.context(root));
    const observed = await runtime.list({ scope: "all_owned" });
    assert.equal(observed.ok, true);
    if (observed.ok) assert.equal(observed.runs.find((run) => run.id === started.run.id)?.ownership, "uncertain");
    await assert.rejects(runtime.stop({ id: started.run.id, mode: "graceful", cleanup: "retain", timeoutMs: 2_000 }), /Unknown subagent run/);
    assert.equal(await readFile(join(externalPrivateDirectory, "system.md"), "utf8"), "must survive tampered metadata");

    beforeReloadMetadata.runtime = untamperedRuntime;
    await writeFile(metadataPath, `${JSON.stringify(beforeReloadMetadata, null, 2)}\n`);
    await runtime.stopSession();
    runtime = new HerdrToolRuntimeController(fake.api, { environment });
    await runtime.startSession(fake.context(root));
    const recovered = await runtime.get({ id: started.run.id, lines: 20 });
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.match(recovered.output.text, /completed/);

    const beforeStop = await runtime.get({ id: started.run.id });
    assert.equal(beforeStop.ok, true);
    if (!beforeStop.ok) return;
    const liveMetadata = JSON.parse(await readFile(beforeStop.artifacts.metadata!, "utf8")) as { runtime: { systemPrompt: string; sessionDirectory: string } };
    const stopped = await runtime.stop({ id: started.run.id, mode: "graceful", cleanup: "retain", timeoutMs: 2_000 });
    assert.equal(stopped.ok, true);
    if (stopped.ok) {
      assert.equal((stopped.result as { stopped: boolean }).stopped, true);
      assert.equal(stopped.run.lifecycle, "stopped");
    }
    assert.equal(childLive, false);
    assert.equal(groupLive, false);
    const stoppedInspect = await runtime.get({ id: started.run.id });
    assert.equal(stoppedInspect.ok, true);
    if (stoppedInspect.ok) {
      assert.deepEqual(stoppedInspect.runtime, { ephemeralFiles: "removed", piSessionData: "removed" });
      const stoppedMetadata = JSON.parse(await readFile(stoppedInspect.artifacts.metadata!, "utf8")) as { assignment?: string; runtime: Record<string, unknown> };
      assert.deepEqual(stoppedMetadata.runtime, { ephemeralFiles: "removed" });
      assert.equal("assignment" in stoppedMetadata, false);
      const handoff = await readFile(stoppedInspect.artifacts.handoff!, "utf8");
      assert.match(handoff, /Map every public package export/);
      assert.match(handoff, /completed/);
      assert.deepEqual((await readdir(join(root, ".subagents", "runs", started.run.id))).sort(), ["handoff.md", "run.json"]);
    }
    await assert.rejects(lstat(liveMetadata.runtime.systemPrompt), /ENOENT/);
    await assert.rejects(lstat(liveMetadata.runtime.sessionDirectory), /ENOENT/);
    assert.equal((await readdir(join(root, ".subagents", "runs"))).some((name) => name.endsWith("-preflight") || name.includes("-validation")), false);

    for (let index = 0; index < 2; index += 1) {
      const sequential = await runtime.start(`tool-sequential-${index}`, { profile: "scout", task: `Sequential run ${index}` });
      assert.equal(sequential.ok, true, "stopped and failed historical records must not consume maxRunning slots");
      if (!sequential.ok) continue;
      childStatus = "done"; childRevision += 1;
      const sequentialStop = await runtime.stop({ id: sequential.run.id, mode: "graceful", cleanup: "retain", timeoutMs: 2_000 });
      assert.equal(sequentialStop.ok, true);
      if (sequentialStop.ok) assert.equal((sequentialStop.result as { tabClosed: boolean }).tabClosed, true);
    }
    assert.equal(server.requests.filter((request) => request.method === "tab.create").length, 3, "a freshly closed exact delegation group must be recreated for every sequential run");

    induceSubmissionUncertain = true;
    await assert.rejects(
      runtime.start("tool-submission-uncertain", { profile: "scout", task: "Retain this child when turn evidence fails" }),
      /Task was submitted atomically but a new working cycle could not be proven/,
    );
    assert.equal(childLive, true, "submission-uncertain failed child must remain retained");
    const blockedByRetained = await runtime.start("tool-after-retained-failure", { profile: "scout", task: "Must not exceed capacity" });
    assert.equal(blockedByRetained.ok, false);
    if (!blockedByRetained.ok) {
      assert.equal(blockedByRetained.status, "blocked");
      assert.match(blockedByRetained.reason, /maxRunning=1/);
    }

    childLive = false;
    const afterProvenAbsence = await runtime.start("tool-after-failed-child-absence", { profile: "scout", task: "Fresh absence should free capacity" });
    assert.equal(afterProvenAbsence.ok, true, "fresh pane+agent absence must free the retained failed slot");
    if (afterProvenAbsence.ok) {
      childStatus = "done"; childRevision += 1;
      const finalStop = await runtime.stop({ id: afterProvenAbsence.run.id, mode: "graceful", cleanup: "retain", timeoutMs: 2_000 });
      assert.equal(finalStop.ok, true);
    }
  } finally {
    await runtime.stopSession();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
