import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("real Herdr E2E is dry-run by default for every selected harness", async (t) => {
  for (const harness of ["pi", "claude", "codex"] as const) await t.test(harness, async () => {
    const result = await execFileAsync(process.execPath, ["scripts/e2e-herdr-smoke.mjs", "--harness", harness], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000, env: { ...process.env, HERDR_ENV: "", HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "" } });
    const report = JSON.parse(result.stdout) as { dryRun: boolean; modelStarted: boolean; harness: string; safety: string[] };
    assert.deepEqual({ dryRun: report.dryRun, modelStarted: report.modelStarted, harness: report.harness }, { dryRun: true, modelStarted: false, harness });
    assert.match(report.safety.join("\n"), /no-focus|No Herdr resource/i);
  });
});

test("real Herdr E2E source keeps explicit quota, focus, force, timeout, identity, and retention gates", async () => {
  const source = await readFile("scripts/e2e-herdr-smoke.mjs", "utf8");
  for (const contract of ["--confirm-model", "--parent-session-id", "--parent-session-path", "--timeout-ms", "--exercise-focus", "--force-cleanup", "focus: false", "report.retained", "report.failure", "mode: \"pre-submit\"", "verifyParent", "closeAnchorOnlyGroup"]) assert.match(source, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /pi install|settings\.json|worktree\.remove|rmSync|git branch -D/);
});
