import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HERDR_EVENT_NAMES, HERDR_SUBSCRIPTION_EVENT_NAMES, USED_HERDR_METHOD_RESULTS, USED_HERDR_RESULT_TYPES,
  decodeEvent, decodeResponseEnvelope, decodeResult, decodeSnapshot, expectResult, type UsedHerdrResultType,
} from "../../src/herdr/protocol.ts";
import { agent, layout, pane, snapshot, tab, workspace } from "./fixtures.ts";

const fixturePath = new URL("../fixtures/herdr-protocol-16.schema.json", import.meta.url);
const methodResultsPath = new URL("../fixtures/herdr-protocol-16.method-results.json", import.meta.url);

function assertSchemaFragment(root: any, section: string, value: any, label: string, seen = new Set<string>()): void {
  assert.equal(typeof value, "object", `${label} must be a schema object`);
  assert.notEqual(value, null, `${label} must be a schema object`);
  if (typeof value.$ref === "string") {
    const prefix = `#/schemas/${section}/$defs/`;
    assert.equal(value.$ref.startsWith(prefix), true, `${label} has an unexpected reference ${value.$ref}`);
    const name = value.$ref.slice(prefix.length);
    assert.equal(Object.hasOwn(root.$defs ?? {}, name), true, `${label} references missing ${name}`);
    if (!seen.has(name)) {
      seen.add(name);
      assertSchemaFragment(root, section, root.$defs[name], `${label} -> ${name}`, seen);
    }
    return;
  }
  if (value.type === "object" || value.properties !== undefined) {
    const properties = value.properties ?? {};
    assert.equal(typeof properties, "object", `${label}.properties must be an object`);
    for (const required of value.required ?? []) {
      assert.equal(Object.hasOwn(properties, required), true, `${label} requires missing property ${required}`);
    }
  }
  if (value.properties && typeof value.properties === "object") {
    for (const [name, schema] of Object.entries(value.properties)) assertSchemaFragment(root, section, schema, `${label}.properties.${name}`, seen);
  }
  if (value.additionalProperties && typeof value.additionalProperties === "object") assertSchemaFragment(root, section, value.additionalProperties, `${label}.additionalProperties`, seen);
  if (value.items && typeof value.items === "object") assertSchemaFragment(root, section, value.items, `${label}.items`, seen);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(value[key])) value[key].forEach((schema: any, index: number) => assertSchemaFragment(root, section, schema, `${label}.${key}[${index}]`, seen));
  }
}

function assertDiscriminatedVariant(root: any, section: string, variant: any, discriminator: "method" | "type", expected: string): void {
  assert.equal(variant.type, "object", `${section} ${expected} must be an object variant`);
  assert.equal(variant.properties?.[discriminator]?.const, expected, `${section} ${expected} discriminator`);
  assert.equal(variant.required?.includes(discriminator), true, `${section} ${expected} must require ${discriminator}`);
  assertSchemaFragment(root, section, variant, `${section} ${expected}`);
}

test("protocol 16 fixture binds every used method, result, event, and nested decoder definition", async (t) => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as any;
  assert.deepEqual({ version: fixture.source.herdr_version, protocol: fixture.source.protocol, bytes: fixture.source.raw_bytes, sha: fixture.source.raw_sha256 }, { version: "0.7.3", protocol: 16, bytes: 223527, sha: "7d1eede56d8009fe5b1b2f76e9cedf50b730124cec821fdc3b68ca07cd545f83" });
  assert.deepEqual(Object.keys(fixture.request.methods).sort(), Object.keys(USED_HERDR_METHOD_RESULTS).sort());
  assert.deepEqual(Object.keys(fixture.success_response.result_types).sort(), [...USED_HERDR_RESULT_TYPES].sort());
  assert.deepEqual(Object.keys(fixture.event.event_types).sort(), [...HERDR_EVENT_NAMES].sort());
  assert.deepEqual(fixture.subscription_event.$defs.SubscriptionEventKind.enum, HERDR_SUBSCRIPTION_EVENT_NAMES);
  assert.deepEqual(fixture.request.definitions.ReadSource.enum, ["visible", "recent", "recent_unwrapped", "detection"]);
  assert.deepEqual(fixture.success_response.definitions.PaneLayoutRect.required, ["x", "y", "width", "height"]);
  assert.deepEqual(fixture.success_response.definitions.PaneLayoutPane.required, ["pane_id", "focused", "rect"]);
  assert.deepEqual(fixture.success_response.definitions.PaneLayoutSplit.required, ["id", "direction", "ratio", "rect"]);
  assert.deepEqual(fixture.success_response.definitions.PaneProcessInfoProcess.required, ["pid", "name"]);
  assert.deepEqual(fixture.success_response.definitions.AgentSessionInfo.required, ["source", "agent", "kind", "value"]);
  assert.deepEqual(fixture.request.methods["worktree.create"].properties.params.$ref, "#/schemas/request/$defs/WorktreeCreateParams");
  assert.deepEqual(fixture.request.definitions.WorktreeRemoveParams.required, ["workspace_id"]);
  assert.deepEqual(fixture.success_response.result_types.worktree_created.required, ["type", "workspace", "tab", "root_pane", "worktree"]);
  assert.deepEqual(fixture.success_response.definitions.WorktreeInfo.required, ["path", "is_bare", "is_detached", "is_prunable", "is_linked_worktree", "label"]);
  assert.ok(JSON.stringify(fixture.request.definitions.Subscription).includes("worktree.created"));
  let raw: string;
  let installedVersion: string;
  try {
    raw = execFileSync("herdr", ["api", "schema", "--json"], { encoding: "utf8", maxBuffer: 2_000_000 });
    installedVersion = execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim().replace(/^herdr\s+/, "");
  } catch {
    t.diagnostic("installed Herdr CLI unavailable; pinned fixture integrity and decoder binding still ran");
    return;
  }
  const live = JSON.parse(raw) as any;
  assert.equal(live.protocol, 16);
  const liveMethods = new Map(live.schemas.request.oneOf.map((item: any) => [item.properties?.method?.const, item]));
  const liveResults = new Map(live.schemas.success_response.$defs.ResponseResult.oneOf.map((item: any) => [item.properties?.type?.const, item]));
  const liveEvents = new Map(live.schemas.event.$defs.EventData.oneOf.map((item: any) => [item.properties?.type?.const, item]));
  for (const method of Object.keys(USED_HERDR_METHOD_RESULTS)) {
    assert.equal(liveMethods.has(method), true, `live method ${method}`);
    assertDiscriminatedVariant(live.schemas.request, "request", liveMethods.get(method), "method", method);
  }
  for (const resultType of USED_HERDR_RESULT_TYPES) {
    assert.equal(liveResults.has(resultType), true, `live result ${resultType}`);
    assertDiscriminatedVariant(live.schemas.success_response, "success_response", liveResults.get(resultType), "type", resultType);
  }
  for (const eventName of HERDR_EVENT_NAMES) {
    assert.equal(liveEvents.has(eventName), true, `live event ${eventName}`);
    assertDiscriminatedVariant(live.schemas.event, "event", liveEvents.get(eventName), "type", eventName);
  }
  if (installedVersion === fixture.source.herdr_version) {
    assert.equal(Buffer.byteLength(raw), fixture.source.raw_bytes);
    assert.equal(createHash("sha256").update(raw).digest("hex"), fixture.source.raw_sha256);
  } else {
    t.diagnostic(`installed Herdr ${installedVersion} shares protocol 16 but differs from pinned ${fixture.source.herdr_version}; structural conformance replaced byte identity`);
  }
});

test("tagged Herdr behavior fixture binds each used method to its actual success result", async () => {
  const behavior = JSON.parse(await readFile(methodResultsPath, "utf8")) as { source: { herdr_version: string; commit: string }; associations: Record<string, string> };
  assert.equal(behavior.source.herdr_version, "0.7.4");
  assert.equal(behavior.source.commit, "50aaa2ec046ee26ff407c20f49de496f522512a8");
  assert.deepEqual(USED_HERDR_METHOD_RESULTS, behavior.associations);
  assert.equal(behavior.associations["agent.focus"], "agent_info");
});

test("protocol decoders preserve unknown fields and done versus idle", () => {
  const value = { ...snapshot, panes: [{ ...snapshot.panes[0]!, agent_status: "done", future: { value: 1 } }], agents: [{ ...snapshot.agents[0]!, agent_status: "idle" }], future_top: true };
  const decoded = decodeSnapshot(value);
  assert.equal(decoded.panes[0]!.agent_status, "done"); assert.equal(decoded.agents[0]!.agent_status, "idle");
  assert.deepEqual(decoded.panes[0]!.future, { value: 1 }); assert.equal(decoded.future_top, true);
});

const read = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "recent_unwrapped", format: "text", text: "output", revision: 5, truncated: false };
const processInfo = { pane_id: "w1:p1", shell_pid: 42, tty: "/dev/tty", foreground_process_group_id: 42, foreground_processes: [{ pid: 42, name: "pi", argv: ["pi", "-p"], argv0: "pi", cmdline: "pi -p", cwd: "/tmp" }] };
const worktreeSource = { repo_key: "repo-key", repo_name: "repo", repo_root: "/repo", source_checkout_path: "/repo", source_workspace_id: "w1" };
const worktree = { path: "/repo-wt", branch: "herdr/run", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: "run", open_workspace_id: "w2" };
const worktreeWorkspace = { ...workspace, workspace_id: "w2", active_tab_id: "w2:t1", focused: false, worktree: { repo_key: "repo-key", repo_name: "repo", repo_root: "/repo", checkout_path: "/repo-wt", is_linked_worktree: true } };
const worktreeTab = { ...tab, workspace_id: "w2", tab_id: "w2:t1", focused: false };
const worktreePane = { ...pane, workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", terminal_id: "term-wt", focused: false };
const resultSamples: Record<UsedHerdrResultType, Record<string, unknown>> = {
  pong: { type: "pong", version: "0.7.3", protocol: 16, capabilities: { live_handoff: true, detached_server_daemon: false } },
  session_snapshot: { type: "session_snapshot", snapshot }, workspace_info: { type: "workspace_info", workspace }, workspace_list: { type: "workspace_list", workspaces: [workspace] },
  tab_created: { type: "tab_created", tab, root_pane: pane }, tab_info: { type: "tab_info", tab }, tab_list: { type: "tab_list", tabs: [tab] },
  pane_current: { type: "pane_current", pane }, pane_info: { type: "pane_info", pane }, pane_list: { type: "pane_list", panes: [pane] }, pane_layout: { type: "pane_layout", layout }, pane_process_info: { type: "pane_process_info", process_info: processInfo },
  agent_started: { type: "agent_started", agent, argv: ["pi"] }, agent_info: { type: "agent_info", agent }, agent_list: { type: "agent_list", agents: [agent] }, pane_read: { type: "pane_read", read },
  subscription_started: { type: "subscription_started" }, wait_matched: { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" } } }, ok: { type: "ok" },
  worktree_list: { type: "worktree_list", source: worktreeSource, worktrees: [worktree] },
  worktree_created: { type: "worktree_created", workspace: worktreeWorkspace, tab: worktreeTab, root_pane: worktreePane, worktree },
  worktree_opened: { type: "worktree_opened", workspace: worktreeWorkspace, tab: worktreeTab, root_pane: worktreePane, worktree, already_open: false },
  worktree_removed: { type: "worktree_removed", workspace_id: "w2", path: "/repo-wt", forced: false },
};
const requiredResultField: Record<UsedHerdrResultType, string> = {
  pong: "version", session_snapshot: "snapshot", workspace_info: "workspace", workspace_list: "workspaces", tab_created: "root_pane", tab_info: "tab", tab_list: "tabs",
  pane_current: "pane", pane_info: "pane", pane_list: "panes", pane_layout: "layout", pane_process_info: "process_info", agent_started: "argv", agent_info: "agent", agent_list: "agents", pane_read: "read", subscription_started: "type", wait_matched: "event", ok: "type",
  worktree_list: "source", worktree_created: "root_pane", worktree_opened: "already_open", worktree_removed: "path",
};

test("every used result decoder rejects a malformed schema-required field", () => {
  for (const type of USED_HERDR_RESULT_TYPES) {
    assert.doesNotThrow(() => decodeResult(resultSamples[type], type), type);
    const malformed = structuredClone(resultSamples[type]); delete malformed[requiredResultField[type]];
    assert.throws(() => decodeResult(malformed, type));
  }
});

test("nested layout, process, worktree, scroll, and agent-session wire drift fails closed", () => {
  const badLayoutPane = structuredClone(snapshot) as any; badLayoutPane.layouts[0].panes[0].rect.height = "24"; assert.throws(() => decodeSnapshot(badLayoutPane), /height/);
  const badSplit = structuredClone(snapshot) as any; badSplit.layouts[0].splits[0].direction = "left"; assert.throws(() => decodeSnapshot(badSplit), /direction/);
  const badArea = structuredClone(snapshot) as any; badArea.layouts[0].area.width = 70_000; assert.throws(() => decodeSnapshot(badArea), /width/);
  const badProcess = structuredClone(resultSamples.pane_process_info) as any; badProcess.process_info.foreground_processes[0].pid = "42"; assert.throws(() => decodeResult(badProcess, "pane_process_info"), /pid/);
  const badWorktree = structuredClone(resultSamples.workspace_info) as any; badWorktree.workspace.worktree = { repo_name: "repo", repo_root: "/r", checkout_path: "/r", is_linked_worktree: false }; assert.throws(() => decodeResult(badWorktree, "workspace_info"), /repo_key/);
  const badScroll = structuredClone(resultSamples.pane_info) as any; badScroll.pane.scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0 }; assert.throws(() => decodeResult(badScroll, "pane_info"), /viewport_rows/);
  const badSession = structuredClone(resultSamples.agent_info) as any; badSession.agent.agent_session.kind = "token"; assert.throws(() => decodeResult(badSession, "agent_info"), /kind/);
  const badDetectionFlag = structuredClone(resultSamples.agent_info) as any; badDetectionFlag.agent.screen_detection_skipped = null; assert.throws(() => decodeResult(badDetectionFlag, "agent_info"), /screen_detection_skipped/);
  const badWorktreeResult = structuredClone(resultSamples.worktree_created) as any; delete badWorktreeResult.worktree.is_linked_worktree; assert.throws(() => decodeResult(badWorktreeResult, "worktree_created"), /is_linked_worktree/);
  const badWorktreeSource = structuredClone(resultSamples.worktree_list) as any; delete badWorktreeSource.source.source_checkout_path; assert.throws(() => decodeResult(badWorktreeSource, "worktree_list"), /source_checkout_path/);
});

const movedPane = { ...pane, pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t2" };
const movedWorkspace = { ...workspace, workspace_id: "w2", active_tab_id: "w2:t2" };
const movedTab = { ...tab, workspace_id: "w2", tab_id: "w2:t2" };
const eventSamples: Record<string, Record<string, unknown>> = {
  workspace_created: { event: "workspace_created", data: { type: "workspace_created", workspace } },
  workspace_updated: { event: "workspace_updated", data: { type: "workspace_updated", workspace } },
  workspace_closed: { event: "workspace_closed", data: { type: "workspace_closed", workspace_id: "w1", workspace } },
  workspace_focused: { event: "workspace_focused", data: { type: "workspace_focused", workspace_id: "w1" } },
  tab_created: { event: "tab_created", data: { type: "tab_created", tab } }, tab_closed: { event: "tab_closed", data: { type: "tab_closed", tab_id: "w1:t1", workspace_id: "w1" } }, tab_focused: { event: "tab_focused", data: { type: "tab_focused", tab_id: "w1:t1", workspace_id: "w1" } },
  pane_created: { event: "pane_created", data: { type: "pane_created", pane } }, pane_closed: { event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p1", workspace_id: "w1" } }, pane_focused: { event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1", workspace_id: "w1" } },
  pane_moved: { event: "pane_moved", data: { type: "pane_moved", previous_pane_id: "w1:p1", previous_workspace_id: "w1", previous_tab_id: "w1:t1", pane: movedPane, created_workspace: movedWorkspace, created_tab: movedTab, closed_workspace_id: "w1", closed_tab_id: "w1:t1" } },
  pane_exited: { event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p1", workspace_id: "w1" } },
  pane_agent_status_changed: { event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked", state_labels: { reason: "approval" } } },
  layout_updated: { event: "layout_updated", data: { type: "layout_updated", layout } },
  "pane.agent_status_changed": { event: "pane.agent_status_changed", data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done", state_labels: { turn: "complete" } } },
  "pane.output_matched": { event: "pane.output_matched", data: { pane_id: "w1:p1", workspace_id: "w1", matched_line: "done", read } },
  "pane.scroll_changed": { event: "pane.scroll_changed", data: { pane_id: "w1:p1", workspace_id: "w1", scroll: { offset_from_bottom: 0, max_offset_from_bottom: 5, viewport_rows: 24 } } },
  worktree_created: { event: "worktree_created", data: { type: "worktree_created", workspace: worktreeWorkspace, worktree } },
  worktree_opened: { event: "worktree_opened", data: { type: "worktree_opened", workspace: worktreeWorkspace, worktree, already_open: true } },
  worktree_removed: { event: "worktree_removed", data: { type: "worktree_removed", workspace_id: "w2", workspace: null, worktree, forced: false } },
};

test("every used lifecycle and subscription event rejects malformed wire data", () => {
  const names = [...HERDR_EVENT_NAMES, ...HERDR_SUBSCRIPTION_EVENT_NAMES];
  for (const name of names) {
    assert.doesNotThrow(() => decodeEvent(eventSamples[name]), name);
    const malformed = structuredClone(eventSamples[name]) as any;
    if (name === "pane_moved") malformed.data.created_tab.pane_count = "one";
    else if (name === "layout_updated") malformed.data.layout.panes[0].rect.x = -1;
    else if (name === "pane.output_matched") delete malformed.data.read.text;
    else if (name === "pane.scroll_changed") delete malformed.data.scroll.viewport_rows;
    else if (name === "workspace_created" || name === "workspace_updated") malformed.data.workspace.number = -1;
    else if (name === "tab_created") malformed.data.tab.pane_count = "one";
    else if (name === "pane_created") malformed.data.pane.revision = -1;
    else if (name === "pane_agent_status_changed" || name === "pane.agent_status_changed") malformed.data.agent_status = "ready";
    else if (name === "worktree_created") delete malformed.data.worktree.path;
    else if (name === "worktree_opened") delete malformed.data.already_open;
    else if (name === "worktree_removed") delete malformed.data.forced;
    else delete malformed.data.workspace_id;
    let rejected = false; try { decodeEvent(malformed); } catch { rejected = true; } assert.equal(rejected, true, name);
  }
});

test("exact success/error envelopes preserve unknowns and fail closed", () => {
  const success = decodeResponseEnvelope({ id: "r1", result: { type: "ok", future: 1 } }, "r1"); assert.equal(expectResult(success, "ok").future, 1);
  const failure = decodeResponseEnvelope({ id: "r2", error: { code: "not_found", message: "pane not found", future: true } }, "r2"); assert.throws(() => expectResult(failure, "ok"), /not_found/);
  assert.throws(() => decodeResponseEnvelope({ id: "x", result: {}, error: {} }), /exactly one/); assert.throws(() => decodeResponseEnvelope({ id: "other", result: {} }, "wanted"), /mismatch/);
  assert.throws(() => decodeEvent({ event: "pane.moved", data: {} }), /Unsupported/);
});
