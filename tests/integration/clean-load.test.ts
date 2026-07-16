import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("clean load imports and invokes the factory without runtime side effects", async () => {
  const result = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/smoke-load.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PI_HERDR_SUBAGENT: "0" },
  });
  assert.match(result.stdout, /clean-load ok/);
  assert.doesNotMatch(result.stderr, /Error|Unhandled|failed/i);
});
