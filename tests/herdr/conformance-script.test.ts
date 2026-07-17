import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { startFakeHerdrServer } from "../support/fake-herdr-server.ts";
import { strictTsxArgs } from "../support/strict-node.ts";
import { pane, snapshot, success, tab } from "./fixtures.ts";

const execFileAsync = promisify(execFile);

test("operator no-model conformance script reconciles placement, starts a harmless command, and closes only exact resources", async () => {
  const createdPane = { ...pane, pane_id: "w1:p-test", terminal_id: "term_test", tab_id: "w1:t-test", focused: false, agent: null };
  const createdTab = { ...tab, tab_id: "w1:t-test", workspace_id: "w1", focused: false };
  const child = { ...pane, pane_id: "w1:p-child", terminal_id: "term_child", tab_id: "w1:t-test", workspace_id: "w1", focused: false, agent: null };
  let createdAlive = false; let childAlive = false;
  const server = await startFakeHerdrServer((request) => {
    switch (request.method) {
      case "ping": return success(request.id, { type: "pong", version: "0.7.3", protocol: 16 });
      case "session.snapshot": return success(request.id, { type: "session_snapshot", snapshot: createdAlive ? { ...snapshot, tabs: [...snapshot.tabs, createdTab], panes: [...snapshot.panes, createdPane, ...(childAlive ? [child] : [])], agents: [...snapshot.agents, ...(childAlive ? [child] : [])] } : snapshot });
      case "pane.current": return success(request.id, { type: "pane_current", pane });
      case "tab.create": createdAlive = true; return success(request.id, { type: "tab_created", tab: createdTab, root_pane: createdPane });
      case "pane.process_info": return success(request.id, { type: "pane_process_info", process_info: { pane_id: String((request.params as Record<string, unknown>).pane_id), shell_pid: 10, foreground_processes: [] } });
      case "agent.start": childAlive = true; return success(request.id, { type: "agent_started", agent: child, argv: (request.params as { argv: string[] }).argv });
      case "pane.close": childAlive = false; return success(request.id, { type: "ok" });
      case "tab.close": createdAlive = false; return success(request.id, { type: "ok" });
      default: throw new Error(`Unexpected conformance method ${request.method}`);
    }
  });
  try {
    const result = await execFileAsync(process.execPath, strictTsxArgs("scripts/conformance-herdr-no-model.ts"), { cwd: process.cwd(), timeout: 10_000, env: { ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" } });
    const report = JSON.parse(result.stdout); assert.equal(report.ok, true); assert.equal(report.retained.length, 0);
    assert.deepEqual(server.requests.filter((request) => request.method === "pane.close").map((request) => request.params), [{ pane_id: "w1:p-child" }]);
    assert.deepEqual(server.requests.filter((request) => request.method === "tab.close").map((request) => request.params), [{ tab_id: "w1:t-test" }]);
    const start = server.requests.find((request) => request.method === "agent.start")!;
    assert.deepEqual((start.params as { argv: string[] }).argv, ["/bin/sh", "-lc", "printf '__PI_HERDR_NO_MODEL_PLACEMENT__\\n'; sleep 2"]);
    assert.equal((start.params as { focus: boolean }).focus, false);
    assert.equal((server.requests.find((request) => request.method === "tab.create")?.params as any).focus, false);
  } finally { await server.close(); }
});
