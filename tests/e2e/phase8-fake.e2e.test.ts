import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { strictTsxArgs } from "../support/strict-node.ts";

const execFileAsync = promisify(execFile);
const matrix = [
  { id: "start-submit-working-done-idle-blocked-send-interrupt-graceful-force", file: "tests/runtime/lifecycle.test.ts", minimum: 9 },
  { id: "pane-move-reload-tree-fork-tampered-metadata-retention", file: "tests/runtime/ownership-recovery.test.ts", minimum: 7 },
  { id: "exact-operational-metadata-recovery", file: "tests/runtime/metadata-recovery.test.ts", minimum: 2 },
  { id: "socket-reconnect-resnapshot", file: "tests/herdr/subscriptions.test.ts", minimum: 5 },
  { id: "partial-start-identity-safe-retention", file: "tests/runtime/groups-partial.test.ts", minimum: 5 },
  { id: "handoff-and-worktree-artifact-capture", file: "tests/artifacts/handoff-capture.test.ts", minimum: 10 },
  { id: "worktree-safe-cleanup-retention", file: "tests/worktrees/cleanup-retention.test.ts", pattern: "remove_if_safe captures artifacts", minimum: 1 },
  { id: "tool-surface-end-to-end-flow", file: "tests/tools/runtime-flow.test.ts", minimum: 1 },
] as const;

function passCount(output: string): number {
  const match = output.match(/ℹ pass (\d+)/) ?? output.match(/# pass (\d+)/);
  return match ? Number(match[1]) : 0;
}

for (const scenario of matrix) {
  test(`deterministic fake E2E: ${scenario.id}`, async () => {
    const environment: Record<string, string | undefined> = { ...process.env, HERDR_ENV: "", HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "", HERDR_TAB_ID: "", HERDR_WORKSPACE_ID: "" };
    delete environment.NODE_TEST_CONTEXT;
    const pattern = "pattern" in scenario ? [`--test-name-pattern=${scenario.pattern}`] : [];
    const result = await execFileAsync(process.execPath, strictTsxArgs("--test", ...pattern, scenario.file), {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000, env: environment,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(passCount(output) >= scenario.minimum, true, `${scenario.id} did not execute its full fake matrix:\n${output}`);
    assert.doesNotMatch(output, /not ok|ℹ fail [1-9]|# fail [1-9]/);
  });
}

test("deterministic source/package load and real-Herdr operator script remain no-model by default", async () => {
  const smoke = await execFileAsync(process.execPath, strictTsxArgs("scripts/smoke-load.ts"), { cwd: process.cwd(), encoding: "utf8", timeout: 15_000, env: { ...process.env, PI_HERDR_SUBAGENT: "0" } });
  assert.match(smoke.stdout, /clean-load ok/);
  const real = await execFileAsync(process.execPath, ["--throw-deprecation", "scripts/e2e-herdr-smoke.mjs", "--harness", "pi"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, HERDR_ENV: "", HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "" },
  });
  const report = JSON.parse(real.stdout) as { dryRun: boolean; modelStarted: boolean; harness: string };
  assert.deepEqual({ dryRun: report.dryRun, modelStarted: report.modelStarted, harness: report.harness }, { dryRun: true, modelStarted: false, harness: "pi" });
});
