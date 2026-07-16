import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StartTopologyGate } from "../../src/tools/service.ts";
import { registerStartTool } from "../../src/tools/start.ts";


test("parallel sibling starts are serialized and duplicate tool-call IDs are idempotent", async () => {
  const gate = new StartTopologyGate();
  const order: string[] = [];
  let release!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const first = gate.run("call-1", async () => { calls += 1; order.push("first:start"); await firstBlocked; order.push("first:end"); return "first"; });
  const duplicate = gate.run("call-1", async () => { calls += 1; return "duplicate"; });
  const second = gate.run("call-2", async () => { calls += 1; order.push("second:start"); order.push("second:end"); return "second"; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["first:start"]);
  release();
  assert.deepEqual(await Promise.all([first, duplicate, second]), ["first", "first", "second"]);
  assert.equal(calls, 2);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("security-sensitive execution failures are thrown so Pi marks isError", async () => {
  let definition: { execute: (...args: any[]) => Promise<unknown> } | undefined;
  const pi = { registerTool(value: typeof definition) { definition = value; } } as unknown as ExtensionAPI;
  const runtime = { start: async () => { throw new Error("ownership rejected"); } };
  registerStartTool(pi, runtime as never, "subagent_start");
  await assert.rejects(
    definition!.execute("call", { profile: "scout", task: "x" }, undefined, undefined, {}),
    /ownership rejected/,
  );
});
