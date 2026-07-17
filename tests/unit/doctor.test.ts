import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "../../src/contracts/protocol.ts";
import { createDoctorReport, formatDoctorReport, type DoctorProbe } from "../../src/doctor/report.ts";
import { HerdrClient } from "../../src/herdr/client.ts";
import { HerdrNdjsonTransport } from "../../src/herdr/transport.ts";
import { startFakeHerdrServer, type FakeHerdrRequest } from "../support/fake-herdr-server.ts";

function reply(request: FakeHerdrRequest, result: JsonValue): JsonValue { return { id: request.id ?? "", result }; }
const probe: DoctorProbe = {
  async exec(command, args) {
    if (command === "git") return { code: 128, stdout: "", stderr: "not a repository" };
    if (command === "herdr" && args[0] === "integration") return { code: 0, stdout: "pi: current (v4)\nclaude: current (v7)\ncodex: current (v6)\ngrok: current (v1)\n", stderr: "" };
    return { code: 0, stdout: `${command} test-version\n`, stderr: "" };
  },
};

test("doctor is truthful, read-only, and reports parent identity, optional capabilities, and observational agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "p8-doctor-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir, { recursive: true });
  const parentNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "parent-session" };
  const parent = { pane_id: "w1:p1", terminal_id: "term-parent", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 1, agent: "pi", agent_session: parentNative, cwd: root };
  const global = { pane_id: "w1:p2", terminal_id: "term-global", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "working", revision: 2, agent: "claude", cwd: root };
  const snapshot = { version: "0.7.3", protocol: 16, workspaces: [{ workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, tab_count: 2, active_tab_id: "w1:t1", agent_status: "working" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "parent", focused: true, pane_count: 1, agent_status: "idle" }, { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "other", focused: false, pane_count: 1, agent_status: "working" }], panes: [parent, global], layouts: [], agents: [parent, global] };
  const server = await startFakeHerdrServer((request) => {
    if (request.method === "ping") return reply(request, { type: "pong", version: "0.7.3", protocol: 16 });
    if (request.method === "pane.current") return reply(request, { type: "pane_current", pane: parent });
    if (request.method === "session.snapshot") return reply(request, { type: "session_snapshot", snapshot });
    throw new Error(`unexpected ${request.method}`);
  });
  const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath }));
  try {
    const report = await createDoctorReport({
      context: { cwd: root, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => undefined, getBranch: () => [] } },
      environment: { ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" },
      agentDir, activeTools: [], client, probe, now: () => new Date("2026-07-15T00:00:00.000Z"),
    });
    assert.equal(report.package.private, true);
    assert.deepEqual(report.destructiveActions, []);
    assert.equal(report.observational.some((item) => item.terminalId === "term-global"), true);
    assert.equal(report.checks.some((item) => item.id === "herdr.parent-identity" && item.status === "pass"), true);
    assert.equal(report.checks.some((item) => item.id === "capabilities.research" && item.status === "warning"), true);
    assert.match(formatDoctorReport(report), /Doctor is read-only/);
    await assert.rejects(readFile(join(root, ".subagents", "anything"), "utf8"), /ENOENT/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("doctor reports requested .progress protection and pre-existing untracked content without mutating Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "p8-doctor-progress-"));
  const agentDir = join(root, "agent");
  const profileDir = join(root, ".pi", "agents");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "progress.md"), "---\nname: progress-doctor\ndescription: progress doctor fixture\nharness: pi\npermissions: read-only\nartifacts:\n  progress: .progress/{id}.md\n---\nInspect only.\n");
  const calls: string[] = [];
  const progressProbe: DoctorProbe = {
    async exec(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args.includes("--show-toplevel")) return { code: 0, stdout: `${root}\n`, stderr: "" };
      if (command === "git" && args.includes("check-ignore")) return { code: args.some((arg) => arg.includes(".subagents")) ? 0 : 1, stdout: "", stderr: "" };
      if (command === "git" && args.includes("--others")) return { code: 0, stdout: ".progress/existing.md\n", stderr: "" };
      if (command === "git" && args.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
      if (command === "herdr" && args[0] === "integration") return { code: 0, stdout: "pi: current (v4)\nclaude: current (v7)\ncodex: current (v6)\ngrok: current (v1)\n", stderr: "" };
      return { code: command === "pi" ? 0 : 1, stdout: command === "pi" ? "0.80.6\n" : "", stderr: "unavailable" };
    },
  };
  try {
    const report = await createDoctorReport({
      context: { cwd: root, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getBranch: () => [] } },
      environment: { PATH: "" }, agentDir, activeTools: [], probe: progressProbe,
    });
    const check = report.checks.find((item) => item.id === "git.progress-ignore");
    assert.equal(check?.status, "warning");
    assert.match(check?.message ?? "", /production start will fail before artifact\/topology writes/);
    assert.deepEqual(check?.details, [".progress/existing.md"]);
    assert.equal(calls.some((call) => call.includes("ls-files --others --exclude-standard -- .progress")), true);
    assert.equal(calls.some((call) => /git .*\b(add|commit|update-index)\b/.test(call)), false, "doctor must remain read-only");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor reports malformed namespaced settings and unavailable Herdr without mutating settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "p8-doctor-invalid-")); const agentDir = join(root, "agent"); const settingsDir = join(agentDir, "herdr-subagents"); await mkdir(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json"); await writeFile(settingsPath, "{\"unknown\":true}\n"); const before = await readFile(settingsPath, "utf8");
  try {
    const report = await createDoctorReport({ context: { cwd: root, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getBranch: () => [] } }, environment: { PATH: process.env.PATH }, agentDir, activeTools: [], probe });
    assert.equal(report.summary.fail > 0, true);
    assert.equal(report.checks.some((item) => item.id === "profiles-or-settings"), true);
    assert.equal(await readFile(settingsPath, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
