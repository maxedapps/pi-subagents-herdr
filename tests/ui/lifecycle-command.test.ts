import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ActionToolResult, ListToolResult } from "../../src/tools/contracts.ts";
import type { UiRuntimeApi } from "../../src/ui/actions.ts";
import { HerdrSubagentsUiSession } from "../../src/ui/index.ts";
import { SubagentsOverlay } from "../../src/ui/overlay.ts";
import { adaptiveRefreshDelay, type DashboardRun } from "../../src/ui/status.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const owned: DashboardRun = {
  id: "run-owned", profile: "scout", harness: "pi", lifecycle: "running", herdrStatus: "working", ownership: "current_session",
  live: true, elapsedMs: 2_000, taskSynopsis: "Inspect UI", terminalId: "term-owned", agentRevision: 2,
};
const listed: ListToolResult = { ok: true, scope: "current_session", runs: [owned], counts: { working: 1 } };

function stopSuccess(): ActionToolResult {
  return { ok: true, action: "stop", run: { ...owned, lifecycle: "stopped", live: false }, result: { stopped: true, reason: "stopped" } };
}

function runtime(overrides: Partial<UiRuntimeApi & { subscribeUi(listener: () => void): () => void; widgetVisibility(): "auto" | "always" | "never" }> = {}) {
  let listener: (() => void) | undefined;
  const base = {
    list: async () => listed,
    stop: async () => stopSuccess(),
    focusUi: async () => ({ ok: true }),
    subscribeUi: (next: () => void) => { listener = next; return () => { listener = undefined; }; },
    widgetVisibility: () => "auto" as const,
    ...overrides,
  };
  return { value: base, emit: () => listener?.(), subscribed: () => listener !== undefined };
}

test("persistent UI installs only for owned visible runs and cleans up idempotently", async () => {
  const statuses: Array<string | undefined> = [];
  const widgets: unknown[] = [];
  const fake = runtime();
  const context = {
    mode: "tui",
    ui: {
      theme,
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      setWidget: (_key: string, value: unknown) => widgets.push(value),
    },
  } as unknown as ExtensionContext;
  const session = new HerdrSubagentsUiSession(fake.value);
  await session.start(context);
  assert.equal(fake.subscribed(), true);
  assert.match(statuses.at(-1) ?? "", /working/);
  assert.equal(typeof widgets.at(-1), "function");
  fake.emit();
  await new Promise((resolve) => setImmediate(resolve));
  await session.stop();
  await session.stop();
  assert.equal(fake.subscribed(), false);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
});

function commandContext(key: string, onClosed?: () => void, confirm = true): ExtensionCommandContext {
  return {
    mode: "tui", cwd: "/tmp", signal: undefined,
    ui: {
      theme,
      notify: () => undefined,
      confirm: async () => confirm,
      setStatus: () => undefined,
      setWidget: () => undefined,
      custom: <T>(factory: (tui: { requestRender(): void }, theme: Theme, kb: unknown, done: (value: T) => void) => Component) => new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, {}, (value) => { onClosed?.(); resolve(value); });
        component.handleInput?.(key);
      }),
    },
  } as unknown as ExtensionCommandContext;
}

test("focus runs only after the overlay promise has closed", async () => {
  let overlayClosed = false;
  let focused = false;
  const fake = runtime({
    focusUi: async () => {
      assert.equal(overlayClosed, true, "focus must not run while overlay owns input");
      focused = true;
      return { ok: true, attentionChanged: true };
    },
  });
  const session = new HerdrSubagentsUiSession(fake.value);
  await session.command("", commandContext("\r", () => { overlayClosed = true; }));
  assert.equal(focused, true);
  await session.stop();
});

test("graceful stop confirmation and mutation run only after the overlay closes", async () => {
  let overlayClosed = false;
  let stopped = false;
  const fake = runtime({
    stop: async (input) => {
      assert.equal(overlayClosed, true, "stop must not run while overlay owns input");
      assert.deepEqual(input, { id: "run-owned", mode: "graceful", cleanup: "retain" });
      stopped = true;
      return stopSuccess();
    },
  });
  const session = new HerdrSubagentsUiSession(fake.value);
  await session.command("", commandContext("x", () => { overlayClosed = true; }));
  assert.equal(stopped, true);
  await session.stop();
});

test("subscription changes refresh the current-owned overlay while preserving selection by run id", async () => {
  const second = { ...owned, id: "run-second", terminalId: "term-second" };
  let runs: DashboardRun[] = [owned, second];
  let listener: (() => void) | undefined;
  let component: SubagentsOverlay | undefined;
  let close: (() => void) | undefined;
  const value = {
    list: async () => ({ ok: true, scope: "current_session", runs, counts: {} } as ListToolResult),
    stop: async () => stopSuccess(),
    focusUi: async () => ({ ok: true }),
    subscribeUi: (next: () => void) => { listener = next; return () => { listener = undefined; }; },
    widgetVisibility: () => "auto" as const,
  };
  const context = {
    mode: "tui", cwd: "/tmp", signal: undefined,
    ui: {
      theme, notify: () => undefined, confirm: async () => false,
      setStatus: () => undefined, setWidget: () => undefined,
      custom: <T>(factory: (tui: { requestRender(): void }, theme: Theme, kb: unknown, done: (result: T) => void) => Component) => new Promise<T>((resolve) => {
        component = factory({ requestRender() {} }, theme, {}, resolve) as SubagentsOverlay;
        close = () => component?.handleInput?.("\x1b");
      }),
    },
  } as unknown as ExtensionCommandContext;
  const session = new HerdrSubagentsUiSession(value);
  await session.start(context);
  const command = session.command("", context);
  await new Promise((resolve) => setImmediate(resolve));
  component?.handleInput?.("\x1b[B");
  assert.equal(component?.selection.selectedId, "run-second");
  runs = [second, owned];
  listener?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(component?.selection.selectedId, "run-second");
  close?.();
  await command;
  await session.stop();
});

test("/subagents rejects scopes, has a clear non-TUI fallback, and adaptive refresh suspends when empty", async () => {
  const fake = runtime();
  const notifications: string[] = [];
  const context = { mode: "json", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
  const session = new HerdrSubagentsUiSession(fake.value);
  await session.command("", context);
  assert.match(notifications[0] ?? "", /only in Pi's interactive terminal TUI/);
  const empty = { scope: "current_session", connection: "connected", runs: [], summary: { total: 0, blocked: 0, working: 0, ready: 0, done: 0, idle: 0, unknown: 0, failures: 0 }, updatedAt: 0 } as const;
  assert.equal(adaptiveRefreshDelay(empty), undefined);
  assert.equal(adaptiveRefreshDelay({ ...empty, runs: [owned], summary: { ...empty.summary, total: 1, working: 1 } }), 1_500);

  const tuiNotifications: string[] = [];
  const tui = { mode: "tui", ui: { notify: (message: string) => tuiNotifications.push(message) } } as unknown as ExtensionCommandContext;
  await session.command("global", tui);
  assert.match(tuiNotifications[0] ?? "", /current-session owned runs only/);
});
