import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ASSETS } from "../../src/package-paths.ts";
import extension from "../../extensions/herdr-subagents/index.ts";
import {
  registerHerdrSubagentsExtension,
  type SessionRuntime,
} from "../../src/lifecycle/extension.ts";

type Handler = (...args: readonly unknown[]) => unknown;

function fakeApi(): {
  api: ExtensionAPI;
  events: Map<string, Handler>;
  registrations: string[];
  tools: Array<{ name: string }>;
  commands: string[];
  messages: Array<{ message: unknown; options: unknown }>;
} {
  const events = new Map<string, Handler>();
  const registrations: string[] = [];
  const tools: Array<{ name: string }> = [];
  const commands: string[] = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const api = {
    on(event: string, handler: Handler) {
      registrations.push(event);
      events.set(event, handler);
    },
    registerTool(tool: { name: string }) { tools.push(tool); },
    registerCommand(name: string) { commands.push(name); },
    getAllTools() { return tools; },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
  };
  return { api: api as unknown as ExtensionAPI, events, registrations, tools, commands, messages };
}

const context = {} as ExtensionContext;

test("lifecycle extension factory registers strict parent tools and lifecycle without starting resources", () => {
  const fake = fakeApi();
  extension(fake.api);
  assert.deepEqual(fake.registrations, ["resources_discover", "session_start", "agent_settled", "session_shutdown"]);
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

test("agent_settled sends at most one result-inspection follow-up per claimed generation", async () => {
  const fake = fakeApi();
  let claims = 0;
  registerHerdrSubagentsExtension(fake.api, {
    environment: {},
    createRuntime() {
      return {
        start() {},
        stop() {},
        claimResultInspectionReminders() {
          claims += 1;
          return claims === 1 ? [
            { id: "run-1", generation: 1, timeoutMs: 900_000 },
            { id: "run-2", generation: 1, timeoutMs: 60_000 },
          ] : [];
        },
      };
    },
  });
  await fake.events.get("session_start")?.({}, context);
  fake.events.get("agent_settled")?.({}, context);
  fake.events.get("agent_settled")?.({}, context);
  assert.equal(fake.messages.length, 1);
  assert.deepEqual(fake.messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(JSON.stringify(fake.messages[0]?.message), /run-1.*run-2/);
  assert.match(JSON.stringify(fake.messages[0]?.message), /list call does not inspect results/);
});

test("lifecycle child guard omits all parent registrations", () => {
  const fake = fakeApi();
  let created = 0;
  const result = registerHerdrSubagentsExtension(fake.api, {
    environment: { PI_HERDR_SUBAGENT: "1" },
    createRuntime() {
      created += 1;
      return { start() {}, stop() {} };
    },
  });
  assert.deepEqual(result, { mode: "child", registeredEvents: [], registeredTools: [] });
  assert.deepEqual(fake.registrations, []);
  assert.deepEqual(fake.tools, []);
  assert.deepEqual(fake.commands, []);
  assert.equal(created, 0);
});
