import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { StartToolSchema, StatusToolSchema, StopToolSchema, assertStatusToolInput } from "../../src/tools/schemas.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { boundedResultText, renderToolResult } from "../../src/tools/renderers.ts";
import { TOOL_NAMES, TOOL_KEYS } from "../../src/tools/names.ts";
import { registerStatusTool } from "../../src/tools/status.ts";

test("tool schemas are strict, bounded, and Google-compatible", () => {
  assert.equal(Value.Check(StartToolSchema, { profile: "scout", task: "Map auth" }), true);
  assert.equal(Value.Check(StartToolSchema, { profile: "Scout", task: "Map auth" }), false);
  assert.equal(Value.Check(StartToolSchema, { profile: "scout", task: "Map auth", extra: true }), false);
  assert.equal(Value.Check(StatusToolSchema, {}), true);
  assert.equal(Value.Check(StatusToolSchema, { scope: "project" }), true);
  assert.equal(Value.Check(StatusToolSchema, { id: "run-1", lines: 160 }), true);
  assert.equal(Value.Check(StatusToolSchema, { id: "run-1", states: ["done", "blocked"], timeoutMs: 900_000, lines: 80 }), true);
  assert.equal(Value.Check(StatusToolSchema, { id: "run-1", states: [] }), false);
  assert.equal(Value.Check(StatusToolSchema, { id: "run-1", extra: true }), false);
  assert.equal(Value.Check(StopToolSchema, { id: "run-1", mode: "force", cleanup: "remove_if_safe", integration: { kind: "no_changes" } }), true);
  assert.equal(Value.Check(StopToolSchema, { id: "run-1", mode: "discard" }), false);
  for (const schema of [StartToolSchema, StatusToolSchema, StopToolSchema]) assert.doesNotMatch(JSON.stringify(schema), /anyOf|oneOf/);
});

test("subagent_status execution modes reject every invalid cross-field combination", () => {
  assert.equal(assertStatusToolInput({}), "list");
  assert.equal(assertStatusToolInput({ scope: "global" }), "list");
  assert.equal(assertStatusToolInput({ id: "run-1", lines: 20 }), "inspect");
  assert.equal(assertStatusToolInput({ id: "run-1", states: ["done"], timeoutMs: 10, lines: 20 }), "wait");
  assert.throws(() => assertStatusToolInput({ states: ["done"] }), /list mode/);
  assert.throws(() => assertStatusToolInput({ timeoutMs: 10 }), /list mode/);
  assert.throws(() => assertStatusToolInput({ lines: 10 }), /list mode/);
  assert.throws(() => assertStatusToolInput({ id: "run-1", scope: "global" }), /scope is valid only/);
  assert.throws(() => assertStatusToolInput({ id: "run-1", timeoutMs: 10 }), /requires id with explicit states/);
});

test("subagent_status dispatches list, inspect, and bounded wait-then-inspect", async () => {
  let definition: { execute: (...args: any[]) => Promise<{ details: any }> } | undefined;
  const calls: string[] = [];
  const summary = { id: "run-1", profile: "scout", harness: "pi", lifecycle: "running", herdrStatus: "done", ownership: "current_session", live: true, elapsedMs: 1, taskSynopsis: "task" } as const;
  const runtime = {
    async list(input: unknown) { calls.push(`list:${JSON.stringify(input)}`); return { ok: true, scope: "current_session", runs: [summary], counts: { done: 1 } }; },
    async get(input: unknown) { calls.push(`get:${JSON.stringify(input)}`); return { ok: true, run: summary, effectiveProfile: { description: "x", harness: "pi", thinking: "low", cwd: "/x", tools: [], skills: [] }, ownership: { runNonce: "n", parentSessionId: "p", branchEntryId: "b" }, topology: {}, output: { text: "done" }, artifacts: {}, runtime: { ephemeralFiles: "retained", piSessionData: "retained" }, createdAt: 1, updatedAt: 2 }; },
    async wait(input: unknown) { calls.push(`wait:${JSON.stringify(input)}`); return { ok: true, action: "wait", run: summary, result: { matched: true, state: "done" } }; },
  };
  const pi = { registerTool(value: typeof definition) { definition = value; } } as unknown as ExtensionAPI;
  registerStatusTool(pi, runtime as never, "subagent_status");
  await definition!.execute("a", { scope: "current_session" }, undefined);
  await definition!.execute("b", { id: "run-1", lines: 20 }, undefined);
  const waited = await definition!.execute("c", { id: "run-1", states: ["done"], timeoutMs: 100, lines: 40 }, undefined);
  assert.deepEqual(calls, [
    "list:{\"scope\":\"current_session\"}",
    "get:{\"id\":\"run-1\",\"lines\":20}",
    "wait:{\"id\":\"run-1\",\"states\":[\"done\"],\"timeoutMs\":100}",
    "get:{\"id\":\"run-1\",\"lines\":40}",
  ]);
  assert.equal(waited.details.observation.mode, "wait");
  assert.equal(waited.details.output.text, "done");
});

test("exactly five canonical model-facing names are centralized with no aliases", () => {
  assert.equal(TOOL_KEYS.length, 5);
  assert.equal(new Set(Object.values(TOOL_NAMES)).size, 5);
  assert.deepEqual(Object.values(TOOL_NAMES), [
    "subagent_start", "subagent_status", "subagent_send", "subagent_interrupt", "subagent_stop",
  ]);
  assert.equal(JSON.stringify(TOOL_NAMES).includes("herdr_subagent"), false);
});

test("LLM-facing serialized results remain below the tool output convention", () => {
  const result = boundedResultText({ ok: true, output: "🙂".repeat(100_000) });
  assert.ok(Buffer.byteLength(result, "utf8") < 50 * 1024);
  assert.match(result, /truncated/);
  assert.equal(result.includes("�"), false);
});

test("compact renderer preserves semantic status text and bounded expanded metadata", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  const component = renderToolResult({ ok: true, run: { id: "run-1", profile: "scout", harness: "pi", lifecycle: "running", herdrStatus: "blocked", ownership: "current_session", live: true, elapsedMs: 5, taskSynopsis: "Map auth" } }, true, theme);
  const lines = component.render(120);
  assert.match(lines.join("\n"), /! run-1 scout\/pi blocked/);
  assert.match(lines.join("\n"), /current_session/);
  assert.ok(lines.length < 20);
});
