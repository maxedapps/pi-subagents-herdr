import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../src/contracts/protocol.ts";
import { createCapturedResult, capturedToEnvelope } from "../../src/results/contracts.ts";
import { writeResultEnvelope } from "../../src/results/store.ts";
import { ActiveBranchOwnershipJournal, type PiBranchEntry } from "../../src/runtime/ownership.ts";
import { HerdrToolRuntimeController } from "../../src/tools/service.ts";
import { startFakeHerdrServer, type FakeHerdrRequest } from "../support/fake-herdr-server.ts";

const execFileAsync = promisify(execFile);
function reply(request: FakeHerdrRequest, result: JsonValue): JsonValue { return { id: request.id ?? "", result }; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prior-read-only-cleanup-"));
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);
  const runId = "run-prior-read-only";
  const priorEntries: PiBranchEntry[] = [{ type: "message", id: "prior-anchor", parentId: null }];
  const writer = new ActiveBranchOwnershipJournal({ appendEntry(customType: string, data: unknown) {
    priorEntries.push({ type: "custom", id: `prior-${priorEntries.length}`, parentId: priorEntries.at(-1)!.id, customType, data });
  } });
  let journal = writer.begin({ runId, runNonce: "nonce-prior", branchEntryId: "prior-anchor", sessionId: "prior-session", intended: { workspaceId: "w1", group: "default", worktreeRequested: false } });
  journal = writer.append(journal, "created", { tabId: "old-tab", rootPaneId: "old-root", rootTerminalId: "old-root-terminal" });
  journal = writer.append(journal, "started", { paneId: "old-child-pane", terminalId: "old-child-terminal" });
  journal = writer.append(journal, "stopped", {});
  const directory = join(root, ".subagents", "runs", runId);
  await mkdir(directory, { recursive: true });
  const metadata = {
    schemaVersion: 5, runId, runNonce: "nonce-prior", terminalId: "old-child-terminal",
    profileName: "scout", profileSource: "/profile.md", harness: "grok", taskSynopsis: "private prior task",
    artifactWriter: "parent", lifecycle: "stopped", createdAt: 1,
    policy: { thinking: "low", cwd: root, tools: ["read"], mutation: false, network: false, requireWorktree: false },
    artifacts: { metadata: join(directory, "run.json") },
    output: { text: "private output must not appear", revision: 1, source: "recent_unwrapped", truncated: false, herdrTruncated: false, localTruncated: false, returnedBytes: 30, returnedLines: 1, maxBytes: 49152, maxLines: 200 },
    runtime: { ephemeralFiles: "removed" }, generation: { nextGeneration: 2, bridgeAvailable: false }, ownershipJournal: journal,
  };
  await writeFile(join(directory, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const captured = createCapturedResult({ source: "pi-final-assistant", runId, runNonce: "nonce-prior", generation: 1, requestNonce: "request-prior", rawText: "private result", capturedAt: 2 });
  await writeResultEnvelope(root, capturedToEnvelope(captured, { stage: "parent_persisted", parentSessionId: "prior-session", parentEntryId: "prior-result-entry" }));

  const parentNative = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "current-session" };
  const parentPane = { pane_id: "w1:p1", terminal_id: "term-parent", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 1, agent: "pi", agent_session: parentNative, cwd: root };
  const snapshot = { version: "0.7.3", protocol: 16, workspaces: [{ workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "parent", focused: true, pane_count: 1, agent_status: "idle" }], panes: [parentPane], layouts: [], agents: [parentPane] };
  const server = await startFakeHerdrServer((request) => {
    if (request.method === "ping") return reply(request, { type: "pong", version: "0.7.3", protocol: 16 });
    if (request.method === "pane.current") return reply(request, { type: "pane_current", pane: parentPane });
    if (request.method === "session.snapshot") return reply(request, { type: "session_snapshot", snapshot });
    if (request.method === "events.subscribe") return reply(request, { type: "subscription_started" });
    throw new Error(`unexpected ${String(request.method)}`);
  });
  const branch: PiBranchEntry[] = [{ type: "message", id: "current-anchor", parentId: null }];
  let sends = 0;
  const api = {
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", id: `current-${branch.length}`, parentId: branch.at(-1)!.id, customType, data }); },
    sendMessage() { sends += 1; },
    getAllTools() { return ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({ name })); },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => true, ui: { confirm: async () => false },
    sessionManager: { getSessionId: () => "current-session", getSessionFile: () => undefined, getLeafId: () => branch.at(-1)!.id, getBranch: () => branch },
  } as unknown as ExtensionContext;
  const runtime = new HerdrToolRuntimeController(api, { environment: { HERDR_ENV: "1", HERDR_SOCKET_PATH: server.socketPath, HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" } });
  return { root, runId, directory, runtime, context, server, sends: () => sends };
}

test("startup lists prior read-only residue privately and explicit exact-ID stop purges valid 000001.json", async () => {
  const value = await fixture();
  try {
    const before = await readFile(join(value.directory, "run.json"), "utf8");
    await value.runtime.startSession(value.context);
    assert.equal(value.sends(), 0, "startup must not inject a model-visible message");
    assert.equal(await readFile(join(value.directory, "run.json"), "utf8"), before, "startup must not mutate prior metadata");
    const listed = await value.runtime.list({ scope: "project" });
    assert.equal(listed.ok, true);
    if (listed.ok) {
      const residue = listed.runs.find((run) => run.id === value.runId);
      assert.deepEqual(residue?.residue?.policyKind, "read_only");
      assert.equal(JSON.stringify(residue).includes("private prior task"), false);
      assert.equal(JSON.stringify(residue).includes("private output"), false);
    }
    const stopped = await value.runtime.stop({ id: value.runId, cleanup: "remove_if_safe" });
    assert.equal(stopped.ok, true);
    await assert.rejects(access(value.directory));
    assert.equal(value.sends(), 0, "cleanup-only adoption must not trigger a model turn");
  } finally {
    await value.runtime.stopSession(); await value.server.close(); await rm(value.root, { recursive: true, force: true });
  }
});

test("explicit read-only cleanup retains an unsafe result-store entry", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.directory, "results", "unexpected.txt"), "retain\n");
    await value.runtime.startSession(value.context);
    await assert.rejects(value.runtime.stop({ id: value.runId, cleanup: "remove_if_safe" }), /unsafe entry/);
    await access(join(value.directory, "results", "unexpected.txt"));
    assert.equal(value.sends(), 0);
  } finally {
    await value.runtime.stopSession(); await value.server.close(); await rm(value.root, { recursive: true, force: true });
  }
});
