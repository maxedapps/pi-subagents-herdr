import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { boundedResultText, renderToolResult } from "../../src/tools/renderers.ts";
import { exactToolPayload } from "../../src/results/presentation.ts";

test("tool renderer expanded mode shows exact deliveredText", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  const result = { ok: true, status: "started", run: { id: "run-1", profile: "scout", harness: "pi", lifecycle: "running", herdrStatus: "working", ownership: "current_session", live: true, elapsedMs: 1, taskSynopsis: "task" }, completion: { pending: true, delivery: "automatic", note: "auto" } };
  const payload = exactToolPayload(result, boundedResultText);
  const collapsed = renderToolResult(payload.details, false, theme).render(120).map((line) => line.trimEnd()).join("\n");
  // Compare source string identity before terminal width padding (plan: pre-wrap byte identity).
  assert.equal(payload.details.deliveredText, payload.content[0].text);
  assert.match(collapsed, /automatic delivery/);
  assert.ok(collapsed.includes("run-1"));
  const expandedSource = payload.details.deliveredText;
  assert.ok(expandedSource.includes('"status": "started"'));
  assert.ok(expandedSource.includes("automatic"));
});

test("boundedResultText remains under model-visible ceiling with valid UTF-8", () => {
  const text = boundedResultText({ ok: true, payload: "🙂".repeat(80_000) });
  assert.ok(Buffer.byteLength(text, "utf8") <= 48 * 1024);
  assert.equal(text.includes("�"), false);
});
