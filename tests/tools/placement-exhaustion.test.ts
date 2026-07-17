import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../src/contracts/protocol.ts";
import { FAILURE_EVIDENCE_CUSTOM_TYPE } from "../../src/results/failure-evidence.ts";
import { HerdrToolRuntimeController } from "../../src/tools/service.ts";
import { startFakeHerdrServer, type FakeHerdrRequest } from "../support/fake-herdr-server.ts";

const execFileAsync = promisify(execFile);
const parentNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "parent-session" };

function reply(request: FakeHerdrRequest, result: JsonValue): JsonValue { return { id: request.id ?? "", result }; }

function fixtureApi() {
  const branch: Array<Record<string, unknown>> = [{ type: "message", id: "entry-0", parentId: null, message: { role: "user", content: "start" } }];
  let entry = 0;
  const tools = ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name, description: name, parameters: {}, promptGuidelines: [], sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" } }));
  const api = {
    appendEntry(customType: string, data: unknown) {
      const previous = branch.at(-1)!;
      branch.push({ type: "custom", id: `custom-${++entry}`, parentId: previous.id, customType, data });
    },
    getAllTools() { return tools; },
    sendMessage(message: unknown) {
      const previous = branch.at(-1)!;
      branch.push({ type: "message", id: `message-${++entry}`, parentId: previous.id, message });
    },
  } as unknown as ExtensionAPI;
  const context = (cwd: string) => ({
    cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true,
    ui: { confirm: async () => false },
    sessionManager: {
      getSessionId: () => "parent-session", getSessionFile: () => "/tmp/parent-session.jsonl",
      getLeafId: () => branch.at(-1)!.id as string, getBranch: () => branch,
    },
  }) as unknown as ExtensionContext;
  return { api, context, branch };
}

test("writer placement exhaustion returns exact resources and ordinary stop removes zero-change residue", async () => {
  const container = await mkdtemp(join(tmpdir(), "pi-placement-writer-"));
  const root = join(container, "repo");
  await mkdir(root);
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);

  const parentPane = { pane_id: "w1:p1", terminal_id: "term-parent", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 1, agent: "pi", agent_session: parentNative, cwd: root };
  const parentTab = { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "parent", focused: true, pane_count: 1, agent_status: "idle" };
  const parentWorkspace = { workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" };
  let writerLive = false; let writerPath = ""; let writerBranch = ""; let writerBase = ""; let placementCalls = 0;
  const writerWorkspace = () => ({ workspace_id: "w2", number: 2, label: "writer", focused: false, pane_count: 2, tab_count: 2, active_tab_id: "w2:t1", agent_status: "idle", worktree: { repo_key: "repo-key", repo_name: "repo", repo_root: root, checkout_path: writerPath, is_linked_worktree: true } });
  const createdTab = { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "writer-root", focused: false, pane_count: 1, agent_status: "idle" };
  const createdRoot = { pane_id: "w2:p1", terminal_id: "term-writer-root", workspace_id: "w2", tab_id: "w2:t1", focused: false, agent_status: "idle", revision: 1, agent: null };
  const groupTab = { tab_id: "w2:t2", workspace_id: "w2", number: 2, label: "subagents:default", focused: false, pane_count: 1, agent_status: "idle" };
  const groupRoot = { pane_id: "w2:p2", terminal_id: "term-writer-group", workspace_id: "w2", tab_id: "w2:t2", focused: false, agent_status: "idle", revision: 1, agent: null };
  const snapshot = () => ({
    version: "0.7.3", protocol: 16,
    workspaces: [parentWorkspace, ...(writerLive ? [writerWorkspace()] : [])],
    tabs: [parentTab, ...(writerLive ? [createdTab, groupTab] : [])],
    panes: [parentPane, ...(writerLive ? [createdRoot, groupRoot] : [])], layouts: [], agents: [parentPane],
    focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1",
  });
  const server = await startFakeHerdrServer(async (request) => {
    switch (request.method) {
      case "ping": return reply(request, { type: "pong", version: "0.7.3", protocol: 16 });
      case "pane.current": return reply(request, { type: "pane_current", pane: parentPane });
      case "session.snapshot": return reply(request, { type: "session_snapshot", snapshot: snapshot() });
      case "workspace.get": return reply(request, { type: "workspace_info", workspace: writerWorkspace() });
      case "events.subscribe": return reply(request, { type: "subscription_started" });
      case "worktree.list": return reply(request, {
        type: "worktree_list",
        source: { repo_key: "repo-key", repo_name: "repo", repo_root: root, source_checkout_path: root, source_workspace_id: "w1" },
        worktrees: writerLive ? [{ path: writerPath, branch: writerBranch, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: "writer", open_workspace_id: "w2" }] : [],
      });
      case "worktree.create": {
        const params = request.params as Record<string, unknown>;
        writerPath = String(params.path); writerBranch = String(params.branch); writerBase = String(params.base);
        await execFileAsync("git", ["-C", root, "worktree", "add", "-q", "-b", writerBranch, writerPath, writerBase]);
        writerLive = true;
        return reply(request, { type: "worktree_created", workspace: writerWorkspace(), tab: createdTab, root_pane: createdRoot, worktree: { path: writerPath, branch: writerBranch, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: "writer", open_workspace_id: "w2" } });
      }
      case "tab.create": return reply(request, { type: "tab_created", tab: groupTab, root_pane: groupRoot });
      case "pane.process_info": return reply(request, { type: "pane_process_info", process_info: { pane_id: String((request.params as Record<string, unknown>).pane_id), shell_pid: 10, tty: "/dev/ttys-test", foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["zsh"] }] } });
      case "pane.list": return reply(request, { type: "pane_list", panes: snapshot().panes });
      case "agent.list": return reply(request, { type: "agent_list", agents: snapshot().agents });
      case "agent.start": placementCalls += 1; return { id: request.id ?? "", error: { code: "agent_placement_not_found", message: "placement resolver has not observed the writer tab" } };
      case "worktree.remove": {
        assert.equal((request.params as Record<string, unknown>).force, false);
        await execFileAsync("git", ["-C", root, "worktree", "remove", writerPath]);
        writerLive = false;
        return reply(request, { type: "worktree_removed", workspace_id: "w2", path: writerPath, forced: false });
      }
      default: throw new Error(`Unexpected method ${String(request.method)}`);
    }
  });
  const fake = fixtureApi();
  const environment = { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" };
  const runtime = new HerdrToolRuntimeController(fake.api, { environment });
  try {
    await runtime.startSession(fake.context(root));
    const exhausted = await runtime.start("tool-writer-placement-exhausted", { profile: "worker", task: "Make no changes; exercise retained writer cleanup" });
    assert.equal(exhausted.ok, true);
    if (!exhausted.ok) return;
    assert.equal(exhausted.status, "blocked"); assert.equal(exhausted.run.lifecycle, "failed"); assert.equal(exhausted.run.live, false); assert.equal(placementCalls, 3);
    assert.equal(exhausted.run.worktree?.checkoutPath, writerPath); assert.equal(exhausted.run.worktree?.branch, writerBranch); assert.equal(writerLive, true);
    assert.ok((exhausted.reason ?? "").includes(`subagent_stop({ id: ${JSON.stringify(exhausted.run.id)} })`));
    await access(writerPath);
    assert.equal(fake.branch.filter((entry) => entry.type === "custom" && entry.customType === FAILURE_EVIDENCE_CUSTOM_TYPE).length, 1);
    assert.equal(fake.branch.filter((entry) => entry.type === "message").length, 1, "fixture has only its original user message; failure evidence is never model-visible");
    const stopped = await runtime.stop({ id: exhausted.run.id, mode: "graceful", cleanup: "remove_if_safe", timeoutMs: 2_000 });
    assert.equal(stopped.ok, true);
    if (stopped.ok) {
      assert.equal((stopped.result as { stopped: boolean }).stopped, true);
      assert.equal((stopped.cleanup as { removed: boolean; retained: boolean }).removed, true, JSON.stringify(stopped.cleanup));
      assert.equal((stopped.cleanup as { removed: boolean; retained: boolean }).retained, false);
    }
    assert.equal(writerLive, false);
    await assert.rejects(access(writerPath));
    const branches = (await execFileAsync("git", ["-C", root, "branch", "--format=%(refname:short)"])).stdout;
    assert.equal(branches.split("\n").includes(writerBranch), false, "generated no-change branch must be finalized");
  } finally {
    await runtime.stopSession(); await server.close(); await rm(container, { recursive: true, force: true });
  }
});
