import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureChildCursor,
  HERDR_STATE_CUSTOM_TYPE,
  openChildSession,
  readChildResult,
  reconstructHerdrJournal,
  type ChildSessionLocation,
} from "../src/session.ts";

function assistant(texts: string[], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private" },
      ...texts.map((text) => ({ type: "text" as const, text })),
    ],
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    responseId: "response-metadata",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

async function fixture(run: (location: ChildSessionLocation, manager: SessionManager) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "child-session-"));
  const childSessionDir = join(root, "sessions");
  await mkdir(childSessionDir, { recursive: true });
  const location = { childSessionId: "herdr-run-exact", childSessionDir, childCwd: "/actual/child/cwd" };
  const manager = SessionManager.create(location.childCwd, childSessionDir, { id: location.childSessionId });
  try { await run(location, manager); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("first cursor is null before Pi persists a session and discovery uses the exact ID", async () => {
  await fixture(async (location, manager) => {
    assert.deepEqual(await captureChildCursor(location, true), { baselineEntryId: null });
    assert.equal(await openChildSession(location), undefined);
    manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
    manager.appendMessage(assistant(["done"]));
    const other = SessionManager.create(location.childCwd, location.childSessionDir, { id: "herdr-run-other" });
    other.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
    other.appendMessage(assistant(["wrong"]));
    const opened = await openChildSession(location);
    assert.equal(opened?.manager.getSessionId(), location.childSessionId);
  });
});

test("fresh snapshots select the last non-toolUse assistant after the active-branch cursor", async () => {
  await fixture(async (location, manager) => {
    manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    manager.appendMessage(assistant(["ignored"], "toolUse"));
    const firstId = manager.appendMessage(assistant(["first ", "result"]));
    const cursor = await captureChildCursor(location);
    assert.equal(cursor.baselineEntryId, firstId);

    manager.appendMessage({ role: "user", content: "follow-up", timestamp: Date.now() });
    const final = assistant(["second ", "result"]);
    const secondId = manager.appendMessage(final);
    assert.equal(await readChildResult(location, cursor.baselineEntryId, "working"), undefined);
    const result = await readChildResult(location, cursor.baselineEntryId, "idle");
    assert.equal(result?.childEntryId, secondId);
    assert.equal(result?.text, "second result");
    assert.equal(result?.message.responseId, "response-metadata");
    assert.deepEqual(result?.message, final);
  });
});

test("journal replay accepts old records and validates optional artifact milestones", async () => {
  await fixture(async (_location, manager) => {
    manager.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
    const parentSessionFile = manager.getSessionFile()!;
    const base = {
      state: "generation_pending" as const,
      at: 1,
      parentSessionId: manager.getSessionId(),
      parentSessionFile,
      parentEntryId: manager.getLeafId(),
      parentInstanceId: "instance",
      parentProcessId: 1,
      runId: "run-old",
      childSessionId: "herdr-run-old",
      childSessionDir: "/agent/herdr-subagents/parent/run-old",
      childCwd: "/repo",
      terminalId: "term",
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      profile: "scout" as const,
      generation: { number: 1, baselineEntryId: null, delivery: "pending" as const },
    };
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, base);
    let replayed = reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile);
    assert.equal(replayed.invalidEntries, 0);
    assert.equal(replayed.runs.get("run-old")?.latest.artifactPath, undefined);

    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, {
      ...base,
      artifactPath: "/agent/herdr-subagent-artifacts/parent/run-old.md",
      archivePending: true,
      generation: { ...base.generation, artifactParentPersisted: true, artifactResultPersisted: true },
    });
    replayed = reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile);
    assert.equal(replayed.invalidEntries, 0);
    assert.equal(replayed.runs.get("run-old")?.latest.archivePending, true);

    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, childStopped: true });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, at: 2 });
    replayed = reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile);
    assert.equal(replayed.runs.get("run-old")?.childStopped, true);

    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, childStopped: false });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, archivePending: false });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, {
      ...base,
      generation: { ...base.generation, artifactResultPersisted: false },
    });
    replayed = reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile);
    assert.equal(replayed.invalidEntries, 3);
  });
});

test("a follow-up baseline absent from the active branch is an identity/cursor failure", async () => {
  await fixture(async (location, manager) => {
    manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const abandoned = manager.appendMessage(assistant(["abandoned"]));
    const rootId = manager.getBranch()[0]!.id;
    manager.branch(rootId);
    manager.appendMessage(assistant(["active"]));
    await assert.rejects(readChildResult(location, abandoned, "idle"), /baseline is not on the active branch/);
  });
});
