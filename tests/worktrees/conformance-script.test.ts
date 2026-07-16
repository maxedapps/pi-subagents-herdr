import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
test("real worktree conformance is no-model and dry-run safe until explicit operator confirmation", async () => {
  const loader = import.meta.resolve("tsx");
  const result = await execFileAsync(process.execPath, ["--import", loader, "scripts/conformance-herdr-worktree-no-model.ts", "--source-cwd", process.cwd()], { cwd: process.cwd(), env: { ...process.env, HERDR_ENV: "", HERDR_SOCKET_PATH: "" }, timeout: 10_000 });
  const report = JSON.parse(result.stdout);
  assert.deepEqual({ dry_run: report.dry_run, no_model: report.no_model, focus: report.would_create_focus, branchDeletion: report.branch_deletion }, { dry_run: true, no_model: true, focus: false, branchDeletion: false });
  const source = await readFile("scripts/conformance-herdr-worktree-no-model.ts", "utf8");
  assert.doesNotMatch(source, /agent\.start|startAgent|claude|codex/); assert.match(source, /--confirm-create/); assert.match(source, /removeWorktree\([^,]+, false\)/);
});
