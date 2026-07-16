import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentsOverlay, OverlaySelection, type OverlayAction } from "../../src/ui/overlay.ts";
import type { DashboardRun, DashboardState } from "../../src/ui/status.ts";

const theme = {
  fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => text,
} as unknown as Theme;

function run(id: string): DashboardRun {
  return {
    id, profile: "worker", harness: "codex", lifecycle: "running", herdrStatus: "done", ownership: "current_session",
    live: true, elapsedMs: 1_000, taskSynopsis: `Inspect ${id}`, terminalId: `term-${id}`, agentRevision: 1,
  };
}

function state(runs: readonly DashboardRun[]): DashboardState {
  const done = runs.filter((item) => item.herdrStatus === "done").length;
  return {
    scope: "current_session", connection: "connected", runs,
    summary: { total: runs.length, blocked: 0, working: 0, ready: done, done, idle: 0, unknown: 0, failures: 0 },
    updatedAt: 1,
  };
}

test("selection is stable by run id and pagination clamps after reorder/removal", () => {
  const selection = new OverlaySelection();
  const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index}`));
  selection.replace(runs, 5);
  selection.move(8, runs, 5);
  assert.equal(selection.selectedId, "run-8");
  assert.equal(selection.offset, 4);
  const reordered = [runs[8]!, ...runs.filter((item) => item.id !== "run-8")];
  selection.replace(reordered, 5);
  assert.equal(selection.selectedId, "run-8");
  assert.equal(selection.selectedIndex, 0);
  selection.replace(reordered.slice(1, 3), 5);
  assert.equal(selection.selectedIndex, 0);
  assert.equal(selection.offset, 0);
});

test("overlay emits only focus, graceful stop, refresh, and close terminal actions", () => {
  const actions: OverlayAction[] = [];
  const overlay = new SubagentsOverlay(state([run("owned")]), theme, (action) => actions.push(action), () => undefined);
  overlay.handleInput("\r");
  overlay.handleInput("x");
  overlay.handleInput("r");
  for (const removed of ["d", "s", "i", "X", "c", "\t"]) overlay.handleInput(removed);
  overlay.handleInput("\x1b");
  assert.deepEqual(actions, [
    { type: "focus", id: "owned" },
    { type: "stop", id: "owned" },
    { type: "refresh" },
    { type: "close" },
  ]);
});

test("focus/stop-only overlay renders current-owned controls width-safely without details/output previews", () => {
  const overlay = new SubagentsOverlay(state([run("owned")]), theme, () => undefined, () => undefined);
  for (const width of [1, 8, 23, 24, 50, 90]) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  const rendered = overlay.render(90).join("\n");
  assert.match(rendered, /current owned/);
  assert.match(rendered, /↑↓ select · Enter focus · x stop · r refresh · Esc close/);
  assert.doesNotMatch(rendered, /details|Recent output|send|interrupt|force|cleanup|scope/i);
});
