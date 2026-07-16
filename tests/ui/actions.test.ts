import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionToolResult, ListToolResult } from "../../src/tools/contracts.ts";
import type { StopToolInput } from "../../src/tools/schemas.ts";
import { OverlayActions, type UiRuntimeApi } from "../../src/ui/actions.ts";

function fixture(options: { confirms?: boolean[]; inputs?: Array<string | undefined>; selects?: Array<string | undefined>; focus?: { ok: boolean; reason?: string } } = {}) {
  const confirms = [...(options.confirms ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const selects = [...(options.selects ?? [])];
  const stops: StopToolInput[] = [];
  const sends: unknown[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const success = (action: "send" | "interrupt" | "stop"): ActionToolResult => ({
    ok: true, action, run: { id: "run-1", profile: "worker", harness: "pi", lifecycle: "running", herdrStatus: "idle", ownership: "current_session", live: true, elapsedMs: 1, taskSynopsis: "task" }, result: {},
  });
  const runtime: UiRuntimeApi = {
    list: async () => ({ ok: true, scope: "current_session", runs: [], counts: {} } as ListToolResult),
    inspectUi: async () => { throw new Error("unused"); },
    send: async (input) => { sends.push(input); return success("send"); },
    interrupt: async () => success("interrupt"),
    stop: async (input) => { stops.push(input); return success("stop"); },
    focusUi: async () => options.focus ?? { ok: true },
  };
  const ctx = {
    cwd: "/parent", signal: undefined,
    ui: {
      confirm: async () => confirms.shift() ?? false,
      input: async () => inputs.shift(),
      select: async () => selects.shift(),
      notify: (message: string, type?: string) => notifications.push({ message, ...(type === undefined ? {} : { type }) }),
    },
  } as unknown as ExtensionCommandContext;
  return { actions: new OverlayActions(runtime, ctx), stops, sends, notifications };
}

test("stop and cleanup require explicit confirmation and review evidence", async () => {
  const declined = fixture({ confirms: [false] });
  await declined.actions.stop("run-1", true);
  assert.deepEqual(declined.stops, []);

  const noReview = fixture({ confirms: [true], inputs: [undefined] });
  await noReview.actions.cleanup("run-1");
  assert.deepEqual(noReview.stops, []);
  assert.match(noReview.notifications[0]?.message ?? "", /review evidence is required/);
});

test("safe cleanup forwards bounded human review and objective evidence without authorizing discard", async () => {
  const value = fixture({ confirms: [true], inputs: ["Reviewed diff and tests"], selects: ["No child changes"] });
  await value.actions.cleanup("run-1");
  assert.deepEqual(value.stops, [{
    id: "run-1", mode: "graceful", cleanup: "remove_if_safe", parentReview: "Reviewed diff and tests", integration: { kind: "no_changes" },
  }]);
});

test("send trims input and focus failures are reported instead of hidden", async () => {
  const value = fixture({ inputs: ["  follow up  "], focus: { ok: false, reason: "stale terminal" } });
  await value.actions.send("run-1");
  assert.deepEqual(value.sends, [{ id: "run-1", message: "follow up" }]);
  await value.actions.focusAfterOverlayClosed("run-1");
  assert.match(value.notifications.at(-1)?.message ?? "", /stale terminal/);
  assert.equal(value.notifications.at(-1)?.type, "error");
});
