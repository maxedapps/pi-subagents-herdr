import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary } from "../../src/tools/contracts.ts";
import { DashboardProjector, summarizeDashboardRuns } from "../../src/ui/status.ts";
import { semanticStyle } from "../../src/ui/theme.ts";
import { renderDashboardRow, SubagentsWidget } from "../../src/ui/widget.ts";

const theme = {
  fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

function run(id: string, status: RunSummary["herdrStatus"], overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    profile: "scout",
    harness: "pi",
    lifecycle: "running",
    herdrStatus: status,
    ownership: "current_session",
    live: true,
    elapsedMs: 82_000,
    taskSynopsis: `Task for ${id}`,
    terminalId: `term-${id}`,
    agentRevision: 1,
    ...overrides,
  };
}

function project(runs: readonly RunSummary[]) {
  return new DashboardProjector().project({ ok: true, scope: "current_session", runs, counts: {} });
}

test("dashboard summary preserves done and idle attention semantics while grouping ready", () => {
  const summary = summarizeDashboardRuns([
    run("blocked", "blocked"), run("working", "working"), run("done", "done"), run("idle", "idle"),
    run("unknown", "unknown"), run("failed", "unknown", { lifecycle: "failed", live: false }),
  ]);
  assert.deepEqual(summary, { total: 6, blocked: 1, working: 1, ready: 2, done: 1, idle: 1, unknown: 1, failures: 1, actionRequired: 0 });
  assert.deepEqual(semanticStyle("running", "done"), { icon: "✓", label: "done", color: "success" });
  assert.deepEqual(semanticStyle("running", "idle"), { icon: "○", label: "idle", color: "muted" });
});

test("stopped cleanup obligations remain visible and sort ahead of ordinary runs", () => {
  const attention = { required: true as const, kind: "cleanup_required" as const, noticeId: "act-1", revision: 1, reason: "integration missing", nextActions: ["integrate then retry"], deliveryStage: "parent_persisted" as const };
  const state = project([run("ordinary", "working"), run("stopped", "unknown", { lifecycle: "stopped", live: false, attention })]);
  assert.deepEqual(state.runs.map((item) => item.id), ["stopped", "ordinary"]);
  assert.equal(state.summary.actionRequired, 1);
  assert.match(renderDashboardRow(state.runs[0]!, 90, theme), /cleanup required/);
});

test("dashboard projects current owned summaries without output-revision state", () => {
  const state = project([run("a", "working", { agentRevision: 2 })]);
  assert.deepEqual(state.runs.map((item) => item.id), ["a"]);
  assert.equal("changedOutput" in state.runs[0]!, false);
  assert.equal("outputRevision" in state.runs[0]!, false);
});

test("injected themes are evaluated independently without color-only semantics", () => {
  const light = { ...theme, fg: (_color: string, text: string) => `\x1b[30m${text}\x1b[0m` } as unknown as Theme;
  const dark = { ...theme, fg: (_color: string, text: string) => `\x1b[97m${text}\x1b[0m` } as unknown as Theme;
  const state = project([run("done", "done")]);
  const lightText = new SubagentsWidget(() => state, light).render(60).join("\n");
  const darkText = new SubagentsWidget(() => state, dark).render(60).join("\n");
  assert.notEqual(lightText, darkText);
  assert.match(lightText, /✓/);
  assert.match(lightText, /done/);
  assert.match(darkText, /✓/);
  assert.match(darkText, /done/);
});

test("widget and rows are ANSI-visible-width safe at narrow and wide widths", () => {
  const state = project([
    run("very-long-run-identifier", "blocked", { customStatus: "approval needed" }),
    run("done", "done"),
    run("idle", "idle"),
  ]);
  const widget = new SubagentsWidget(() => state, theme);
  for (const width of [1, 8, 20, 35, 63, 100]) {
    for (const line of widget.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    for (const item of state.runs) assert.ok(visibleWidth(renderDashboardRow(item, width, theme)) <= width);
  }
  const wide = widget.render(100).join("\n");
  assert.match(wide, /blocked/);
  assert.match(wide, /done/);
  assert.match(wide, /idle/);
  widget.invalidate();
  assert.notEqual(widget.render(100).length, 0);
});
