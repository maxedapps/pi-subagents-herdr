import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrRequestClient } from "../../src/herdr/client.ts";
import { registerRecoveryLifecycle, RuntimeRecovery } from "../../src/runtime/recovery.ts";
import { snapshot } from "../herdr/fixtures.ts";

test("Pi recovery lifecycle handles start/tree/shutdown without child control", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const runtime = new RuntimeRecovery(); let servicesStopped = 0; runtime.registerService({ stop() { servicesStopped += 1; } });
  const client = { async snapshot() { return snapshot; } } as unknown as HerdrRequestClient;
  registerRecoveryLifecycle(pi, { runtime, client });
  assert.deepEqual([...handlers.keys()], ["session_start", "session_before_tree", "session_tree", "session_shutdown"]);
  const context = { sessionManager: { getBranch() { return []; }, getSessionId() { return "session-1"; }, getSessionFile() { return "/tmp/session-1.jsonl"; } } } as unknown as ExtensionContext;
  await handlers.get("session_start")?.({ reason: "reload" }, context); await handlers.get("session_before_tree")?.({}, context); await handlers.get("session_tree")?.({}, context); await handlers.get("session_shutdown")?.({}, context);
  assert.equal(servicesStopped, 1); assert.deepEqual(runtime.list(), []);
});
