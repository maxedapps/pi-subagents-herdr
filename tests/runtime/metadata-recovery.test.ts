import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRuntimeMetadataMatchesJournal, parseRuntimeRunMetadata, readRuntimeRunMetadata } from "../../src/runtime/metadata.ts";
import { ActiveBranchOwnershipJournal, recoverActiveBranchOwnership, type PiBranchEntry } from "../../src/runtime/ownership.ts";

function journal() {
  const entries: PiBranchEntry[] = [{ type: "message", id: "leaf", parentId: null }];
  const api = { appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: `e${entries.length}`, parentId: entries.at(-1)!.id, customType, data }); } };
  const writer = new ActiveBranchOwnershipJournal(api); let value = writer.begin({ runId: "run-1", runNonce: "nonce-1", branchEntryId: "leaf", sessionId: "parent", intended: { workspaceId: "w1", group: "g", worktreeRequested: false } });
  value = writer.append(value, "created", { tabId: "t", rootPaneId: "p0", rootTerminalId: "root", rootProcessBaseline: "baseline" });
  value = writer.append(value, "started", { paneId: "p1", terminalId: "term-1" });
  value = writer.append(value, "started", { nativeSession: { kind: "id", value: "native-1", source: "herdr:pi" } });
  return { entries, value };
}

function metadata(root: string) {
  return {
    schemaVersion: 4,
    runId: "run-1",
    runNonce: "nonce-1",
    terminalId: "term-1",
    nativeSession: { kind: "id", value: "native-1", source: "herdr:pi" },
    profileName: "scout",
    profileSource: "/profile.md",
    harness: "pi",
    taskSynopsis: "inspect",
    artifactWriter: "parent",
    createdAt: 1,
    policy: { thinking: "low", cwd: root, tools: ["read"], mutation: false, network: false, requireWorktree: false },
    artifacts: {
      metadata: join(root, ".subagents", "runs", "run-1", "run.json"),
      handoff: join(root, ".subagents", "runs", "run-1", "handoff.md"),
    },
    output: {
      text: "",
      revision: 0,
      source: "recent_unwrapped",
      truncated: false,
      herdrTruncated: false,
      localTruncated: false,
      returnedBytes: 0,
      returnedLines: 0,
      maxBytes: 49152,
      maxLines: 200,
    },
    runtime: { ephemeralFiles: "removed" },
    generation: { nextGeneration: 1, bridgeAvailable: false },
  } as const;
}

test("readiness-time native identity extends the monotonic started journal without rebinding terminal identity", () => {
  const { entries, value } = journal();
  assert.equal(value.sequence, 3); assert.equal(value.resources.terminalId, "term-1"); assert.equal(value.resources.nativeSession?.value, "native-1");
  assert.equal(recoverActiveBranchOwnership(entries).get("run-1")?.state, "owned");
  const writer = new ActiveBranchOwnershipJournal({ appendEntry() {} });
  assert.throws(() => writer.append(value, "started", { terminalId: "term-2" }), /immutable/);
  assert.throws(() => writer.append(value, "started", {}), /must add immutable resource evidence/);
});

test("cleanup-only adoption is an explicit terminal ownership phase with full immutable provenance", () => {
  const entries: PiBranchEntry[] = [{ type: "message", id: "leaf", parentId: null }];
  const writer = new ActiveBranchOwnershipJournal({ appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: `a${entries.length}`, parentId: entries.at(-1)!.id, customType, data }); } });
  const intent = writer.begin({ runId: "run-cleanup", runNonce: "nonce-cleanup", branchEntryId: "leaf", sessionId: "parent", intended: { workspaceId: "w2", group: "default", worktreeRequested: true } });
  const adopted = writer.append(intent, "cleanup_adopted", { tabId: "t2", rootPaneId: "p2", rootTerminalId: "root2", rootProcessBaseline: "legacy", paneId: "old-pane", terminalId: "old-terminal", repositoryId: "repo", commonGitDir: "/git", herdrRepositoryKey: "key", worktreeWorkspaceId: "w2", checkoutPath: "/writer", worktreeBranch: "herdr-subagents/run-cleanup-aaaaaaaaaaaa", worktreeBase: "base", worktreeInitialTabId: "t1", worktreeInitialRootPaneId: "p1", worktreeInitialRootTerminalId: "root1" });
  assert.equal(recoverActiveBranchOwnership(entries).get("run-cleanup")?.state, "owned");
  assert.equal(adopted.phase, "cleanup_adopted");
  assert.throws(() => writer.append(adopted, "started", {}), /Invalid ownership journal transition/);
});

test("schema 3/4 metadata migrates to 5 while unsupported versions and policy.skills are rejected", () => {
  const root = "/tmp/metadata-migration";
  const v4 = parseRuntimeRunMetadata(metadata(root)); assert.equal(v4.schemaVersion, 5);
  const { generation: _generation, ...legacy } = metadata(root);
  const v3 = parseRuntimeRunMetadata({ ...legacy, schemaVersion: 3 }); assert.equal(v3.schemaVersion, 5); assert.equal(v3.generation.nextGeneration, 1);
  assert.throws(() => parseRuntimeRunMetadata({ ...metadata(root), schemaVersion: 2 }), /malformed/);
  assert.throws(() => parseRuntimeRunMetadata({ ...metadata(root), schemaVersion: 6 }), /malformed/);
  assert.throws(() => parseRuntimeRunMetadata({
    ...metadata(root),
    policy: { ...metadata(root).policy, skills: [{ name: "x", path: "/tmp/x/SKILL.md" }] },
  }), /policy\.skills is not supported/);
});

test("operational metadata is containment-checked and must exactly match active-branch nonce, terminal, and native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "p8-runtime-metadata-")); const directory = join(root, ".subagents", "runs", "run-1"); await mkdir(directory, { recursive: true });
  const { value } = journal();
  try {
    await writeFile(join(directory, "run.json"), JSON.stringify(metadata(root)));
    const loaded = await readRuntimeRunMetadata(root, "run-1"); assert.ok(loaded); assertRuntimeMetadataMatchesJournal(loaded, value);
    assert.throws(() => assertRuntimeMetadataMatchesJournal(parseRuntimeRunMetadata({ ...metadata(root), runNonce: "tampered" }), value), /does not match/);
    await rm(join(directory, "run.json")); await writeFile(join(directory, "run.json"), "{}\n");
    await assert.rejects(readRuntimeRunMetadata(root, "run-1"), /malformed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
