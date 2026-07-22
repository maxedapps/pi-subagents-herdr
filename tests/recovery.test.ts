import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { buildRecoveryCatalog, formatRecoveryCatalog } from "../src/recovery.ts";
import { HERDR_STATE_CUSTOM_TYPE, type HerdrStateRecord } from "../src/session.ts";
import type { Run } from "../src/runtime.ts";

const parentSessionId = "parent";
const parentSessionFile = "/sessions/parent.jsonl";

function record(runId: string, overrides: Partial<HerdrStateRecord> = {}): HerdrStateRecord {
  return {
    state: "generation_pending",
    at: 1,
    parentSessionId,
    parentSessionFile,
    parentEntryId: "parent-entry",
    parentInstanceId: "instance",
    parentProcessId: 1,
    runId,
    childSessionId: `child-${runId}`,
    childSessionDir: `/sessions/${runId}`,
    childCwd: "/repo",
    terminalId: `term-${runId}`,
    paneId: `pane-${runId}`,
    tabId: `tab-${runId}`,
    workspaceId: `workspace-${runId}`,
    profile: "scout",
    status: "working",
    generation: { number: 1, baselineEntryId: null, delivery: "pending" },
    ...overrides,
  };
}

function entry(id: string, data: unknown): SessionEntry {
  return { id, parentId: null, timestamp: new Date(0).toISOString(), type: "custom", customType: HERDR_STATE_CUSTOM_TYPE, data } as unknown as SessionEntry;
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    parentSessionId,
    parentInstanceId: "instance-current",
    profile: "scout",
    childSessionId: `child-${id}`,
    childSessionDir: `/sessions/${id}`,
    childCwd: "/repo",
    artifactPath: `/artifacts/${id}.md`,
    terminalId: `term-${id}`,
    paneId: `pane-${id}`,
    tabId: `tab-${id}`,
    workspaceId: `workspace-${id}`,
    lifecycle: "live",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    generation: { number: 1, input: "task", baselineEntryId: null, delivery: "queued", blockingWaiter: false },
    ...overrides,
  };
}

test("recovery catalog merges current, durable, missing, historical, and artifact-only evidence once", () => {
  const historicalFirst = entry("h1", record("run-historical"));
  const current = entry("c1", record("run-current", {
    state: "result_queued",
    status: "done",
    generation: { number: 2, baselineEntryId: "base", delivery: "queued", artifactResultPersisted: true },
  }));
  const missing = entry("m1", record("run-missing", {
    state: "closed",
    status: "idle",
    generation: {
      number: 1,
      baselineEntryId: null,
      delivery: "pending",
      outcome: "aborted",
      artifactParentPersisted: true,
    },
  }));
  const historicalLatest = entry("h2", record("run-historical", {
    at: 2,
    profile: "custom-editor",
    state: "result_delivered",
    status: "done",
    generation: { number: 3, baselineEntryId: "base", delivery: "delivered" },
  }));
  const malformed = entry("bad", { runId: "bad" });
  const foreign = entry("foreign", record("run-foreign", { parentSessionId: "other" }));

  const result = buildRecoveryCatalog({
    entries: [historicalFirst, current, missing, historicalLatest, malformed, foreign],
    branch: [current, missing],
    parentSessionId,
    parentSessionFile,
    currentRuns: [run("run-current"), run("run-historical")],
    artifacts: [
      { runId: "run-artifact", path: "/artifacts/run-artifact.md" },
      { runId: "run-current", path: "/artifacts/run-current.md" },
      { runId: "run-historical", path: "/artifacts/run-historical.md" },
      { runId: "run-missing", path: "/artifacts/run-missing.md" },
    ],
  });

  assert.equal(result.invalidEntries, 1);
  assert.deepEqual(result.rows, [
    {
      runId: "run-historical",
      profile: "custom-editor",
      source: "durable",
      lifecycle: "result_delivered",
      status: "done",
      generation: 3,
      delivery: "delivered",
      branch: "historical",
      artifactPath: "/artifacts/run-historical.md",
      artifactCompleteness: "incomplete",
    },
    {
      runId: "run-current",
      profile: "scout",
      source: "current",
      lifecycle: "live",
      status: "idle",
      generation: 1,
      delivery: "queued",
      branch: "active",
      artifactPath: "/artifacts/run-current.md",
      artifactCompleteness: "available",
    },
    {
      runId: "run-missing",
      profile: "scout",
      source: "durable",
      lifecycle: "closed",
      status: "idle",
      generation: 1,
      delivery: "pending",
      outcome: "aborted",
      branch: "active",
      artifactPath: "/artifacts/run-missing.md",
      artifactCompleteness: "available",
    },
    {
      runId: "run-artifact",
      source: "artifact-only",
      branch: "unknown",
      artifactPath: "/artifacts/run-artifact.md",
      artifactCompleteness: "unknown",
    },
  ]);

  assert.equal(formatRecoveryCatalog(result.rows), [
    "Parent-session subagent recovery catalog after compaction:",
    "- run-historical [custom-editor] — latest durable result_delivered/done/g3 delivered; historical branch; artifact: /artifacts/run-historical.md (incomplete)",
    "- run-current [scout] — current live/idle/g1 queued; active branch; artifact: /artifacts/run-current.md (available)",
    "- run-missing [scout] — latest durable closed/idle/g1 aborted; active branch; artifact: /artifacts/run-missing.md (available)",
    "- run-artifact — status/branch/completeness unknown (artifact only); artifact: /artifacts/run-artifact.md (unknown)",
  ].join("\n"));
});

test("current aborted generations are formatted as terminal available artifacts", () => {
  const durable = entry("a1", record("run-aborted", {
    state: "retained",
    generation: {
      number: 2,
      baselineEntryId: "base",
      delivery: "pending",
      outcome: "aborted",
      artifactParentPersisted: true,
    },
  }));
  const result = buildRecoveryCatalog({
    entries: [durable],
    branch: [durable],
    parentSessionId,
    parentSessionFile,
    currentRuns: [run("run-aborted", {
      lifecycle: "retained",
      generation: {
        number: 2,
        input: "task",
        baselineEntryId: "base",
        delivery: "pending",
        outcome: "aborted",
        blockingWaiter: false,
        artifactParentPersisted: true,
      },
    })],
    artifacts: [{ runId: "run-aborted", path: "/artifacts/run-aborted.md" }],
  });
  assert.deepEqual(result.rows, [{
    runId: "run-aborted",
    profile: "scout",
    source: "current",
    lifecycle: "retained",
    status: "idle",
    generation: 2,
    delivery: "pending",
    outcome: "aborted",
    branch: "active",
    artifactPath: "/artifacts/run-aborted.md",
    artifactCompleteness: "available",
  }]);
  assert.match(formatRecoveryCatalog(result.rows), /current retained\/idle\/g2 aborted/);
});

test("empty recovery catalog is explicit", () => {
  assert.equal(formatRecoveryCatalog([]), [
    "Parent-session subagent recovery catalog after compaction:",
    "No parent-session subagent runs or artifacts were discovered.",
  ].join("\n"));
});
