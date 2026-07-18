import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PROFILES } from "../src/profiles.ts";
import { SubagentRuntime, type ResultDelivery } from "../src/runtime.ts";
import { FakeHerdr } from "./fake-herdr.ts";

const parentSessionId = "parent-session";

function assistant(texts: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: texts.map((text) => ({ type: "text", text })),
    api: "openai-responses",
    provider: "test",
    model: "model",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function launch(client: FakeHerdr): { cwd: string; sessionDir: string; sessionId: string } {
  const input = [...client.calls].reverse().find(({ method }) => method === "agent.start")?.input as Record<string, unknown>;
  const argv = input.argv as string[];
  return {
    cwd: String(input.cwd),
    sessionDir: argv[argv.indexOf("--session-dir") + 1]!,
    sessionId: argv[argv.indexOf("--session-id") + 1]!,
  };
}

async function appendResult(client: FakeHerdr, text: string[]): Promise<string> {
  const facts = launch(client);
  await mkdir(facts.sessionDir, { recursive: true });
  const listed = (await SessionManager.list(facts.cwd, facts.sessionDir)).find(({ id }) => id === facts.sessionId);
  const manager = listed
    ? SessionManager.open(listed.path, facts.sessionDir, facts.cwd)
    : SessionManager.create(facts.cwd, facts.sessionDir, { id: facts.sessionId });
  manager.appendMessage({ role: "user", content: "input", timestamp: Date.now() });
  return manager.appendMessage(assistant(text));
}

async function eventually(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function fixture(
  run: (client: FakeHerdr, runtime: SubagentRuntime, deliveries: ResultDelivery[], agentDir: string) => Promise<void>,
  ids: string[] = ["run-reader"],
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "runtime-agent-"));
  const client = new FakeHerdr();
  const deliveries: ResultDelivery[] = [];
  const runtime = new SubagentRuntime(client, { workspaceId: "w-parent", agentDir }, {
    idFactory: () => ids.shift() ?? "run-extra",
    instanceIdFactory: () => "instance-current",
    readinessTimeoutMs: 30,
    pollIntervalMs: 1,
    cleanupTimeoutMs: 30,
    gitStatus: async () => "",
    appendState: () => {},
    deliverResult: (message) => deliveries.push(message),
  });
  await runtime.bindParent({
    parentSessionId,
    parentSessionFile: "/tmp/parent-session.jsonl",
    parentEntryId: "parent-leaf",
  }, [], "startup");
  try { await run(client, runtime, deliveries, agentDir); }
  finally {
    for (const current of [...runtime.runs.values()]) {
      try { await runtime.stop(current.id); } catch { /* test cleanup best effort */ }
    }
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("background start launches a deterministic persistent child and steers one exact result", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "working", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["complete ", "answer"]); };
    const started = await runtime.start("scout", "inspect this", "/repo");
    assert.equal(started.generation?.delivery, "pending");
    const input = client.calls.find(({ method }) => method === "agent.start")?.input as Record<string, unknown>;
    assert.deepEqual(input.argv, [
      "pi", "--session-dir", `${input.argv instanceof Array ? input.argv[2] : ""}`, "--session-id", "herdr-run-reader",
      "--name", "scout-n-reader", "--thinking", "low", "--tools", "read,grep,find,ls",
      "--append-system-prompt", PROFILES.scout.systemPrompt,
    ]);
    assert.equal(input.cwd, "/repo");
    await eventually(() => deliveries.length === 1);
    const delivered = deliveries[0]!;
    assert.equal(delivered.content.includes("complete answer"), true);
    assert.equal(delivered.content.includes("Reader reminder"), true);
    assert.deepEqual(delivered.details, {
      parentSessionId,
      runId: "run-reader",
      profile: "scout",
      generation: 1,
      childSessionId: "herdr-run-reader",
      childEntryId: runtime.status("run-reader").latestResult?.childEntryId,
    });
    assert.equal(runtime.status("run-reader").generation?.delivery, "queued");
    assert.equal(runtime.confirmDelivery({ role: "custom", customType: "other", details: delivered.details }), false);
    assert.equal(runtime.confirmDelivery({ role: "custom", customType: delivered.customType, details: { ...delivered.details, generation: 2 } }), false);
    assert.equal(runtime.confirmDelivery({ role: "custom", customType: delivered.customType, details: delivered.details }), true);
    assert.equal(runtime.status("run-reader").generation?.delivery, "delivered");
  });
});

test("path session readiness accepts only the normalized deterministic Pi session path", async (context) => {
  await context.test("matching path", async () => fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    client.agentSessionForStart = (input, sessionId) => {
      const argv = input.argv as string[];
      const sessionDir = argv[argv.indexOf("--session-dir") + 1]!;
      return {
        agent: "pi",
        kind: "path",
        value: join(sessionDir, "discarded", "..", `2026-04-01T10-20-30-456Z_${sessionId}.jsonl`),
      };
    };
    const started = await runtime.start("scout", "task", "/repo");
    assert.equal(started.lifecycle, "live");
    assert.equal(client.calls.filter(({ method }) => method === "pane.send_input").length, 1);
  }));

  for (const mismatch of ["outside directory", "wrong filename"] as const) {
    await context.test(mismatch, async () => fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      client.agentSessionForStart = (input, sessionId) => {
        const argv = input.argv as string[];
        const sessionDir = argv[argv.indexOf("--session-dir") + 1]!;
        const validName = `2026-04-01T10-20-30-456Z_${sessionId}.jsonl`;
        return {
          agent: "pi",
          kind: "path",
          value: mismatch === "outside directory"
            ? join(dirname(sessionDir), validName)
            : join(sessionDir, `not-a-pi-timestamp_${sessionId}.jsonl`),
        };
      };
      await assert.rejects(runtime.start("scout", "task", "/repo"), /Pi readiness timed out/);
      assert.equal(client.calls.some(({ method }) => method === "pane.send_input"), false);
    }));
  }
});

test("blocking start returns the complete structured result without automatic delivery", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["all ", "text"]); };
    const result = await runtime.start("researcher", "research", "/repo", { wait: true, timeoutMs: 100 });
    assert.equal(result.latestResult?.text, "all text");
    assert.equal(result.resultContent?.includes("all text"), true);
    assert.equal(result.resultContent?.includes("run_id=\"run-reader\""), true);
    assert.equal(result.generation?.delivery, "delivered");
    assert.equal(deliveries.length, 0);
  });
});

test("blocking timeout releases only the waiter and completion continues in background", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle"];
    await assert.rejects(
      runtime.start("scout", "slow", "/repo", { wait: true, timeoutMs: 5 }),
      /run id=run-reader generation=1 remains pending/,
    );
    assert.equal(runtime.status("run-reader").generation?.blockingWaiter, false);
    await appendResult(client, ["late result"]);
    await eventually(() => deliveries.length === 1);
    assert.equal(deliveries[0]?.content.includes("late result"), true);
  });
});

test("follow-ups use a fresh active-branch baseline and reject an undelivered generation", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["first"]); };
    const first = await runtime.start("scout", "one", "/repo", { wait: true, timeoutMs: 100 });
    const firstEntry = first.latestResult?.childEntryId;
    client.onSendInput = async () => { await appendResult(client, ["second"]); };
    const second = await runtime.send(first.id, "two", { wait: true, timeoutMs: 100 });
    assert.equal(second.generation?.number, 2);
    assert.equal(second.generation?.baselineEntryId, firstEntry);
    assert.equal(second.latestResult?.text, "second");
    assert.notEqual(second.latestResult?.childEntryId, firstEntry);

    client.onSendInput = async () => { await appendResult(client, ["third"]); };
    await runtime.send(first.id, "three");
    await eventually(() => deliveries.length === 1);
    await assert.rejects(runtime.send(first.id, "too soon"), /generation 3 in queued state/);
  });
});

test("ownership, uncertain input, fresh startup cleanup, and once-only stop preserve exact facts", async (context) => {
  await context.test("foreign current parent", async () => fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    await runtime.start("scout", "task", "/repo");
    assert.throws(() => runtime.status("run-reader", { parentSessionId: "foreign-parent" }), /does not own this runtime/);
    await assert.rejects(runtime.send("run-reader", "x", { parentSessionId: "foreign-parent" }), /does not own this runtime/);
  }));

  await context.test("uncertain initial send", async () => fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    client.failSendInput = true;
    await assert.rejects(runtime.start("scout", "task", "/repo"), /retained current run id=run-reader/);
    assert.equal(runtime.list().length, 1);
  }));

  await context.test("startup cancellation cleanup signal", async () => fixture(async (client, runtime) => {
    client.hangGetAgent = true;
    const caller = new AbortController();
    const pending = runtime.start("scout", "task", "/repo", { signal: caller.signal });
    caller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    const cleanupCalls = client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close");
    assert.equal(cleanupCalls.length, 2);
    assert.equal(cleanupCalls.every(({ signal }) => signal !== caller.signal && signal?.aborted === false), true);
    assert.deepEqual(runtime.list(), []);
  }));

  await context.test("stop race", async () => fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    await runtime.start("scout", "task", "/repo");
    const [one, two] = await Promise.all([runtime.stop("run-reader"), runtime.stop("run-reader")]);
    assert.deepEqual(one, two);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "tab.close").length, 1);
    assert.deepEqual(runtime.list(), []);
  }));
});

test("pre-run worker agent-start failure removes the clean worktree but reports its retained branch", async () => {
  await fixture(async (client, runtime) => {
    client.failStartAgent = true;
    const failure = await runtime.start("worker", "task", process.cwd()).then(() => "", (error) => String(error));
    assert.match(failure, /agent start failed/);
    assert.match(failure, /retained branch=herdr-subagents\/run-worker-pre-run/);
    assert.equal(failure.includes("worktree="), false);
    assert.deepEqual(client.calls.map(({ method }) => method), [
      "worktree.create", "agent.start", "worktree.remove",
    ]);
    assert.deepEqual(client.calls.at(-1)?.input, { workspaceId: "w-worker", force: false });
    assert.deepEqual(runtime.list(), []);
  }, ["run-worker-pre-run"]);
});

test("startup cleanup retains session storage when reader or worker stop cannot be established", async (context) => {
  await context.test("reader pane and tab failures", async () => fixture(async (client, runtime) => {
    client.hangGetAgent = true;
    client.failClosePane = true;
    client.failCloseTab = true;
    const caller = new AbortController();
    const pending = runtime.start("scout", "task", "/repo", { signal: caller.signal });
    await eventually(() => client.calls.some(({ method }) => method === "agent.get"));
    const sessionDir = launch(client).sessionDir;
    await mkdir(sessionDir, { recursive: true });
    caller.abort(new Error("cancelled"));
    await assert.rejects(pending, (error) => String(error).includes(`sessionDir=${sessionDir}`));
    assert.equal(existsSync(sessionDir), true);
  }));

  await context.test("worker pane and worktree-removal failures", async () => fixture(async (client, runtime) => {
    client.hangGetAgent = true;
    client.failClosePane = true;
    client.failRemoveWorktree = true;
    const caller = new AbortController();
    const pending = runtime.start("worker", "task", process.cwd(), { signal: caller.signal });
    await eventually(() => client.calls.some(({ method }) => method === "agent.get"));
    const sessionDir = launch(client).sessionDir;
    const worktreePath = String((client.calls.find(({ method }) => method === "worktree.create")?.input as Record<string, unknown>).path);
    await mkdir(sessionDir, { recursive: true });
    caller.abort(new Error("cancelled"));
    await assert.rejects(pending, /retained .*worktree=.*sessionDir=/);
    assert.equal(existsSync(sessionDir), true);
    await rm(worktreePath, { recursive: true, force: true });
  }, ["run-worker-startup-cleanup"]));
});

test("normal stop retains session storage when reader or worker stop cannot be established", async (context) => {
  await context.test("reader pane and tab failures", async () => fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "task", "/repo");
    await mkdir(started.childSessionDir, { recursive: true });
    client.failClosePane = true;
    client.failCloseTab = true;
    const stopped = await runtime.stop(started.id);
    assert.equal(stopped.retained.includes(`sessionDir=${started.childSessionDir}`), true);
    assert.equal(existsSync(started.childSessionDir), true);
  }));

  await context.test("worker pane and worktree-removal failures", async () => fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    const started = await runtime.start("worker", "task", process.cwd());
    await mkdir(started.childSessionDir, { recursive: true });
    client.failClosePane = true;
    client.failRemoveWorktree = true;
    const stopped = await runtime.stop(started.id);
    assert.equal(stopped.retained.includes(`sessionDir=${started.childSessionDir}`), true);
    assert.equal(existsSync(started.childSessionDir), true);
    await rm(started.worktree!.path, { recursive: true, force: true });
  }, ["run-worker-stop-cleanup"]));
});

test("successful enclosing cleanup clears stale pane and session retention", async (context) => {
  for (const profile of ["scout", "worker"] as const) {
    await context.test(`startup ${profile}`, async () => fixture(async (client, runtime) => {
      client.hangGetAgent = true;
      client.failClosePane = true;
      const caller = new AbortController();
      const cwd = profile === "worker" ? process.cwd() : "/repo";
      const pending = runtime.start(profile, "task", cwd, { signal: caller.signal });
      await eventually(() => client.calls.some(({ method }) => method === "agent.get"));
      const sessionDir = launch(client).sessionDir;
      const worktreePath = profile === "worker"
        ? String((client.calls.find(({ method }) => method === "worktree.create")?.input as Record<string, unknown>).path)
        : undefined;
      await mkdir(sessionDir, { recursive: true });
      caller.abort(new Error("cancelled"));
      const failure = await pending.then(() => "", (error) => String(error));
      assert.equal(failure.includes("pane="), false);
      assert.equal(failure.includes("sessionDir="), false);
      assert.equal(existsSync(sessionDir), false);
      if (worktreePath) await rm(worktreePath, { recursive: true, force: true });
    }, [`run-${profile}-startup-enclosing`]));

    await context.test(`normal stop ${profile}`, async () => fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      const cwd = profile === "worker" ? process.cwd() : "/repo";
      const started = await runtime.start(profile, "task", cwd);
      await mkdir(started.childSessionDir, { recursive: true });
      client.failClosePane = true;
      const stopped = await runtime.stop(started.id);
      if (profile === "worker") {
        assert.equal(stopped.run.lifecycle, "retained");
        assert.deepEqual(stopped.retained, [
          `branch=${started.worktree!.branch}`,
          `sessionDir=${started.childSessionDir}`,
        ]);
        assert.equal(existsSync(started.childSessionDir), true);
        assert.equal(runtime.list().length, 1);
      } else {
        assert.deepEqual(stopped.retained, []);
        assert.equal(stopped.run.lifecycle, "closed");
        assert.equal(existsSync(started.childSessionDir), false);
        assert.deepEqual(runtime.list(), []);
      }
      if (started.worktree) await rm(started.worktree.path, { recursive: true, force: true });
    }, [`run-${profile}-stop-enclosing`]));
  }
});

test("independent reader starts coexist", async () => {
  await fixture(async (client, runtime) => {
    client.statuses = ["idle", "idle"];
    await runtime.start("scout", "one", "/repo");
    client.statuses = ["idle", "idle"];
    await runtime.start("researcher", "two", "/repo");
    assert.deepEqual(runtime.list().map(({ id }) => id), ["run-one", "run-two"]);
  }, ["run-one", "run-two"]);
});

test("every blocking worker result repeats checkout, branch, owner, and safe cleanup warnings", async () => {
  await fixture(async (client, runtime) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["worker result"]); };
    const result = await runtime.start("worker", "change one file", process.cwd(), { wait: true, timeoutMs: 100 });
    assert.equal(result.resultContent?.includes("worker result"), true);
    assert.equal(result.resultContent?.includes(`Worker checkout: ${result.worktree?.path}`), true);
    assert.equal(result.resultContent?.includes(`Generated branch: ${result.worktree?.branch}`), true);
    assert.equal(result.resultContent?.includes(`Parent owner: ${parentSessionId}`), true);
    assert.equal(result.resultContent?.includes("branch is always retained"), true);
    const path = result.worktree!.path;
    const stopped = await runtime.stop(result.id);
    assert.equal(stopped.run.lifecycle, "closed");
    assert.deepEqual(stopped.retained, [`branch=${result.worktree!.branch}`]);
    assert.equal(stopped.workerCleanup?.removed, true);
    const cleanupMethods = client.calls
      .filter(({ method }) => method === "pane.close" || method === "worktree.remove")
      .map(({ method }) => method);
    assert.deepEqual(cleanupMethods, ["pane.close", "worktree.remove"]);
    assert.equal(existsSync(result.childSessionDir), false);
    await rm(path, { recursive: true, force: true });
  }, ["run-worker-warning"]);
});
