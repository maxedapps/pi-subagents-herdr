import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionToolResult, ListToolResult } from "../../src/tools/contracts.ts";
import type { StopToolInput } from "../../src/tools/schemas.ts";
import { OverlayActions, type UiRuntimeApi } from "../../src/ui/actions.ts";

function fixture(options: {
  confirms?: boolean[];
  focus?: { ok: boolean; reason?: string };
  stopResult?: { stopped: boolean; reason?: string };
} = {}) {
  const confirms = [...(options.confirms ?? [])];
  const stops: StopToolInput[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const runtime: UiRuntimeApi = {
    list: async () => ({ ok: true, scope: "current_session", runs: [], counts: {} } as ListToolResult),
    stop: async (input) => {
      stops.push(input);
      return {
        ok: true,
        action: "stop",
        run: { id: "run-1", profile: "worker", harness: "pi", lifecycle: options.stopResult?.stopped === false ? "running" : "stopped", herdrStatus: "idle", ownership: "current_session", live: options.stopResult?.stopped === false, elapsedMs: 1, taskSynopsis: "task" },
        result: options.stopResult ?? { stopped: true },
      } as ActionToolResult;
    },
    focusUi: async () => options.focus ?? { ok: true },
  };
  const ctx = {
    cwd: "/parent", signal: undefined,
    ui: {
      confirm: async (title: string, message: string) => { confirmations.push({ title, message }); return confirms.shift() ?? false; },
      notify: (message: string, type?: string) => notifications.push({ message, ...(type === undefined ? {} : { type }) }),
    },
  } as unknown as ExtensionCommandContext;
  return { actions: new OverlayActions(runtime, ctx), stops, confirmations, notifications };
}

test("graceful UI stop requests automatic safe cleanup only after confirmation", async () => {
  const declined = fixture({ confirms: [false] });
  await declined.actions.stopAfterOverlayClosed("run-1");
  assert.deepEqual(declined.stops, []);

  const accepted = fixture({ confirms: [true] });
  await accepted.actions.stopAfterOverlayClosed("run-1");
  assert.deepEqual(accepted.stops, [{ id: "run-1", mode: "graceful" }]);
  assert.match(accepted.confirmations[0]?.message ?? "", /child process\/session will end/i);
  assert.match(accepted.confirmations[0]?.message ?? "", /removed automatically only when clean/i);
  assert.match(accepted.confirmations[0]?.message ?? "", /action-required notice/i);
});

test("not-stopped is a warning with the runtime reason, never Stop completed", async () => {
  const value = fixture({ confirms: [true], stopResult: { stopped: false, reason: "Graceful exit timed out; pane retained" } });
  await value.actions.stopAfterOverlayClosed("run-1");
  assert.deepEqual(value.notifications, [{ message: "Graceful exit timed out; pane retained", type: "warning" }]);
  assert.doesNotMatch(value.notifications[0]!.message, /completed/i);
});

test("focus uncertainty is reported as a warning after the overlay closes", async () => {
  const value = fixture({ focus: { ok: false, reason: "Focus outcome uncertain; it may have succeeded" } });
  await value.actions.focusAfterOverlayClosed("run-1");
  assert.match(value.notifications[0]?.message ?? "", /may have succeeded/);
  assert.equal(value.notifications[0]?.type, "warning");
});
