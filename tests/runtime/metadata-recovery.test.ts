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
  return { schemaVersion: 3, runId: "run-1", runNonce: "nonce-1", terminalId: "term-1", nativeSession: { kind: "id", value: "native-1", source: "herdr:pi" }, profileName: "scout", profileSource: "/profile.md", harness: "pi", taskSynopsis: "inspect", artifactWriter: "parent", createdAt: 1, policy: { thinking: "low", cwd: root, tools: ["read"], mutation: false, network: false, requireWorktree: false }, artifacts: { metadata: join(root, ".subagents", "runs", "run-1", "run.json"), handoff: join(root, ".subagents", "runs", "run-1", "handoff.md") }, output: { text: "", revision: 0, source: "recent_unwrapped", truncated: false, herdrTruncated: false, localTruncated: false, returnedBytes: 0, returnedLines: 0, maxBytes: 49152, maxLines: 200 }, runtime: { ephemeralFiles: "removed" } } as const;
}

test("readiness-time native identity extends the monotonic started journal without rebinding terminal identity", () => {
  const { entries, value } = journal();
  assert.equal(value.sequence, 3); assert.equal(value.resources.terminalId, "term-1"); assert.equal(value.resources.nativeSession?.value, "native-1");
  assert.equal(recoverActiveBranchOwnership(entries).get("run-1")?.state, "owned");
  const writer = new ActiveBranchOwnershipJournal({ appendEntry() {} });
  assert.throws(() => writer.append(value, "started", { terminalId: "term-2" }), /immutable/);
  assert.throws(() => writer.append(value, "started", {}), /must add immutable resource evidence/);
});

test("legacy schema-3 policy skills remain readable but malformed legacy values are rejected", () => {
  const root = "/tmp/legacy-metadata";
  assert.doesNotThrow(() => parseRuntimeRunMetadata({
    ...metadata(root),
    policy: { ...metadata(root).policy, skills: [{ name: "legacy", path: "/tmp/legacy-skill/SKILL.md" }] },
  }));
  assert.throws(() => parseRuntimeRunMetadata({
    ...metadata(root),
    policy: { ...metadata(root).policy, skills: [{ name: "legacy", path: "relative.md" }] },
  }), /policy skills are malformed/);
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
