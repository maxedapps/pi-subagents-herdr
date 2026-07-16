import assert from "node:assert/strict";
import test from "node:test";
import { HerdrClient, HerdrCompatibilityError, HerdrIdentityError, preflightOwningParent } from "../../src/herdr/client.ts";
import { HerdrNdjsonTransport } from "../../src/herdr/transport.ts";
import { startFakeHerdrServer } from "../support/fake-herdr-server.ts";
import { agent, layout, pane, snapshot, success, tab, workspace } from "./fixtures.ts";

const childPane = { ...pane, pane_id: "w1:p2", terminal_id: "term_child", focused: false, agent_status: "working" as const };
const worktree = { path: "/tmp/repo-wt", branch: "herdr/run", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: "run", open_workspace_id: "w2" };
const worktreeWorkspace = { ...workspace, workspace_id: "w2", active_tab_id: "w2:t1", focused: false, worktree: { repo_key: "repo-key", repo_name: "repo", repo_root: "/tmp/repo", checkout_path: "/tmp/repo-wt", is_linked_worktree: true } };
const worktreeTab = { ...tab, workspace_id: "w2", tab_id: "w2:t1", focused: false };
const worktreePane = { ...pane, workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", terminal_id: "term-wt", focused: false };
const childAgent = { ...agent, pane_id: "w1:p2", terminal_id: "term_child", focused: false, agent_status: "working" as const, name: "worker" };
function resultFor(method: string | undefined) {
  switch (method) {
    case "ping": return { type: "pong", version: "0.7.3", protocol: 16, future: true };
    case "session.snapshot": return { type: "session_snapshot", snapshot };
    case "workspace.get": return { type: "workspace_info", workspace };
    case "workspace.list": return { type: "workspace_list", workspaces: [workspace] };
    case "tab.create": return { type: "tab_created", tab: { ...tab, tab_id: "w1:t2", focused: false }, root_pane: childPane };
    case "tab.get": return { type: "tab_info", tab };
    case "tab.list": return { type: "tab_list", tabs: [tab] };
    case "pane.current": return { type: "pane_current", pane };
    case "pane.get": return { type: "pane_info", pane };
    case "pane.list": return { type: "pane_list", panes: [pane] };
    case "pane.layout": return { type: "pane_layout", layout };
    case "pane.process_info": return { type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 42, foreground_processes: [] } };
    case "agent.start": return { type: "agent_started", agent: childAgent, argv: ["pi"] };
    case "agent.get": return { type: "agent_info", agent };
    case "agent.focus": return { type: "agent_info", agent: { ...agent, focused: true, agent_status: "idle" } };
    case "agent.list": return { type: "agent_list", agents: [agent] };
    case "agent.read": return { type: "pane_read", read: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "recent_unwrapped", format: "text", text: "output", revision: 5, truncated: false } };
    case "events.wait": return { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } } };
    case "events.subscribe": return { type: "subscription_started" };
    case "worktree.list": return { type: "worktree_list", source: { repo_key: "repo-key", repo_name: "repo", repo_root: "/tmp/repo", source_checkout_path: "/tmp/repo", source_workspace_id: "w1" }, worktrees: [worktree] };
    case "worktree.create": return { type: "worktree_created", workspace: worktreeWorkspace, tab: worktreeTab, root_pane: worktreePane, worktree };
    case "worktree.open": return { type: "worktree_opened", workspace: worktreeWorkspace, tab: worktreeTab, root_pane: worktreePane, worktree, already_open: true };
    case "worktree.remove": return { type: "worktree_removed", workspace_id: "w2", path: "/tmp/repo-wt", forced: false };
    default: return { type: "ok" };
  }
}

test("typed client emits every Phase 3 method with exact wire enum/fields", async () => {
  const server = await startFakeHerdrServer((request) => success(request.id, resultFor(request.method)));
  try {
    const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath }));
    await client.ping(); await client.snapshot(); await client.getWorkspace("w1"); await client.listWorkspaces();
    await client.createTab({ workspace_id: "w1", focus: false }); await client.getTab("w1:t1"); await client.listTabs("w1");
    await client.currentPane("w1:p1"); await client.getPane("w1:p1"); await client.listPanes("w1"); await client.getPaneLayout("w1:p1"); await client.getPaneProcessInfo("w1:p1");
    await client.startAgent({ name: "worker", argv: ["pi"], tab_id: "w1:t1", focus: false }); await client.getAgent("term_parent"); await client.listAgents();
    const read = await client.readAgent("term_parent", { source: "recent_unwrapped", lines: 20 }); assert.equal(read.source, "recent_unwrapped");
    await client.sendInput("w1:p1", "hello", ["enter"]); await client.sendKeys("w1:p1", ["ctrl+c"]);
    const focused = await client.focusAgent("term_parent"); assert.equal(focused.focused, true); assert.equal(focused.agent_status, "idle");
    await client.waitForEvent({ event: "pane_agent_status_changed", pane_id: "w1:p1", agent_status: "done" }, undefined, 100);
    const stream = await client.subscribe([{ type: "pane.moved" }, { type: "pane.agent_status_changed", pane_id: "w1:p1" }]); stream.close();
    await client.closePane("w1:p1"); await client.closeTab("w1:t1");
    await client.listWorktrees({ workspace_id: "w1" });
    await client.createWorktree({ workspace_id: "w1", branch: "herdr/run", base: "abc", path: "/tmp/repo-wt", focus: false });
    await client.openWorktree({ cwd: "/tmp/repo", branch: "herdr/run", focus: false });
    await client.removeWorktree("w2", false);
    assert.deepEqual(server.requests.map((request) => request.method), ["ping","session.snapshot","workspace.get","workspace.list","tab.create","tab.get","tab.list","pane.current","pane.get","pane.list","pane.layout","pane.process_info","agent.start","agent.get","agent.list","agent.read","pane.send_input","pane.send_keys","agent.focus","events.wait","events.subscribe","pane.close","tab.close","worktree.list","worktree.create","worktree.open","worktree.remove"]);
    assert.deepEqual(server.requests.find((request) => request.method === "agent.read")?.params, { target: "term_parent", source: "recent_unwrapped", lines: 20 });
    assert.deepEqual(server.requests.find((request) => request.method === "worktree.create")?.params, { workspace_id: "w1", branch: "herdr/run", base: "abc", path: "/tmp/repo-wt", focus: false });
    assert.deepEqual(server.requests.find((request) => request.method === "worktree.remove")?.params, { workspace_id: "w2", force: false });
  } finally { await server.close(); }
});

test("worktree client rejects ambiguous/relative/focused raw requests before transport", async () => {
  const server = await startFakeHerdrServer((request) => success(request.id, resultFor(request.method)));
  try {
    const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath }));
    await assert.rejects(client.listWorktrees({ workspace_id: "w1", cwd: "/tmp/repo" }), /exactly one/);
    await assert.rejects(client.listWorktrees({ cwd: "relative" }), /absolute/);
    await assert.rejects(client.openWorktree({ workspace_id: "w1" }), /exactly one/);
    await assert.rejects(client.openWorktree({ workspace_id: "w1", branch: "b", path: "/tmp/w" }), /exactly one/);
    await assert.rejects(client.createWorktree({ workspace_id: "w1", path: "relative" }), /absolute/);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test("compatibility and caller identity preflight fail closed without guessing focus", async () => {
  const server = await startFakeHerdrServer((request) => success(request.id, resultFor(request.method)));
  try {
    const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath }));
    const environment = { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" };
    const verified = await preflightOwningParent(client, environment, { id: "other-authoritative-id", path: "/tmp/session.jsonl" });
    assert.equal(verified.pane.terminal_id, "term_parent");
    await assert.rejects(preflightOwningParent(client, { ...environment, HERDR_SOCKET_PATH: `${server.socketPath}.other` }, { path: "/tmp/session.jsonl" }), /client socket/);
    await assert.rejects(preflightOwningParent(client, { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "wrong", HERDR_WORKSPACE_ID: "w1" }, { path: "/tmp/session.jsonl" }), HerdrIdentityError);
    await assert.rejects(preflightOwningParent(client, { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" }, { id: "guessed" }), HerdrIdentityError);
    await assert.rejects(preflightOwningParent(client, {}, {}), HerdrIdentityError);
  } finally { await server.close(); }
});

test("parent preflight rejects split pane/agent/native topology and accepts either supplied identity", async (t) => {
  const baseEnvironment = (socketPath: string) => ({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" });
  const cases = [
    { name: "agent pane mismatch", current: pane, value: { ...snapshot, agents: [{ ...agent, pane_id: "w1:other" }] } },
    { name: "agent is not native Pi", current: pane, value: { ...snapshot, agents: [{ ...agent, agent_session: { ...agent.agent_session!, agent: "claude" } }] } },
    { name: "snapshot pane native identity mismatch", current: pane, value: { ...snapshot, panes: [{ ...pane, agent_session: { ...pane.agent_session!, value: "/tmp/other.jsonl" } }] } },
    { name: "pane.current is not native Pi", current: { ...pane, agent_session: { ...pane.agent_session!, agent: "claude" } }, value: snapshot },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const server = await startFakeHerdrServer((request) => success(request.id, request.method === "ping" ? { type: "pong", version: "0.7.3", protocol: 16 } : request.method === "pane.current" ? { type: "pane_current", pane: scenario.current } : { type: "session_snapshot", snapshot: scenario.value }));
    try { const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })); await assert.rejects(preflightOwningParent(client, baseEnvironment(server.socketPath), { path: "/tmp/session.jsonl" }), HerdrIdentityError); } finally { await server.close(); }
  });

  const idNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "session-id" };
  const idPane = { ...pane, agent_session: idNative }; const idAgent = { ...agent, agent_session: idNative };
  const server = await startFakeHerdrServer((request) => success(request.id, request.method === "ping" ? { type: "pong", version: "0.7.3", protocol: 16 } : request.method === "pane.current" ? { type: "pane_current", pane: idPane } : { type: "session_snapshot", snapshot: { ...snapshot, panes: [idPane], agents: [idAgent] } }));
  try { const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })); const result = await preflightOwningParent(client, baseEnvironment(server.socketPath), { id: "session-id", path: "/wrong/path.jsonl" }); assert.equal(result.nativeSession.kind, "id"); } finally { await server.close(); }
});

test("protocol/version incompatibility reports exact server values", async () => {
  const server = await startFakeHerdrServer((request) => success(request.id, { type: "pong", version: "0.7.2", protocol: 15 }));
  try { const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath: server.socketPath })); await assert.rejects(client.assertCompatible(), (error: unknown) => error instanceof HerdrCompatibilityError && error.serverVersion === "0.7.2" && error.serverProtocol === 15); } finally { await server.close(); }
});
