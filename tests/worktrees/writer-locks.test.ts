import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { reconcileWriterLeaseWithHerdr, identifyCheckout, WriterLeaseStore, WriterScheduler } from "../../src/worktrees/writer-locks.ts";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import type { WriterBinding } from "../../src/worktrees/contracts.ts";
import { agent, pane, snapshot } from "../herdr/fixtures.ts";

const execFileAsync = promisify(execFile);
async function repository(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-writer-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}
function binding(runId: string) {
  return { runId, runNonce: `nonce-${runId}`, terminalId: `terminal-${runId}`, nativeSession: { kind: "id" as const, value: `native-${runId}`, source: "herdr:pi" }, parent: { sessionId: `parent-${runId}`, branchEntryId: `branch-${runId}` } };
}
function proof(value: WriterBinding, state: "live" | "gone" | "uncertain", reason = `fixture ${state}`) {
  return { state, checkedAt: Date.now(), herdrVersion: "0.7.3", protocol: 16 as const, reason, boundTerminalId: value.terminalId, boundNativeSession: value.nativeSession };
}

async function runChild(args: readonly string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const loader = import.meta.resolve("tsx");
  const child = spawn(process.execPath, ["--import", loader, "tests/support/writer-lease-child.ts", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  return { ...result, stdout, stderr };
}

test("canonical repository/common-Git-dir identity distinguishes linked checkout paths", async () => {
  const repo = await repository(); const linked = `${repo.root}-linked`;
  try {
    execFileSync("git", ["-C", repo.root, "worktree", "add", "-q", "-b", "linked", linked]);
    const [main, child] = await Promise.all([identifyCheckout(repo.root), identifyCheckout(linked)]);
    assert.equal(main.repositoryId, child.repositoryId); assert.equal(main.commonGitDir, child.commonGitDir); assert.notEqual(main.checkoutPath, child.checkoutPath);
  } finally { execFileSync("git", ["-C", repo.root, "worktree", "remove", "--force", linked], { stdio: "ignore" }); await repo.dispose(); }
});

test("parallel readers share a checkout while one persistent writer fails closed across reload/unavailable Herdr", async () => {
  const repo = await repository();
  try {
    const checkout = await identifyCheckout(repo.root); const scheduler = new WriterScheduler(new WriterLeaseStore());
    assert.deepEqual(scheduler.authorizeReadOnly(checkout), { allowed: true, isolation: "shared-checkout" });
    assert.deepEqual(scheduler.authorizeReadOnly(checkout), { allowed: true, isolation: "shared-checkout" });
    await assert.rejects(scheduler.acquireWriter({ checkout, binding: binding("stale"), liveProof: { ...proof(binding("stale"), "live"), checkedAt: Date.now() - 60_000 }, reconcileExisting: async (lease) => proof(lease, "live") }), /stale/);
    const first = await scheduler.acquireWriter({ checkout, binding: binding("a"), liveProof: proof(binding("a"), "live"), reconcileExisting: async (lease) => proof(lease, "live") });
    assert.equal(first.acquired, true);
    const reload = await new WriterLeaseStore().acquire({ checkout, binding: binding("a"), liveProof: proof(binding("a"), "live"), reconcileExisting: async () => { throw new Error("must not reconcile same holder"); } });
    assert.equal(reload.acquired, true, "same run/terminal/native/branch proof survives parent reload");
    const unavailable = await scheduler.acquireWriter({ checkout, binding: binding("b"), liveProof: proof(binding("b"), "live"), reconcileExisting: async () => { throw new Error("socket unavailable"); } });
    assert.equal(unavailable.acquired, false); assert.equal(unavailable.requiresIsolatedWorktree, true); assert.match(unavailable.reason, /retained.*socket unavailable/i);
    assert.equal((await new WriterLeaseStore().read(checkout))?.runId, "a");
  } finally { await repo.dispose(); }
});

test("two concurrent processes transactionally grant exactly one writer", async () => {
  const repo = await repository();
  try {
    const [left, right] = await Promise.all([runChild([repo.root, "left", "terminal-left"]), runChild([repo.root, "right", "terminal-right"])]);
    assert.equal(left.code, 0, left.stderr); assert.equal(right.code, 0, right.stderr);
    const values = [JSON.parse(left.stdout), JSON.parse(right.stdout)];
    assert.equal(values.filter((value) => value.acquired).length, 1); assert.equal(values.filter((value) => !value.acquired).length, 1);
  } finally { await repo.dispose(); }
});

test("concurrent stale transaction-lock reclaimers never delete a successor lock or grant multiple writers", async () => {
  const repo = await repository();
  try {
    const checkout = await identifyCheckout(repo.root); const paths = await new WriterLeaseStore().paths(checkout);
    await mkdir(paths.lock, { mode: 0o700 });
    await writeFile(join(paths.lock, "owner.json"), `${JSON.stringify({ pid: 99_999_999, nonce: "stale-owner", acquiredAt: 1 })}\n`, { mode: 0o600 });
    const children = await Promise.all(Array.from({ length: 6 }, (_, index) => runChild([repo.root, `stale-race-${index}`, `terminal-${index}`])));
    for (const child of children) assert.equal(child.code, 0, child.stderr);
    const values = children.map((child) => JSON.parse(child.stdout));
    assert.equal(values.filter((value) => value.acquired).length, 1);
    assert.equal(values.filter((value) => !value.acquired).length, 5);
    assert.equal((await new WriterLeaseStore().read(checkout))?.runId, values.find((value) => value.acquired)?.lease.runId);
  } finally { await repo.dispose(); }
});

test("crashed process leaves lease; only compatible Herdr gone proof reclaims it", async () => {
  const repo = await repository(); const marker = join(repo.root, "crash-result.json");
  try {
    const crashed = await runChild([repo.root, "crashed", "terminal-crashed", "crash", marker]);
    assert.equal(crashed.signal, "SIGKILL"); assert.equal(JSON.parse(await readFile(marker, "utf8")).acquired, true);
    const checkout = await identifyCheckout(repo.root); const store = new WriterLeaseStore();
    const uncertain = await store.acquire({ checkout, binding: binding("next"), liveProof: proof(binding("next"), "live"), reconcileExisting: async (lease) => proof(lease, "uncertain", "split topology") });
    assert.equal(uncertain.acquired, false); assert.equal((await store.read(checkout))?.runId, "crashed");
    const reclaimed = await store.acquire({ checkout, binding: binding("next"), liveProof: proof(binding("next"), "live"), reconcileExisting: async (lease) => proof(lease, "gone") });
    assert.equal(reclaimed.acquired, true); assert.equal(reclaimed.reclaimed?.runId, "crashed");
  } finally { await repo.dispose(); }
});

test("lease release also retains on live, uncertain, unavailable, or identity mismatch", async () => {
  const repo = await repository();
  try {
    const checkout = await identifyCheckout(repo.root); const store = new WriterLeaseStore(); await store.acquire({ checkout, binding: binding("a"), liveProof: proof(binding("a"), "live"), reconcileExisting: async (lease) => proof(lease, "gone") });
    assert.equal((await store.release({ checkout, binding: binding("other"), reconcile: async (lease) => proof(lease, "gone") })).released, false);
    assert.equal((await store.release({ checkout, binding: binding("a"), reconcile: async (lease) => proof(lease, "live") })).released, false);
    assert.equal((await store.release({ checkout, binding: binding("a"), reconcile: async () => { throw new Error("Herdr down"); } })).released, false);
    assert.equal((await store.release({ checkout, binding: binding("a"), reconcile: async (lease) => proof(lease, "gone") })).released, true);
    assert.equal(await store.read(checkout), undefined);
  } finally { await repo.dispose(); }
});

test("live Herdr reconciliation requires terminal, native session, and topology; absence proves gone", async () => {
  const repo = await repository();
  try {
    const checkout = await identifyCheckout(repo.root); const baseLease = { schemaVersion: 1 as const, checkout, ...binding("a"), acquiredAt: 1, updatedAt: 1, lastReconciled: proof(binding("a"), "live") };
    const native = { source: "herdr:pi", agent: "pi", kind: "id" as const, value: "native-a" };
    const livePane = { ...pane, terminal_id: "terminal-a", pane_id: "w1:writer", agent_session: native };
    const liveAgent = { ...agent, terminal_id: "terminal-a", pane_id: "w1:writer", agent_session: native };
    const client = (value: typeof snapshot) => ({ async ping() { return { version: "0.7.3", protocol: 16 }; }, async snapshot() { return value; } }) as unknown as HerdrRequestClient;
    assert.equal((await reconcileWriterLeaseWithHerdr(client({ ...snapshot, panes: [...snapshot.panes, livePane], agents: [...snapshot.agents, liveAgent] }), baseLease)).state, "live");
    assert.equal((await reconcileWriterLeaseWithHerdr(client(snapshot), baseLease)).state, "gone");
    assert.equal((await reconcileWriterLeaseWithHerdr(client({ ...snapshot, panes: [...snapshot.panes, livePane] }), baseLease)).state, "uncertain");
    const incompatible = ({ async ping() { return { version: "0.7.2", protocol: 15 }; } }) as unknown as HerdrRequestClient;
    await assert.rejects(reconcileWriterLeaseWithHerdr(incompatible, baseLease), /retained/);
  } finally { await repo.dispose(); }
});
