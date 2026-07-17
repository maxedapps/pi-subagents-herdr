import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../src/contracts/protocol.ts";
import { createCapturedResult, capturedToEnvelope, RESULT_CUSTOM_TYPE } from "../../src/results/contracts.ts";
import { buildDeliveredText, computeDeliveryId } from "../../src/results/delivery.ts";
import { writeResultEnvelope } from "../../src/results/store.ts";
import { ActiveBranchOwnershipJournal, type PiBranchEntry } from "../../src/runtime/ownership.ts";
import { HerdrToolRuntimeController } from "../../src/tools/service.ts";
import type { WorktreeRecord } from "../../src/worktrees/contracts.ts";
import { identifyCheckout } from "../../src/worktrees/writer-locks.ts";
import { startFakeHerdrServer, type FakeHerdrRequest } from "../support/fake-herdr-server.ts";

const execFileAsync = promisify(execFile);
function reply(request: FakeHerdrRequest, result: JsonValue): JsonValue { return { id: request.id ?? "", result }; }

async function fixture(mode: "success" | "dirty" | "wrong_repo") {
  const container = await mkdtemp(join(tmpdir(), "prior-writer-cleanup-"));
  const root = join(container, "repo");
  await mkdir(root);
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);
  const base = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
  const runId = "run-prior-writer";
  const runNonce = "nonce-prior-writer";
  const branchName = `herdr-subagents/${runId}-abcdef123456`;
  const checkoutPath = join(container, "writer-checkout");
  await execFileAsync("git", ["-C", root, "worktree", "add", "-q", "-b", branchName, checkoutPath, base]);
  if (mode === "dirty") await writeFile(join(checkoutPath, "dirty.txt"), "owner work\n");
  const sourceIdentity = await identifyCheckout(root);
  const childIdentity = await identifyCheckout(checkoutPath);

  const priorSession = SessionManager.create(root, join(root, "prior-sessions"));
  priorSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "prior session anchor" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } as never);
  const priorAnchor = priorSession.appendCustomMessageEntry("fixture.anchor", "anchor", false);
  const journalWriter = new ActiveBranchOwnershipJournal({ appendEntry(customType: string, data: unknown) { priorSession.appendCustomEntry(customType, data); } });
  let journal = journalWriter.begin({ runId, runNonce, branchEntryId: priorAnchor, sessionId: priorSession.getSessionId(), sessionPath: priorSession.getSessionFile()!, intended: { workspaceId: "w2", group: "default", worktreeRequested: true } });
  journal = journalWriter.append(journal, "worktree_created", {
    repositoryId: sourceIdentity.repositoryId,
    commonGitDir: sourceIdentity.commonGitDir,
    herdrRepositoryKey: "repo-key",
    worktreeSourceWorkspaceId: "w1",
    worktreeWorkspaceId: "w2",
    checkoutPath,
    worktreeBranch: branchName,
    worktreeBase: base,
    worktreeInitialTabId: "w2:t1",
    worktreeInitialRootPaneId: "w2:p1",
    worktreeInitialRootTerminalId: "term-created-root",
  });
  journal = journalWriter.append(journal, "created", { tabId: "w2:t2", rootPaneId: "w2:p2", rootTerminalId: "term-group-root", rootProcessBaseline: "group-baseline" });
  journal = journalWriter.append(journal, "started", { paneId: "old-child-pane", terminalId: "old-child-terminal" });
  journal = journalWriter.append(journal, "stopped", {});

  const directory = join(root, ".subagents", "runs", runId);
  await mkdir(directory, { recursive: true });
  const worktree: WorktreeRecord = {
    schemaVersion: 1,
    id: runId,
    repositoryId: mode === "wrong_repo" ? "wrong-repository" : childIdentity.repositoryId,
    commonGitDir: childIdentity.commonGitDir,
    herdrRepositoryKey: "repo-key",
    sourceWorkspaceId: "w1",
    sourceCheckoutPath: sourceIdentity.checkoutPath,
    workspaceId: "w2",
    checkoutPath: childIdentity.checkoutPath,
    branch: branchName,
    generatedBranch: true,
    base,
    state: "retained",
    createdRoot: { tabId: "w2:t1", rootPaneId: "w2:p1", rootTerminalId: "term-created-root", rootProcessBaseline: "created-baseline" },
    tab: { tabId: "w2:t2", rootPaneId: "w2:p2", rootTerminalId: "term-group-root", rootProcessBaseline: "group-baseline" },
    owner: { runId, runNonce, parent: { sessionId: priorSession.getSessionId(), sessionPath: priorSession.getSessionFile()!, branchEntryId: priorAnchor } },
    artifactPaths: [], capturedArtifacts: [], artifactsCaptured: false,
    parentVerification: { review: "pending", integration: "pending" },
    createdAt: 1, updatedAt: 1,
  };
  const metadata = {
    schemaVersion: 5, runId, runNonce, terminalId: "old-child-terminal",
    profileName: "worker", profileSource: "/profile.md", harness: "grok", taskSynopsis: "private writer task",
    artifactWriter: "parent", lifecycle: "stopped", createdAt: 1,
    policy: { thinking: "low", cwd: checkoutPath, tools: ["read", "bash", "edit", "write"], mutation: true, network: false, requireWorktree: true },
    artifacts: { metadata: join(directory, "run.json") },
    output: { text: "", revision: 0, source: "recent_unwrapped", truncated: false, herdrTruncated: false, localTruncated: false, returnedBytes: 0, returnedLines: 0, maxBytes: 49152, maxLines: 200 },
    runtime: { ephemeralFiles: "removed" }, generation: { nextGeneration: 2, bridgeAvailable: false }, worktree, ownershipJournal: journal,
  };
  await writeFile(join(directory, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const captured = createCapturedResult({ source: "pi-final-assistant", runId, runNonce, generation: 1, requestNonce: "writer-request", rawText: "private writer result", capturedAt: 2 });
  const deliveryId = computeDeliveryId(captured.resultId, createHash("sha256").update(captured.rawText, "utf8").digest("hex"));
  const provisional = capturedToEnvelope(captured, { stage: "dispatched", parentSessionId: priorSession.getSessionId(), parentSessionPath: priorSession.getSessionFile()!, deliveryId });
  const deliveredText = buildDeliveredText({ envelope: provisional, profileName: "worker", deliveryId });
  const parentEntryId = priorSession.appendCustomMessageEntry(RESULT_CUSTOM_TYPE, deliveredText, true);
  await writeResultEnvelope(root, capturedToEnvelope(captured, { stage: "parent_persisted", parentSessionId: priorSession.getSessionId(), parentSessionPath: priorSession.getSessionFile()!, parentEntryId, deliveryId }, deliveredText));

  const parentNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "current-session" };
  const parentPane = { pane_id: "w1:p1", terminal_id: "term-parent", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 1, agent: "pi", agent_session: parentNative, cwd: root };
  const createdRoot = { pane_id: "w2:p1", terminal_id: "term-created-root", workspace_id: "w2", tab_id: "w2:t1", focused: false, agent_status: "idle", revision: 1, agent: null };
  const groupRoot = { pane_id: "w2:p2", terminal_id: "term-group-root", workspace_id: "w2", tab_id: "w2:t2", focused: false, agent_status: "idle", revision: 1, agent: null };
  let writerLive = true;
  const writerWorkspace = () => ({ workspace_id: "w2", number: 2, label: "writer", focused: false, pane_count: 2, tab_count: 2, active_tab_id: "w2:t2", agent_status: "idle", worktree: { repo_key: "repo-key", repo_name: "repo", repo_root: root, checkout_path: childIdentity.checkoutPath, is_linked_worktree: true } });
  const snapshot = () => ({
    version: "0.7.3", protocol: 16,
    workspaces: [{ workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }, ...(writerLive ? [writerWorkspace()] : [])],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "parent", focused: true, pane_count: 1, agent_status: "idle" }, ...(writerLive ? [{ tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "created", focused: false, pane_count: 1, agent_status: "idle" }, { tab_id: "w2:t2", workspace_id: "w2", number: 2, label: "group", focused: false, pane_count: 1, agent_status: "idle" }] : [])],
    panes: [parentPane, ...(writerLive ? [createdRoot, groupRoot] : [])], layouts: [], agents: [parentPane],
  });
  const server = await startFakeHerdrServer(async (request) => {
    switch (request.method) {
      case "ping": return reply(request, { type: "pong", version: "0.7.3", protocol: 16 });
      case "pane.current": return reply(request, { type: "pane_current", pane: parentPane });
      case "session.snapshot": return reply(request, { type: "session_snapshot", snapshot: snapshot() });
      case "events.subscribe": return reply(request, { type: "subscription_started" });
      case "pane.process_info": return reply(request, { type: "pane_process_info", process_info: { pane_id: String((request.params as Record<string, unknown>).pane_id), shell_pid: 10, tty: "/dev/ttys-test", foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["zsh"] }] } });
      case "workspace.get": return reply(request, { type: "workspace_info", workspace: writerWorkspace() });
      case "worktree.list": return reply(request, { type: "worktree_list", source: { repo_key: "repo-key", repo_name: "repo", repo_root: root, source_checkout_path: sourceIdentity.checkoutPath, source_workspace_id: "w1" }, worktrees: writerLive ? [{ path: childIdentity.checkoutPath, branch: branchName, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, label: "writer", open_workspace_id: "w2" }] : [] });
      case "worktree.remove": {
        assert.equal((request.params as Record<string, unknown>).force, false);
        await execFileAsync("git", ["-C", root, "worktree", "remove", checkoutPath]);
        writerLive = false;
        return reply(request, { type: "worktree_removed", workspace_id: "w2", path: childIdentity.checkoutPath, forced: false });
      }
      default: throw new Error(`unexpected ${String(request.method)}`);
    }
  });
  const currentBranch: PiBranchEntry[] = [{ type: "message", id: "current-anchor", parentId: null }];
  let sends = 0;
  const api = {
    appendEntry(customType: string, data: unknown) { currentBranch.push({ type: "custom", id: `current-${currentBranch.length}`, parentId: currentBranch.at(-1)!.id, customType, data }); },
    sendMessage() { sends += 1; },
    getAllTools() { return ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name })); },
  } as unknown as ExtensionAPI;
  const context = { cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => true, ui: { confirm: async () => false }, sessionManager: { getSessionId: () => "current-session", getSessionFile: () => undefined, getLeafId: () => currentBranch.at(-1)!.id, getBranch: () => currentBranch } } as unknown as ExtensionContext;
  const runtime = new HerdrToolRuntimeController(api, { environment: { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" } });
  return { container, root, runId, checkoutPath, branchName, directory, runtime, context, server, sends: () => sends, currentBranch };
}

for (const mode of ["success", "dirty", "wrong_repo"] as const) {
  test(`explicit exact-ID prior writer cleanup ${mode === "success" ? "succeeds" : `rejects ${mode}`}`, async () => {
    const value = await fixture(mode);
    try {
      await value.runtime.startSession(value.context);
      const branchEntriesBefore = value.currentBranch.length;
      if (mode === "success") {
        const stopped = await value.runtime.stop({ id: value.runId, cleanup: "remove_if_safe" });
        assert.equal(stopped.ok, true);
        if (stopped.ok) assert.deepEqual({ removed: (stopped.cleanup as { removed: boolean }).removed, retained: (stopped.cleanup as { retained: boolean }).retained }, { removed: true, retained: false }, JSON.stringify(stopped.cleanup));
        await assert.rejects(access(value.checkoutPath));
        await assert.rejects(access(value.directory));
        const branches = (await execFileAsync("git", ["-C", value.root, "branch", "--format=%(refname:short)"], { encoding: "utf8" })).stdout;
        assert.equal(branches.split("\n").includes(value.branchName), false);
        assert.equal(value.currentBranch.length > branchEntriesBefore, true, "explicit stop records cleanup-only adoption on the current branch");
      } else {
        await assert.rejects(value.runtime.stop({ id: value.runId, cleanup: "remove_if_safe" }), mode === "dirty" ? /checkout is dirty/ : /source checkout identity mismatch/);
        await access(value.checkoutPath);
        await access(value.directory);
        assert.equal(value.currentBranch.length, branchEntriesBefore, "failed provenance checks must not append adoption state");
      }
      assert.equal(value.sends(), 0);
    } finally {
      await value.runtime.stopSession(); await value.server.close(); await rm(value.container, { recursive: true, force: true });
    }
  });
}
