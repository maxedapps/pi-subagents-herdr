import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("production messaging has one completed-result turn path and no action generation path", async () => {
  const [service, delivery, attention, presentation, extension] = await Promise.all([
    source("tools/service.ts"), source("results/delivery.ts"), source("results/action-notices.ts"),
    source("results/presentation.ts"), source("lifecycle/extension.ts"),
  ]);
  assert.doesNotMatch(service, /sendMessage\s*\(/, "startup, recovery, cleanup, and passive attention must never send messages");
  assert.match(delivery, /customType:\s*RESULT_CUSTOM_TYPE[\s\S]*triggerTurn:\s*true/);
  assert.equal((delivery.match(/sendMessage\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(`${attention}\n${presentation}\n${extension}`, /class\s+ActionNoticeService|formatActionNotice|registerMessageRenderer\(LEGACY_ACTION/);
  assert.match(attention, /Read-only compatibility constants/);
});
