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
  inventoryHerdrJournal,
  observeChildSession,
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
    assert.equal(await observeChildSession(location, null), undefined);
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

test("child observations fingerprint the active leaf, latest compaction, and latest eligible result", async () => {
  await fixture(async (location, manager) => {
    const rootId = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const baselineId = manager.appendMessage(assistant(["baseline"]));

    const baseline = await observeChildSession(location, baselineId);
    assert.equal(baseline?.activeLeafId, baselineId);
    assert.equal(baseline?.latestCompactionId, undefined);
    assert.equal(baseline?.result, undefined);
    assert.deepEqual(await observeChildSession(location, baselineId), baseline);

    manager.appendMessage(assistant(["tool output"], "toolUse"));
    const firstResult = assistant(["first ", "eligible"]);
    const firstResultId = manager.appendMessage(firstResult);
    const withResult = await observeChildSession(location, baselineId);
    assert.equal(withResult?.activeLeafId, firstResultId);
    assert.deepEqual(withResult?.result, {
      childEntryId: firstResultId,
      text: "first eligible",
      message: firstResult,
    });

    const compactionId = manager.appendCompaction("summary", baselineId, 100);
    const compacted = await observeChildSession(location, baselineId);
    assert.equal(compacted?.activeLeafId, compactionId);
    assert.equal(compacted?.latestCompactionId, compactionId);
    assert.equal(compacted?.result?.childEntryId, firstResultId);

    const replacement = assistant(["replacement"]);
    const replacementId = manager.appendMessage(replacement);
    const replaced = await observeChildSession(location, baselineId);
    assert.equal(replaced?.activeLeafId, replacementId);
    assert.equal(replaced?.latestCompactionId, compactionId);
    assert.equal(replaced?.result?.childEntryId, replacementId);

    manager.branch(rootId);
    const branchResultId = manager.appendMessage(assistant(["branch result"]));
    const moved = await observeChildSession(location, null);
    assert.equal(moved?.activeLeafId, branchResultId);
    assert.equal(moved?.latestCompactionId, undefined);
    assert.equal(moved?.result?.childEntryId, branchResultId);
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
      generation: {
        ...base.generation,
        outcome: "aborted",
        artifactParentPersisted: true,
        artifactResultPersisted: true,
      },
    });
    replayed = reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile);
    assert.equal(replayed.invalidEntries, 0);
    assert.equal(replayed.runs.get("run-old")?.latest.archivePending, true);
    assert.equal(replayed.runs.get("run-old")?.latest.generation?.outcome, "aborted");

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
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, generation: { baselineEntryId: null, delivery: "pending" } });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, generation: { number: 1, baselineEntryId: 4, delivery: "pending" } });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, generation: { number: 1, baselineEntryId: null, delivery: "settled" } });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, generation: { ...base.generation, returned: "yes" } });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, generation: { ...base.generation, outcome: "completed" } });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, generation: { ...base.generation, outcome: null } });
    replayed = reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile);
    assert.equal(replayed.invalidEntries, 9);
  });
});

test("full-session inventory includes historical branches with append-latest values and first-seen order", async () => {
  await fixture(async (_location, manager) => {
    const rootId = manager.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
    const parentSessionFile = manager.getSessionFile()!;
    const base = {
      state: "generation_pending" as const,
      at: 1,
      parentSessionId: manager.getSessionId(),
      parentSessionFile,
      parentEntryId: rootId,
      parentInstanceId: "instance",
      parentProcessId: 1,
      childSessionId: "child",
      childSessionDir: "/sessions/child",
      childCwd: "/repo",
      terminalId: "term",
      paneId: "pane",
      tabId: "tab",
      workspaceId: "workspace",
      profile: "scout" as const,
      status: "working" as const,
    };
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, runId: "run-one" });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, runId: "run-two", profile: "worker" });
    const latestOneId = manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, {
      ...base,
      runId: "run-one",
      at: 2,
      state: "result_delivered",
      status: "done",
      generation: { number: 1, baselineEntryId: null, delivery: "delivered", artifactResultPersisted: true },
    });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, runId: "run-foreign", parentSessionId: "other" });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, { ...base, runId: "run-malformed", status: "settled" });
    manager.appendCustomEntry(HERDR_STATE_CUSTOM_TYPE, {
      ...base,
      runId: "run-one",
      at: 3,
      generation: { number: "three", baselineEntryId: null, delivery: "delivered" },
    });
    manager.branch(rootId);
    manager.appendMessage(assistant(["active branch"]));

    const inventory = inventoryHerdrJournal(manager.getEntries(), manager.getSessionId(), parentSessionFile);
    assert.deepEqual([...inventory.runs.keys()], ["run-one", "run-two"]);
    assert.equal(inventory.runs.get("run-one")?.latestEntryId, latestOneId);
    assert.equal(inventory.runs.get("run-one")?.latest.state, "result_delivered");
    assert.equal(inventory.runs.get("run-one")?.latest.status, "done");
    assert.equal(inventory.invalidEntries, 2);
    assert.equal(manager.getBranch().some(({ id }) => id === latestOneId), false);
    assert.equal(reconstructHerdrJournal(manager.getBranch(), manager.getSessionId(), parentSessionFile).runs.size, 0);
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
