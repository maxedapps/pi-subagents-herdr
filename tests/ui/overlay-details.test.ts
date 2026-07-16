import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary } from "../../src/tools/contracts.ts";
import { SubagentsOverlay, OverlaySelection, type OverlayAction } from "../../src/ui/overlay.ts";
import type { DashboardRun, DashboardState } from "../../src/ui/status.ts";

const theme = {
  fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => text,
} as unknown as Theme;

function run(id: string, ownership: RunSummary["ownership"] = "current_session"): DashboardRun {
  return {
    id, profile: "worker", harness: "codex", lifecycle: "running", herdrStatus: "done", ownership,
    live: true, elapsedMs: 1_000, taskSynopsis: `Inspect ${id}`, terminalId: `term-${id}`, agentRevision: 1,
    changedOutput: false,
  };
}

function state(runs: readonly DashboardRun[], scope: DashboardState["scope"] = "current_session"): DashboardState {
  const done = runs.filter((item) => item.herdrStatus === "done").length;
  return {
    scope, connection: "connected", runs,
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

test("orphan, uncertain, other-session, and global rows disable focus and control with explanations", () => {
  for (const ownership of ["orphaned", "uncertain", "other_session", "observational"] as const) {
    const actions: OverlayAction[] = [];
    const overlay = new SubagentsOverlay(state([run(ownership, ownership)], "global"), theme, (action) => actions.push(action), () => undefined);
    for (const key of ["\r", "s", "i", "x", "X", "c"]) overlay.handleInput(key);
    assert.deepEqual(actions, [], ownership);
    const rendered = overlay.render(90).join("\n");
    assert.match(rendered, /Actions disabled/);
  }
});

test("all-owned and global scopes are strictly observational even for current-session rows", () => {
  for (const scope of ["all_owned", "global"] as const) {
    const actions: OverlayAction[] = [];
    const overlay = new SubagentsOverlay(state([run("owned")], scope), theme, (action) => actions.push(action), () => undefined);
    for (const key of ["\r", "s", "i", "x", "X", "c"]) overlay.handleInput(key);
    assert.deepEqual(actions, []);
    assert.match(overlay.render(80).join("\n"), new RegExp(`${scope === "all_owned" ? "all-owned" : "global"} scope is strictly observational`));
  }
});

test("owned overlay emits terminal actions, cycles scope, and renders details width-safely", () => {
  const actions: OverlayAction[] = [];
  let renders = 0;
  const overlay = new SubagentsOverlay(state([run("owned")]), theme, (action) => actions.push(action), () => { renders += 1; });
  overlay.setDetails({
    run: run("owned"),
    output: { text: "one\ntwo\nthree", source: "recent_unwrapped", revision: 4, truncated: false, herdrTruncated: false, localTruncated: false, returnedBytes: 13, returnedLines: 3, maxBytes: 1024, maxLines: 20 },
  });
  overlay.handleInput("\r");
  overlay.handleInput("s");
  overlay.handleInput("i");
  overlay.handleInput("x");
  overlay.handleInput("X");
  overlay.handleInput("c");
  overlay.handleInput("\t");
  assert.deepEqual(actions.map((action) => action.type), ["focus", "send", "interrupt", "stop", "stop", "cleanup", "scope"]);
  assert.equal((actions[3] as { force: boolean }).force, false);
  assert.equal((actions[4] as { force: boolean }).force, true);
  assert.ok(renders > 0);
  for (const width of [1, 8, 23, 24, 50, 90]) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  assert.match(overlay.render(90).join("\n"), /Recent output/);
});
