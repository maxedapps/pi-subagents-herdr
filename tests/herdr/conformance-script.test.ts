import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { startFakeHerdrServer, type FakeHerdrServer } from "../support/fake-herdr-server.ts";
import { layout, pane, snapshot, success, tab } from "./fixtures.ts";

const execFileAsync = promisify(execFile);

test("operator no-model conformance script creates no-focus and closes only its returned terminal", async () => {
  const createdPane = { ...pane, pane_id: "w1:p-test", terminal_id: "term_test", tab_id: "w1:t-test", focused: false };
  const createdTab = { ...tab, tab_id: "w1:t-test", focused: false };
  let server!: FakeHerdrServer; let createdAlive = false;
  server = await startFakeHerdrServer((request) => {
    const later = (value: any) => setTimeout(() => server.broadcastSubscriptions(value), 5);
    switch (request.method) {
      case "ping": return success(request.id, { type: "pong", version: "0.7.3", protocol: 16 });
      case "session.snapshot": return success(request.id, { type: "session_snapshot", snapshot: createdAlive ? { ...snapshot, panes: [...snapshot.panes, createdPane] } : snapshot });
      case "pane.current": return success(request.id, { type: "pane_current", pane });
      case "events.subscribe": return success(request.id, { type: "subscription_started" });
      case "tab.create": createdAlive = true; later({ event: "tab_created", data: { type: "tab_created", tab: createdTab } }); later({ event: "pane_created", data: { type: "pane_created", pane: createdPane } }); return success(request.id, { type: "tab_created", tab: createdTab, root_pane: createdPane });
      case "tab.get": return success(request.id, { type: "tab_info", tab: createdTab });
      case "pane.get": return success(request.id, { type: "pane_info", pane: createdPane });
      case "pane.layout": return success(request.id, { type: "pane_layout", layout: { ...layout, tab_id: createdTab.tab_id, focused_pane_id: createdPane.pane_id } });
      case "pane.process_info": return success(request.id, { type: "pane_process_info", process_info: { pane_id: createdPane.pane_id, shell_pid: 10, foreground_processes: [] } });
      case "pane.send_input": return success(request.id, { type: "ok" });
      case "pane.close": createdAlive = false; later({ event: "pane_closed", data: { type: "pane_closed", pane_id: createdPane.pane_id, workspace_id: "w1" } }); return success(request.id, { type: "ok" });
      default: throw new Error(`Unexpected conformance method ${request.method}`);
    }
  });
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/conformance-herdr-no-model.ts"], { cwd: process.cwd(), timeout: 10_000, env: { ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" } });
    const report = JSON.parse(result.stdout); assert.equal(report.ok, true); assert.equal(report.retained.length, 0);
    assert.deepEqual(server.requests.filter((request) => request.method === "pane.close").map((request) => request.params), [{ pane_id: "w1:p-test" }]);
    assert.equal(server.requests.some((request) => request.method === "agent.start"), false);
    assert.equal((server.requests.find((request) => request.method === "tab.create")?.params as any).focus, false);
  } finally { await server.close(); }
});
