import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ASSETS } from "../../src/package-paths.ts";
import extension from "../../extensions/herdr-subagents/index.ts";
import {
  registerHerdrSubagentsExtension,
  type SessionRuntime,
} from "../../src/lifecycle/extension.ts";
import { ACTION_NOTICE_CUSTOM_TYPE } from "../../src/results/action-notices.ts";
import { RESULT_CUSTOM_TYPE } from "../../src/results/contracts.ts";

type Handler = (...args: readonly unknown[]) => unknown;

function fakeApi(): {
  api: ExtensionAPI;
  events: Map<string, Handler>;
  registrations: string[];
  tools: Array<{ name: string }>;
  commands: string[];
  messages: Array<{ message: unknown; options: unknown }>;
  renderers: Map<string, Handler>;
} {
  const events = new Map<string, Handler>();
  const registrations: string[] = [];
  const tools: Array<{ name: string }> = [];
  const commands: string[] = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const renderers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      registrations.push(event);
      events.set(event, handler);
    },
    registerTool(tool: { name: string }) { tools.push(tool); },
    registerCommand(name: string) { commands.push(name); },
    registerMessageRenderer(customType: string, renderer: Handler) { renderers.set(customType, renderer); },
    getAllTools() { return tools; },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
  };
  return { api: api as unknown as ExtensionAPI, events, registrations, tools, commands, messages, renderers };
}

const context = {} as ExtensionContext;

test("lifecycle extension factory registers strict parent tools and lifecycle without starting resources", () => {
  const fake = fakeApi();
  extension(fake.api);
  assert.deepEqual(fake.registrations, [
    "resources_discover",
    "session_start",
    "agent_settled",
    "message_end",

    "session_shutdown",
  ]);
  assert.deepEqual(fake.events.get("resources_discover")?.({}), { skillPaths: [PACKAGE_ASSETS.skill] });
  assert.deepEqual(fake.tools.map((tool) => tool.name), [
    "subagent_start", "subagent_status", "subagent_send", "subagent_interrupt", "subagent_stop",
  ]);
  assert.deepEqual(fake.commands, ["subagents", "subagents-doctor"]);
});

test("lifecycle runtime starts only on session_start and shutdown is idempotent", async () => {
  const fake = fakeApi();
  let created = 0;
  let started = 0;
  let stopped = 0;
  const runtime: SessionRuntime = {
    start() {
      started += 1;
    },
    stop() {
      stopped += 1;
    },
  };
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      created += 1;
      return runtime;
    },
  });
  assert.deepEqual({ created, started, stopped }, { created: 0, started: 0, stopped: 0 });

  const start = fake.events.get("session_start");
  const shutdown = fake.events.get("session_shutdown");
  assert.notEqual(start, undefined);
  assert.notEqual(shutdown, undefined);
  await start?.({}, context);
  await start?.({}, context);
  assert.deepEqual({ created, started, stopped }, { created: 1, started: 1, stopped: 0 });
  await shutdown?.({});
  await shutdown?.({});
  assert.deepEqual({ created, started, stopped }, { created: 1, started: 1, stopped: 1 });
});

test("lifecycle retries after a synchronous runtime factory failure", async () => {
  const fake = fakeApi();
  let attempts = 0;
  let stopped = 0;
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      attempts += 1;
      if (attempts === 1) throw new Error("factory failed");
      return { start() {}, stop() { stopped += 1; } };
    },
  });
  const start = fake.events.get("session_start");
  const shutdown = fake.events.get("session_shutdown");
  await assert.rejects(Promise.resolve(start?.({}, context)), /factory failed/);
  await start?.({}, context);
  await shutdown?.({});
  assert.deepEqual({ attempts, stopped }, { attempts: 2, stopped: 1 });
});

test("lifecycle cleans up a failed runtime start before retrying", async () => {
  const fake = fakeApi();
  let attempts = 0;
  const stopped: number[] = [];
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      attempts += 1;
      const attempt = attempts;
      return {
        start() {
          if (attempt === 1) throw new Error("start failed");
        },
        stop() {
          stopped.push(attempt);
        },
      };
    },
  });
  const start = fake.events.get("session_start");
  const shutdown = fake.events.get("session_shutdown");
  await assert.rejects(Promise.resolve(start?.({}, context)), /start failed/);
  await start?.({}, context);
  await shutdown?.({});
  assert.deepEqual(stopped, [1, 2]);
});

test("concurrent shutdown waits for startup and stops the runtime once", async () => {
  const fake = fakeApi();
  let releaseStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let stopped = 0;
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      return { async start() { await started; }, stop() { stopped += 1; } };
    },
  });
  const start = fake.events.get("session_start");
  const shutdown = fake.events.get("session_shutdown");
  const starting = Promise.resolve(start?.({}, context));
  const stopping = Promise.resolve(shutdown?.({}));
  releaseStart?.();
  await Promise.all([starting, stopping]);
  await shutdown?.({});
  assert.equal(stopped, 1);
});

test("agent_settled notifies delivery queue-drain without status-call reminders", async () => {
  const fake = fakeApi();
  let settled = 0;
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      return {
        start() {},
        stop() {},
        noteParentSettled() { settled += 1; },
      };
    },
  });
  await fake.events.get("session_start")?.({}, context);
  fake.events.get("agent_settled")?.({}, context);
  fake.events.get("agent_settled")?.({}, context);
  assert.equal(settled, 2);
  assert.equal(fake.messages.length, 0, "reminder loop removed; automatic delivery owns follow-ups");
});

test("message_end reconciliation runs after Pi's append continuation", async () => {
  const fake = fakeApi();
  let reconciled = 0;
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      return {
        start() {},
        stop() {},
        reconcileResultPersistence() { reconciled += 1; },
      };
    },
  });
  await fake.events.get("session_start")?.({}, context);
  await fake.events.get("message_end")?.({});
  await Promise.resolve();
  assert.equal(reconciled, 0, "a microtask is still inside Pi's pre-append handler boundary");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reconciled, 1);
  await fake.events.get("session_shutdown")?.({});
});

test("result and action custom messages use separate semantic collapsed renderers", () => {
  const fake = fakeApi();
  registerHerdrSubagentsExtension(fake.api, { environment: {}, createRuntime: () => ({ start() {}, stop() {} }) });
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const resultText = [
    'HERDR_RESULT_V1 {"resultId":"res-1"}',
    "Subagent result for run-1 (scout) generation 1",
    "source=pi-final-assistant",
    "",
    "Child completed the audit",
  ].join("\n");
  const resultRenderer = fake.renderers.get(RESULT_CUSTOM_TYPE)!;
  const collapsedResult = resultRenderer({ content: resultText }, { expanded: false }, theme) as { render(width: number): string[] };
  assert.match(collapsedResult.render(160).join("\n"), /Result received · Child completed the audit/);
  assert.match(collapsedResult.render(160).join("\n"), /Ctrl\+O to expand/);
  const expandedResult = resultRenderer({ content: resultText }, { expanded: true }, theme) as { render(width: number): string[] };
  assert.equal(expandedResult.render(500).map((line) => line.trimEnd()).join("\n"), resultText);

  const actionText = 'HERDR_ACTION_REQUIRED_V1 {"noticeId":"act-1"}\nACTION REQUIRED — cleanup required\nreason=inspect retained files';
  const actionRenderer = fake.renderers.get(ACTION_NOTICE_CUSTOM_TYPE)!;
  const collapsedAction = actionRenderer({ content: actionText }, { expanded: false }, theme) as { render(width: number): string[] };
  assert.match(collapsedAction.render(160).join("\n"), /ACTION REQUIRED — cleanup required/);
  assert.match(collapsedAction.render(160).join("\n"), /reason=inspect retained files/);
});

test("lifecycle child guard registers only the narrow result bridge", () => {
  const fake = fakeApi();
  let created = 0;
  const result = registerHerdrSubagentsExtension(fake.api, {
    environment: {
      PI_HERDR_SUBAGENT: "1",
      PI_HERDR_SUBAGENT_RUN_ID: "run-1",
      PI_HERDR_SUBAGENT_RUN_NONCE: "nonce",
      PI_HERDR_SUBAGENT_RESULT_EXCHANGE: "/tmp/exchange",
    },
    createRuntime() {
      created += 1;
      return { start() {}, stop() {} };
    },
  });
  assert.equal(result.mode, "child");
  assert.deepEqual(result.registeredTools, []);
  assert.deepEqual([...result.registeredEvents].sort(), ["agent_settled", "message_end"]);
  assert.deepEqual(fake.tools, []);
  assert.deepEqual(fake.commands, []);
  assert.equal(created, 0);
});
