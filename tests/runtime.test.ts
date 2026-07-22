import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { appendArtifactSection } from "../src/artifact.ts";
import { HerdrError, HerdrSubscriptionTransportError } from "../src/herdr.ts";
import { PROFILES } from "../src/profiles.ts";
import { enumerateRecoveryLocators, readRecoveryLocator } from "../src/registry.ts";
import {
  persistAbortedGeneration,
  SubagentRuntime,
  type ActionDelivery,
  type ResultDelivery,
  type RuntimeOptions,
} from "../src/runtime.ts";
import type { ChildSessionObservation, HerdrStateRecord } from "../src/session.ts";
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

async function childSession(client: FakeHerdr): Promise<SessionManager> {
  const facts = launch(client);
  await mkdir(facts.sessionDir, { recursive: true });
  const listed = (await SessionManager.list(facts.cwd, facts.sessionDir)).find(({ id }) => id === facts.sessionId);
  return listed
    ? SessionManager.open(listed.path, facts.sessionDir, facts.cwd)
    : SessionManager.create(facts.cwd, facts.sessionDir, { id: facts.sessionId });
}

async function appendIncompleteSession(client: FakeHerdr): Promise<string> {
  const manager = await childSession(client);
  manager.appendMessage({ role: "user", content: "input", timestamp: Date.now() });
  return manager.getSessionFile()!;
}

async function appendResult(client: FakeHerdr, text: string[]): Promise<string> {
  const manager = await childSession(client);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function controlledDelay() {
  const requested: number[] = [];
  const waits: Array<{ ms: number; release: () => void; settled: boolean }> = [];
  return {
    requested,
    waits,
    sleep(ms: number, signal: AbortSignal): Promise<void> {
      requested.push(ms);
      return new Promise((resolve, reject) => {
        const wait = {
          ms,
          settled: false,
          release: () => {
            if (wait.settled) return;
            wait.settled = true;
            signal.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          if (wait.settled) return;
          wait.settled = true;
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        waits.push(wait);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    release(ms: number): void {
      const wait = waits.find((candidate) => candidate.ms === ms && !candidate.settled);
      assert.ok(wait, `missing pending ${ms}ms delay`);
      wait.release();
    },
  };
}

function observation(id: string, leaf = id, compaction?: string): ChildSessionObservation {
  return {
    childSessionPath: `/tmp/${id}.jsonl`,
    activeLeafId: leaf,
    ...(compaction ? { latestCompactionId: compaction } : {}),
    result: { childEntryId: id, text: `result ${id}`, message: assistant([`result ${id}`]) },
  };
}

function observableSnapshot(runtime: SubagentRuntime): string[] {
  return runtime.list().map((run) => [
    run.id,
    run.lifecycle,
    run.status,
    run.generation ? `g${run.generation.number}:${run.generation.delivery}` : "no-generation",
    run.retained?.join("|") ?? "",
  ].join("/"));
}

async function fixture(
  run: (client: FakeHerdr, runtime: SubagentRuntime, deliveries: ResultDelivery[], agentDir: string, actions: ActionDelivery[]) => Promise<void>,
  ids: string[] = ["run-reader"],
  options: {
    appendState?: NonNullable<RuntimeOptions["appendState"]>;
    appendArtifact?: NonNullable<RuntimeOptions["appendArtifact"]>;
    gitStatus?: NonNullable<RuntimeOptions["gitStatus"]>;
    onRunsChanged?: (runtime: SubagentRuntime) => void;
    runtimeOptions?: Pick<RuntimeOptions, "quietPeriodMs" | "monitorDelay" | "observeChildSession">;
  } = {},
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "runtime-agent-"));
  const client = new FakeHerdr();
  const deliveries: ResultDelivery[] = [];
  const actions: ActionDelivery[] = [];
  let runtime!: SubagentRuntime;
  runtime = new SubagentRuntime(client, { workspaceId: "w-parent", agentDir }, {
    idFactory: () => ids.shift() ?? "run-extra",
    instanceIdFactory: () => "instance-current",
    readinessTimeoutMs: 30,
    pollIntervalMs: 1,
    quietPeriodMs: options.runtimeOptions?.quietPeriodMs ?? 1,
    ...(options.runtimeOptions?.monitorDelay ? { monitorDelay: options.runtimeOptions.monitorDelay } : {}),
    ...(options.runtimeOptions?.observeChildSession
      ? { observeChildSession: options.runtimeOptions.observeChildSession }
      : {}),
    cleanupTimeoutMs: 30,
    gitStatus: options.gitStatus ?? (async () => ""),
    appendState: options.appendState ?? (() => {}),
    ...(options.appendArtifact ? { appendArtifact: options.appendArtifact } : {}),
    deliverResult: (message) => deliveries.push(message),
    deliverAction: (message) => actions.push(message),
    onRunsChanged: () => options.onRunsChanged?.(runtime),
  });
  await runtime.bindParent({
    parentSessionId,
    parentSessionFile: "/tmp/parent-session.jsonl",
    parentEntryId: "parent-leaf",
  }, [], "startup");
  try { await run(client, runtime, deliveries, agentDir, actions); }
  finally {
    for (const current of [...runtime.runs.values()]) {
      try { await runtime.stop(current.id); } catch { /* test cleanup best effort */ }
    }
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("background start launches a deterministic persistent child and steers one exact result", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["complete ", "answer"]); };
    const started = await runtime.start("scout", "inspect this", "/repo");
    assert.equal(started.generation?.delivery, "pending");
    const input = client.calls.find(({ method }) => method === "agent.start")?.input as Record<string, unknown>;
    assert.deepEqual(input.argv, [
      "pi", "--session-dir", `${input.argv instanceof Array ? input.argv[2] : ""}`, "--session-id", "herdr-run-reader",
      "--name", "scout-n-reader", "--thinking", "low", "--tools", "read,grep,find,ls",
      "--append-system-prompt", `${PROFILES.scout.systemPrompt}\n\nArchive: ${started.artifactPath}. The extension writes this file automatically. Never edit it. After compaction or uncertainty, read it before relying on earlier parent instructions or your prior results.`,
    ]);
    assert.equal(input.cwd, "/repo");
    await eventually(() => deliveries.length === 1);
    const delivered = deliveries[0]!;
    assert.equal(delivered.content.includes("complete answer"), true);
    assert.equal(delivered.content.includes(`Durable recovery artifact (read after compaction): ${started.artifactPath}`), true);
    assert.equal(delivered.content.includes("Reader reminder"), true);
    assert.deepEqual(delivered.details, {
      parentSessionId,
      runId: "run-reader",
      artifactPath: started.artifactPath,
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

test("artifact writes precede execution and readiness, survive child cleanup, and stay concise", async () => {
  const order: string[] = [];
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => {
      order.push("send");
      await appendResult(client, ["line one\n", "line two"]);
    };
    const started = await runtime.start("scout", "exact\nparent task", "/repo");
    await eventually(() => deliveries.length === 1);
    assert.ok(order.indexOf("artifact-parent") < order.indexOf("send"));
    assert.ok(order.indexOf("artifact-result") < order.indexOf("result-ready"));
    assert.equal(started.artifactPath.endsWith("/herdr-subagent-artifacts/parent-session/run-reader.md"), true);
    const delivery = deliveries[0]!;
    assert.equal(delivery.details.artifactPath, started.artifactPath);
    assert.equal(runtime.confirmDelivery({ role: "custom", ...delivery }), true);
    const stopped = await runtime.stop(started.id);
    assert.equal(stopped.run.lifecycle, "closed");
    assert.equal(existsSync(started.childSessionDir), false);
    const artifact = await readFile(started.artifactPath, "utf8");
    assert.match(artifact, /## Generation 1 — Parent\n```text\nexact\nparent task\n```/);
    assert.match(artifact, /## Generation 1 — Subagent\n```text\nline one\nline two\n```/);
    assert.doesNotMatch(artifact, /thinking|response-metadata|childEntryId/);
  }, ["run-reader"], {
    appendArtifact: async (identity, section, operations) => {
      order.push(section.includes("— Subagent") ? "artifact-result" : "artifact-parent");
      await appendArtifactSection(identity, section, operations);
    },
    appendState: (_customType, record) => {
      if (record.state === "result_ready") order.push("result-ready");
    },
  });
});

test("input artifact failure prevents Herdr input and uses startup cleanup", async () => {
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    await assert.rejects(runtime.start("scout", "must not execute", "/repo"), /Artifact persistence failed/);
    assert.equal(client.calls.some(({ method }) => method === "pane.send_input"), false);
    assert.deepEqual(runtime.list(), []);
  }, ["run-reader"], {
    appendArtifact: async () => { throw new Error("archive unavailable"); },
  });
});

test("aborted generation persistence is artifact-first and retry-safe after journal failure", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "runtime-abort-"));
  const identity = { agentDir, parentSessionId, runId: "run-abort" };
  const generation: { number: number; outcome?: "aborted" } = { number: 2 };
  const order: string[] = [];
  let failArtifact = true;
  let failJournal = true;
  const persist = () => persistAbortedGeneration(
    generation,
    async (section) => {
      order.push("artifact");
      if (failArtifact) throw new Error("abort artifact failed");
      await appendArtifactSection(identity, section);
    },
    () => {
      order.push("stopping-journal");
      assert.equal(generation.outcome, "aborted");
      if (failJournal) throw new Error("abort journal failed");
    },
  );

  try {
    await assert.rejects(persist(), /abort artifact failed/);
    assert.deepEqual(order, ["artifact"]);
    assert.equal(Object.hasOwn(generation, "outcome"), false);

    failArtifact = false;
    order.length = 0;
    await assert.rejects(persist(), /abort journal failed/);
    assert.deepEqual(order, ["artifact", "stopping-journal"]);
    assert.equal(Object.hasOwn(generation, "outcome"), false);

    failJournal = false;
    order.length = 0;
    await persist();
    assert.deepEqual(order, ["artifact", "stopping-journal"]);
    assert.equal(generation.outcome, "aborted");
    const artifact = await readFile(join(
      agentDir,
      "herdr-subagent-artifacts",
      parentSessionId,
      "run-abort.md",
    ), "utf8");
    assert.equal(artifact.match(/## Generation 2 — Aborted/g)?.length, 1);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("ordinary stop retains a no-result reader and explicit discard records one abort before session removal", async () => {
  const outcomes: Array<"aborted" | undefined> = [];
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "task", "/repo");
    await appendIncompleteSession(client);

    const ordinary = await runtime.stop(started.id);
    assert.equal(ordinary.run.lifecycle, "retained");
    assert.equal(ordinary.run.generation?.outcome, undefined);
    assert.deepEqual(ordinary.retained, [`sessionDir=${started.childSessionDir}`]);
    assert.equal(existsSync(started.childSessionDir), true);
    assert.match(
      await readFile(started.artifactPath, "utf8"),
      /discardIncompleteResult: true.*raced complete result is recovered first/s,
    );

    const discarded = await runtime.stop(started.id, { discardIncompleteResult: true });
    assert.equal(discarded.run.lifecycle, "closed");
    assert.equal(discarded.run.generation?.outcome, "aborted");
    assert.deepEqual(discarded.retained, []);
    assert.equal(existsSync(started.childSessionDir), false);
    assert.deepEqual(deliveries, []);
    assert.equal(outcomes.includes("aborted"), true);
    const artifact = await readFile(started.artifactPath, "utf8");
    assert.equal(artifact.match(/## Generation 1 — Aborted/g)?.length, 1);
    assert.doesNotMatch(artifact, /## Generation 1 — Subagent/);
  }, ["run-reader-discard"], {
    appendState: (_customType, record) => {
      if (record.state === "stopping") outcomes.push(record.generation?.outcome);
    },
  });
});

test("explicit discard recovers a raced final result once instead of aborting it", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "task", "/repo");
    const childEntryId = await appendResult(client, ["raced result"]);

    const stopped = await runtime.stop(started.id, { discardIncompleteResult: true });
    assert.equal(stopped.run.lifecycle, "closed");
    assert.equal(stopped.run.latestResult?.childEntryId, childEntryId);
    assert.equal(stopped.run.latestResult?.text, "raced result");
    assert.equal(stopped.run.generation?.delivery, "delivered");
    assert.equal(stopped.run.generation?.returned, true);
    assert.equal(stopped.run.generation?.outcome, undefined);
    assert.equal(stopped.run.resultContent?.includes("raced result"), true);
    assert.deepEqual(deliveries, []);
    assert.equal(existsSync(started.childSessionDir), false);
    const artifact = await readFile(started.artifactPath, "utf8");
    assert.equal(artifact.match(/## Generation 1 — Subagent/g)?.length, 1);
    assert.doesNotMatch(artifact, /— Aborted/);
  }, ["run-reader-race"]);
});

test("discard reconciliation failures remain retryable and never authorize session removal", async (context) => {
  await context.test("invalid session observation", async () => {
    let observations = 0;
    await fixture(async (client, runtime) => {
      client.autoAcknowledgeSubscriptions = false;
      client.statuses = ["idle"];
      const started = await runtime.start("scout", "task", "/repo");
      await mkdir(started.childSessionDir, { recursive: true });
      const stopped = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(stopped.run.lifecycle, "retained");
      assert.match(stopped.run.error ?? "", /Incomplete result reconciliation failed: malformed session/);
      assert.equal(stopped.run.generation?.outcome, undefined);
      assert.equal(existsSync(started.childSessionDir), true);
      assert.equal(observations, 1);
    }, ["run-reader-invalid"], {
      runtimeOptions: {
        observeChildSession: async () => {
          observations++;
          throw new Error("malformed session");
        },
      },
    });
  });

  await context.test("abort artifact and journal failures", async () => {
    let failArtifact = true;
    let failJournal = true;
    await fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      const started = await runtime.start("scout", "task", "/repo");
      await appendIncompleteSession(client);

      const artifactFailure = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(artifactFailure.run.lifecycle, "retained");
      assert.match(artifactFailure.run.error ?? "", /Abort persistence failed:.*abort artifact failed/);
      assert.equal(artifactFailure.run.generation?.outcome, undefined);
      assert.equal(existsSync(started.childSessionDir), true);

      failArtifact = false;
      const journalFailure = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(journalFailure.run.lifecycle, "retained");
      assert.match(journalFailure.run.error ?? "", /Abort persistence failed: Abort journal persistence failed: abort journal failed/);
      assert.equal(journalFailure.run.generation?.outcome, undefined);
      assert.equal(existsSync(started.childSessionDir), true);

      failJournal = false;
      const recovered = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(recovered.run.lifecycle, "closed");
      assert.equal(recovered.run.generation?.outcome, "aborted");
      assert.equal(existsSync(started.childSessionDir), false);
      assert.equal((await readFile(started.artifactPath, "utf8")).match(/— Aborted/g)?.length, 1);
    }, ["run-reader-abort-failures"], {
      appendArtifact: async (identity, section, operations) => {
        if (failArtifact && section.includes("— Aborted")) throw new Error("abort artifact failed");
        await appendArtifactSection(identity, section, operations);
      },
      appendState: (_customType, record) => {
        if (failJournal && record.state === "stopping" && record.generation?.outcome === "aborted") {
          throw new Error("abort journal failed");
        }
      },
    });
  });
});

test("successful enclosing cleanup can prove stop before explicit reader or worker discard", async (context) => {
  for (const profile of ["scout", "worker"] as const) {
    await context.test(profile, async () => fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      const started = await runtime.start(profile, "task", profile === "worker" ? process.cwd() : "/repo");
      await appendIncompleteSession(client);
      client.failClosePane = true;
      const stopped = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(stopped.run.lifecycle, "closed");
      assert.equal(stopped.run.childStopped, true);
      assert.equal(stopped.run.generation?.outcome, "aborted");
      assert.equal(stopped.retained.includes(`pane=${started.paneId}`), false);
      assert.equal(existsSync(started.childSessionDir), false);
      if (profile === "worker") {
        assert.equal(stopped.workerCleanup?.action, "removed");
        assert.deepEqual(stopped.retained, [`branch=${started.worktree!.branch}`]);
      } else {
        assert.deepEqual(stopped.retained, []);
      }
    }, [`run-${profile}-enclosing-discard`]));
  }
});

test("aborted session removal failure retains exact residue for ordinary retry", async () => {
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "task", "/repo");
    await appendIncompleteSession(client);
    const sessionParent = dirname(started.childSessionDir);
    await chmod(sessionParent, 0o500);
    try {
      const failed = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(failed.run.lifecycle, "retained");
      assert.equal(failed.run.generation?.outcome, "aborted");
      assert.equal(failed.retained.includes(`sessionDir=${started.childSessionDir}`), true);
      assert.match(failed.run.error ?? "", /Child session removal failed/);
    } finally {
      await chmod(sessionParent, 0o700);
    }
    const retried = await runtime.stop(started.id);
    assert.equal(retried.run.lifecycle, "closed");
    assert.equal(retried.run.generation?.outcome, "aborted");
    assert.equal(existsSync(started.childSessionDir), false);
  }, ["run-reader-session-remove"]);
});

test("failed result archival retains one exact source and subagent_stop recovers without injection", async () => {
  let failResult = true;
  await fixture(async (client, runtime, deliveries, _agentDir, actions) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["full\nresult"]); };
    const started = await runtime.start("scout", "task", "/repo");
    await eventually(() => runtime.status(started.id).archivePending === true);
    const retained = runtime.status(started.id);
    assert.equal(retained.lifecycle, "retained");
    assert.equal(retained.generation?.delivery, "pending");
    assert.equal(retained.latestResult?.text, "full\nresult");
    assert.equal(existsSync(retained.childSessionDir), true);
    assert.equal(deliveries.length, 0);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.details.artifactPath, started.artifactPath);

    failResult = false;
    const recovered = await runtime.stop(started.id);
    assert.equal(recovered.run.lifecycle, "closed");
    assert.equal(recovered.run.latestResult?.text, "full\nresult");
    assert.equal(recovered.run.generation?.delivery, "delivered");
    assert.equal(recovered.run.generation?.returned, true);
    assert.equal(recovered.run.generation?.artifactResultPersisted, true);
    assert.equal(deliveries.length, 0);
    assert.equal(actions.length, 1);
    assert.equal(existsSync(started.childSessionDir), false);
    assert.match(await readFile(started.artifactPath, "utf8"), /full\nresult/);

    const inspectedAgain = await runtime.stop(started.id);
    assert.equal(inspectedAgain.run.latestResult?.text, "full\nresult");
    assert.equal(deliveries.length, 0);
  }, ["run-reader"], {
    appendArtifact: async (identity, section, operations) => {
      if (failResult && section.includes("— Subagent")) throw new Error("result archive unavailable");
      await appendArtifactSection(identity, section, operations);
    },
  });
});

test("result_ready journal failure recovers without duplicating the archived result", async () => {
  let failReadyOnce = true;
  await fixture(async (client, runtime, deliveries, _agentDir, actions) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["journal recovery"]); };
    const started = await runtime.start("scout", "task", "/repo");
    await eventually(() => runtime.status(started.id).archivePending === true);
    assert.equal(actions.length, 1);
    assert.equal(deliveries.length, 0);
    const recovered = await runtime.stop(started.id);
    assert.equal(recovered.run.latestResult?.text, "journal recovery");
    assert.equal(recovered.run.generation?.returned, true);
    const artifact = await readFile(started.artifactPath, "utf8");
    assert.equal(artifact.match(/— Subagent/g)?.length, 1);
    assert.equal(deliveries.length, 0);
  }, ["run-reader"], {
    appendState: (_customType, record) => {
      if (record.state === "result_ready" && failReadyOnce) {
        failReadyOnce = false;
        throw new Error("result_ready journal failed once");
      }
    },
  });
});

test("result_delivered journal failure preserves returned state and recovers without a second transition", async () => {
  let failDeliveredOnce = true;
  await fixture(async (client, runtime, deliveries, _agentDir, actions) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["blocking journal recovery"]); };
    await assert.rejects(
      runtime.start("scout", "task", "/repo", { wait: true, timeoutMs: 100 }),
      /result_delivered journal failed once/,
    );
    const retained = runtime.status("run-reader");
    assert.equal(retained.archivePending, true);
    assert.equal(retained.generation?.delivery, "delivered");
    assert.equal(retained.generation?.returned, true);
    assert.equal(actions.length, 1);
    const recovered = await runtime.stop("run-reader");
    assert.equal(recovered.run.generation?.delivery, "delivered");
    assert.equal(recovered.run.generation?.returned, true);
    assert.equal(deliveries.length, 0);
    assert.equal((await readFile(retained.artifactPath, "utf8")).match(/— Subagent/g)?.length, 1);
  }, ["run-reader"], {
    appendState: (_customType, record) => {
      if (record.state === "result_delivered" && failDeliveredOnce) {
        failDeliveredOnce = false;
        throw new Error("result_delivered journal failed once");
      }
    },
  });
});

test("cleanup artifact failure preserves child session until a later stop retry", async () => {
  let failCleanup = true;
  await fixture(async (client, runtime) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["archived"]); };
    const started = await runtime.start("scout", "task", "/repo", { wait: true, timeoutMs: 100 });
    const first = await runtime.stop(started.id);
    assert.equal(first.run.lifecycle, "retained");
    assert.equal(first.retained.includes(`artifact=${started.artifactPath}`), true);
    assert.equal(first.retained.includes(`sessionDir=${started.childSessionDir}`), true);
    assert.equal(existsSync(started.childSessionDir), true);
    failCleanup = false;
    const second = await runtime.stop(started.id);
    assert.equal(second.run.lifecycle, "closed");
    assert.equal(existsSync(started.childSessionDir), false);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
  }, ["run-reader"], {
    appendArtifact: async (identity, section, operations) => {
      if (failCleanup && section.startsWith("\n## Cleanup")) throw new Error("cleanup archive unavailable");
      await appendArtifactSection(identity, section, operations);
    },
  });
});

test("follow-up artifact failure leaves the prior delivered generation usable and unsent", async () => {
  let failFollowup = false;
  await fixture(async (client, runtime) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["first"]); };
    const first = await runtime.start("scout", "one", "/repo", { wait: true, timeoutMs: 100 });
    failFollowup = true;
    await assert.rejects(runtime.send(first.id, "two"), /Artifact persistence failed/);
    const current = runtime.status(first.id);
    assert.equal(current.generation?.number, 1);
    assert.equal(current.generation?.delivery, "delivered");
    assert.equal(current.latestResult?.text, "first");
    assert.equal(client.calls.filter(({ method }) => method === "pane.send_input").length, 1);
  }, ["run-reader"], {
    appendArtifact: async (identity, section, operations) => {
      if (failFollowup && section.includes("— Parent")) throw new Error("follow-up archive unavailable");
      await appendArtifactSection(identity, section, operations);
    },
  });
});

test("run notifications expose journaled snapshots without steady-state polling", async () => {
  const changes: string[][] = [];
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "inspect this", "/repo");
    await eventually(() => client.calls.filter(({ method }) => method === "agent.get").length === 2);
    const reconciledGets = client.calls.filter(({ method }) => method === "agent.get").length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, reconciledGets);
    assert.deepEqual(changes, [
      ["run-reader/starting/working/no-generation/"],
      ["run-reader/starting/idle/no-generation/"],
      ["run-reader/live/idle/g1:pending/"],
    ]);

    await appendResult(client, ["complete"]);
    client.statusSubscriptions[0]!.emit("idle");
    await eventually(() => deliveries.length === 1);
    assert.deepEqual(changes.slice(-2), [
      ["run-reader/live/idle/g1:ready/"],
      ["run-reader/live/idle/g1:queued/"],
    ]);

    const delivery = deliveries[0]!;
    assert.equal(runtime.confirmDelivery({ role: "custom", ...delivery }), true);
    assert.deepEqual(changes.at(-1), ["run-reader/live/idle/g1:delivered/"]);

    await runtime.send(started.id, "follow up");
    assert.deepEqual(changes.at(-1), ["run-reader/live/idle/g2:pending/"]);
    const stopped = await runtime.stop(started.id);
    assert.equal(stopped.run.lifecycle, "retained");
    assert.deepEqual(stopped.retained, [`sessionDir=${started.childSessionDir}`]);
    assert.deepEqual(changes.slice(-2), [
      ["run-reader/stopping/idle/g2:pending/"],
      [`run-reader/retained/idle/g2:pending/sessionDir=${started.childSessionDir}`],
    ]);
  }, ["run-reader"], {
    onRunsChanged: (runtime) => changes.push(observableSnapshot(runtime)),
  });
});

test("status events reset or replace candidates without polling and stable expiry has an exact read budget", async () => {
  const timer = controlledDelay();
  let observations = 0;
  const stable = observation("stable");
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "idle", "done"];
    await runtime.start("scout", "task", "/repo");
    await eventually(() => timer.waits.some(({ ms, settled }) => ms === 100 && !settled));
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 2);
    assert.equal(observations, 1);

    for (const status of ["working", "blocked", "unknown"] as const) {
      client.statusSubscriptions[0]!.emit(status);
      await eventually(() => runtime.status("run-reader").status === status);
      assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 2);
      assert.equal(observations, 1);
    }

    client.statusSubscriptions[0]!.emit("idle");
    await eventually(() => observations === 2);
    await eventually(() => timer.waits.filter(({ ms, settled }) => ms === 100 && !settled).length === 1);
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 2);
    timer.release(100);
    await eventually(() => deliveries.length === 1);
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 3);
    assert.equal(observations, 3);
    assert.equal(runtime.status("run-reader").status, "done");
  }, ["run-reader"], {
    runtimeOptions: {
      quietPeriodMs: 100,
      monitorDelay: timer.sleep,
      observeChildSession: async () => { observations++; return stable; },
    },
  });
});

test("events arriving during expiry reconciliation are processed before finalization", async (context) => {
  for (const eventStatus of ["working", "done"] as const) await context.test(eventStatus, async () => {
    const timer = controlledDelay();
    const expiryStarted = deferred<void>();
    const releaseExpiry = deferred<void>();
    const stable = observation("stable");
    let observationCalls = 0;
    await fixture(async (client, runtime, deliveries) => {
      client.statuses = ["idle", "idle", "idle", "idle"];
      await runtime.start("scout", "task", "/repo");
      await eventually(() => timer.waits.some(({ ms, settled }) => ms === 150 && !settled));
      timer.release(150);
      await expiryStarted.promise;
      client.statusSubscriptions[0]!.emit(eventStatus);
      releaseExpiry.resolve();

      if (eventStatus === "working") {
        await eventually(() => runtime.status("run-reader").status === "working");
        assert.equal(deliveries.length, 0);
        assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 3);
        assert.equal(observationCalls, 2);
      } else {
        await eventually(() => observationCalls === 3);
        assert.equal(deliveries.length, 0);
        await eventually(() => timer.waits.filter(({ ms, settled }) => ms === 150 && !settled).length === 1);
        timer.release(150);
        await eventually(() => deliveries.length === 1);
        assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 4);
        assert.equal(observationCalls, 4);
      }
    }, ["run-reader"], {
      runtimeOptions: {
        quietPeriodMs: 150,
        monitorDelay: timer.sleep,
        observeChildSession: async () => {
          observationCalls++;
          if (observationCalls === 2) {
            expiryStarted.resolve();
            await releaseExpiry.promise;
          }
          return stable;
        },
      },
    });
  });
});

test("changed session fingerprints start a fresh independently bounded quiet window", async () => {
  const timer = controlledDelay();
  const observations = [observation("first", "leaf-1"), observation("second", "leaf-2", "compact-1"), observation("second", "leaf-2", "compact-1")];
  let observationCalls = 0;
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle", "idle", "done", "idle"];
    await runtime.start("scout", "task", "/repo");
    await eventually(() => timer.waits.some(({ ms, settled }) => ms === 200 && !settled));
    timer.release(200);
    await eventually(() => observationCalls === 2);
    assert.equal(deliveries.length, 0);
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 3);
    await eventually(() => timer.waits.filter(({ ms, settled }) => ms === 200 && !settled).length === 1);
    timer.release(200);
    await eventually(() => deliveries.length === 1);
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 4);
    assert.equal(observationCalls, 3);
    assert.equal(runtime.status("run-reader").latestResult?.childEntryId, "second");
  }, ["run-reader"], {
    runtimeOptions: {
      quietPeriodMs: 200,
      monitorDelay: timer.sleep,
      observeChildSession: async () => observations[Math.min(observationCalls++, observations.length - 1)],
    },
  });
});

test("clean EOF and transport failures reconnect, while protocol failures fail closed", async (context) => {
  for (const transport of ["eof", "error"] as const) await context.test(transport, async () => {
    const timer = controlledDelay();
    await fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      await runtime.start("scout", "task", "/repo");
      await eventually(() => client.statusSubscriptions.length === 1);
      if (transport === "eof") client.statusSubscriptions[0]!.end();
      else client.statusSubscriptions[0]!.fail(new HerdrSubscriptionTransportError("disconnected"));
      await eventually(() => timer.waits.some(({ ms, settled }) => ms === 250 && !settled));
      timer.release(250);
      await eventually(() => client.statusSubscriptions.length === 2);
      assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 3);
      assert.equal(runtime.status("run-reader").lifecycle, "live");
    }, ["run-reader"], {
      runtimeOptions: {
        monitorDelay: timer.sleep,
        observeChildSession: async () => undefined,
      },
    });
  });

  await context.test("protocol", async () => {
    const timer = controlledDelay();
    await fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      await runtime.start("scout", "task", "/repo");
      await eventually(() => client.statusSubscriptions.length === 1);
      client.statusSubscriptions[0]!.fail(new HerdrError("bad event"));
      await eventually(() => runtime.status("run-reader").lifecycle === "retained");
      assert.equal(client.statusSubscriptions.length, 1);
      assert.deepEqual(timer.requested, []);
    }, ["run-reader"], {
      runtimeOptions: { monitorDelay: timer.sleep, observeChildSession: async () => undefined },
    });
  });
});

test("subscription retry exhaustion retains resources without polling fallback", async () => {
  const timer = controlledDelay();
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    await runtime.start("scout", "task", "/repo");
    const backoffs = [250, 500, 1_000, 2_000, 4_000];
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      await eventually(() => client.statusSubscriptions.length === attempt + 1);
      client.statusSubscriptions[attempt]!.end();
      await eventually(() => timer.waits.some(({ ms, settled }) => ms === backoffs[attempt] && !settled));
      timer.release(backoffs[attempt]!);
    }
    await eventually(() => client.statusSubscriptions.length === 6);
    client.statusSubscriptions[5]!.end();
    await eventually(() => runtime.status("run-reader").lifecycle === "retained");
    assert.deepEqual(timer.requested, backoffs);
    assert.equal(client.calls.filter(({ method }) => method === "agent.get").length, 7);
    assert.equal(client.statusSubscriptions.length, 6);
  }, ["run-reader"], {
    runtimeOptions: { monitorDelay: timer.sleep, observeChildSession: async () => undefined },
  });
});

test("topology changes at expiry fail closed without reconnect", async () => {
  const timer = controlledDelay();
  const stable = observation("stable");
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    await runtime.start("scout", "task", "/repo");
    await eventually(() => timer.waits.some(({ ms, settled }) => ms === 300 && !settled));
    client.agent!.workspaceId = "w-other";
    timer.release(300);
    await eventually(() => runtime.status("run-reader").lifecycle === "retained");
    assert.equal(client.statusSubscriptions.length, 1);
    assert.equal(runtime.status("run-reader").error, "Herdr topology changed for run run-reader");
  }, ["run-reader"], {
    runtimeOptions: {
      quietPeriodMs: 300,
      monitorDelay: timer.sleep,
      observeChildSession: async () => stable,
    },
  });
});

test("throwing run notifications cannot break start, result delivery, or explicit stop", async () => {
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle"];
    client.onSendInput = async () => { await appendResult(client, ["answer"]); };
    const started = await runtime.start("scout", "task", "/repo");
    await eventually(() => deliveries.length === 1);
    assert.equal(runtime.confirmDelivery({ role: "custom", ...deliveries[0]! }), true);
    assert.equal(runtime.status(started.id).generation?.delivery, "delivered");
    const stopped = await runtime.stop(started.id);
    assert.equal(stopped.run.lifecycle, "closed");
    assert.deepEqual(runtime.list(), []);
  }, ["run-reader"], {
    onRunsChanged: () => { throw new Error("widget failed"); },
  });
});

test("journal failures suppress ordinary phases and notify only finalized fallback state", async (context) => {
  await context.test("startup insertion", async () => {
    const changes: string[][] = [];
    await fixture(async (_client, runtime) => {
      await assert.rejects(runtime.start("scout", "task", "/repo"), /journal failed/);
      assert.deepEqual(changes, [[
        "run-reader/retained/working/no-generation/journal=herdr-subagent-state|tab=w-parent:t-reader",
      ]]);
      assert.equal(runtime.status("run-reader").error, "Cleanup journal failed: journal failed");
    }, ["run-reader"], {
      appendState: () => { throw new Error("journal failed"); },
      onRunsChanged: (runtime) => changes.push(observableSnapshot(runtime)),
    });
  });

  await context.test("monitor result", async () => {
    const changes: string[][] = [];
    await fixture(async (client, runtime, deliveries) => {
      client.statuses = ["idle"];
      const started = await runtime.start("scout", "task", "/repo");
      changes.length = 0;
      await appendResult(client, ["answer"]);
      client.statusSubscriptions[0]!.emit("idle");
      await eventually(() => runtime.status(started.id).lifecycle === "retained");
      assert.deepEqual(changes, [[
        "run-reader/retained/idle/g1:ready/pane=w-parent:p-child|tab=w-parent:t-reader|sessionDir="
          + started.childSessionDir,
      ]]);
      assert.deepEqual(deliveries, []);
    }, ["run-reader"], {
      appendState: (_customType, record) => {
        if (record.state === "result_ready") throw new Error("result journal failed");
      },
      onRunsChanged: (runtime) => changes.push(observableSnapshot(runtime)),
    });
  });

  await context.test("closed cleanup", async () => {
    const changes: string[][] = [];
    await fixture(async (client, runtime) => {
      client.statuses = ["idle"];
      const started = await runtime.start("scout", "task", "/repo");
      await appendIncompleteSession(client);
      changes.length = 0;
      const stopped = await runtime.stop(started.id, { discardIncompleteResult: true });
      assert.equal(stopped.run.lifecycle, "retained");
      assert.deepEqual(changes, [
        ["run-reader/stopping/idle/g1:pending/"],
        ["run-reader/retained/idle/g1:pending/journal=herdr-subagent-state"],
      ]);
      assert.equal(runtime.list()[0]?.lifecycle, "retained");
      assert.equal(existsSync(started.childSessionDir), false);
      const retried = await runtime.stop(started.id);
      assert.equal(retried.run.lifecycle, "retained");
      const artifact = await readFile(started.artifactPath, "utf8");
      assert.equal(artifact.match(/- Reason: Cleanup journal failed: cleanup journal failed/g)?.length, 1);
    }, ["run-reader"], {
      appendState: (_customType, record) => {
        if (record.state === "closed") throw new Error("cleanup journal failed");
      },
      onRunsChanged: (runtime) => changes.push(observableSnapshot(runtime)),
    });
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
    client.statusSubscriptions[0]!.emit("idle");
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
    const [one, two] = await Promise.all([
      runtime.stop("run-reader"),
      runtime.stop("run-reader", { discardIncompleteResult: true }),
    ]);
    assert.deepEqual(one, two);
    assert.equal(one.run.lifecycle, "retained");
    const discarded = await runtime.stop("run-reader", { discardIncompleteResult: true });
    assert.equal(discarded.run.lifecycle, "closed");
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "tab.close").length, 2);
    assert.deepEqual(runtime.list(), []);
  }));
});

test("retained worker finalization retries dirty-to-clean without stopping the child twice", async () => {
  let dirty = true;
  let statusCalls = 0;
  await fixture(async (client, runtime) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["worker result"]); };
    const started = await runtime.start("worker", "task", process.cwd(), { wait: true, timeoutMs: 100 });
    const first = await runtime.stop(started.id);
    assert.equal(first.run.lifecycle, "retained");
    assert.equal(first.run.childStopped, true);
    assert.equal(first.workerCleanup?.removed, false);
    assert.equal(first.workerCleanup?.action, "retained");
    const retainedArtifact = await readFile(started.artifactPath, "utf8");
    assert.match(retainedArtifact, /## Cleanup\n- State: action required/);
    assert.match(retainedArtifact, /- Reason: worktree is dirty/);
    assert.match(retainedArtifact, /Do not use raw Git-only removal/);
    dirty = false;
    const second = await runtime.stop(started.id);
    assert.equal(second.run.lifecycle, "closed");
    assert.equal(second.run.childStopped, true);
    assert.equal(second.workerCleanup?.removed, true);
    assert.equal(second.workerCleanup?.action, "removed");
    assert.match(await readFile(started.artifactPath, "utf8"), /## Cleanup\n- State: removed/);
    assert.equal(statusCalls, 2);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "worktree.remove").length, 1);
    await rm(started.worktree!.path, { recursive: true, force: true });
  }, ["run-worker-retry"], {
    gitStatus: async () => {
      statusCalls++;
      return dirty ? " M file.ts\n" : "";
    },
  });
});

test("no-result worker progresses dirty to session-only retention, then explicit discard closes already-finalized residue", async () => {
  let statusCall = 0;
  let dirty = true;
  const journal: HerdrStateRecord[] = [];
  await fixture(async (client, runtime, deliveries) => {
    client.statuses = ["idle"];
    const started = await runtime.start("worker", "task", process.cwd());
    await appendIncompleteSession(client);

    const dirtyStop = await runtime.stop(started.id);
    assert.equal(dirtyStop.run.lifecycle, "retained");
    assert.equal(dirtyStop.run.generation?.outcome, undefined);
    assert.equal(dirtyStop.workerCleanup?.action, "retained");
    assert.deepEqual(dirtyStop.retained, [
      `branch=${started.worktree!.branch}`,
      `worktree=${started.worktree!.path}`,
      `sessionDir=${started.childSessionDir}`,
    ]);

    dirty = false;
    const cleaned = await runtime.stop(started.id);
    assert.equal(cleaned.run.lifecycle, "retained");
    assert.equal(cleaned.workerCleanup?.action, "removed");
    assert.deepEqual(cleaned.retained, [
      `branch=${started.worktree!.branch}`,
      `sessionDir=${started.childSessionDir}`,
    ]);
    assert.equal(existsSync(started.childSessionDir), true);

    client.failGetWorkspace = new HerdrError("missing", { code: "workspace_not_found" });
    const discarded = await runtime.stop(started.id, { discardIncompleteResult: true });
    assert.equal(discarded.run.lifecycle, "closed");
    assert.equal(discarded.run.generation?.outcome, "aborted");
    assert.equal(discarded.workerCleanup?.action, "already-finalized");
    assert.deepEqual(discarded.retained, [`branch=${started.worktree!.branch}`]);
    assert.equal(existsSync(started.childSessionDir), false);
    assert.equal((await readFile(started.artifactPath, "utf8")).match(/— Aborted/g)?.length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "worktree.remove").length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "workspace.get").length, 1);
    assert.equal(journal.some((record) => record.state === "stopping" && record.generation?.outcome === "aborted"), true);
    assert.equal(journal.at(-1)?.state, "closed");
    assert.equal(journal.at(-1)?.generation?.outcome, "aborted");
    assert.deepEqual(deliveries, []);
    assert.deepEqual(runtime.list(), []);
  }, ["run-worker-incomplete"], {
    appendState: (_customType, record) => journal.push(record),
    gitStatus: async () => {
      statusCall++;
      if (statusCall === 3) throw new Error("checkout absent");
      return dirty ? " M file.ts\n" : "";
    },
  });
});

test("automatic dirty settlement can be cleaned and retried through explicit stop", async () => {
  let dirty = true;
  let statusCalls = 0;
  await fixture(async (client, runtime) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["worker result"]); };
    const started = await runtime.start("worker", "task", process.cwd(), { wait: true, timeoutMs: 100 });
    const [automatic] = await runtime.settle();
    assert.equal(automatic?.run.lifecycle, "retained");
    assert.equal(automatic?.run.childStopped, true);
    dirty = false;
    const retried = await runtime.stop(started.id);
    assert.equal(retried.run.lifecycle, "closed");
    assert.equal(retried.workerCleanup?.action, "removed");
    assert.equal(statusCalls, 2);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
    assert.equal(client.calls.filter(({ method }) => method === "worktree.remove").length, 1);
    await rm(started.worktree!.path, { recursive: true, force: true });
  }, ["run-worker-auto-retry"], {
    gitStatus: async () => {
      statusCalls++;
      return dirty ? " M file.ts\n" : "";
    },
  });
});

test("retained stop calls share one attempt and a later call starts a fresh retry", async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    const started = await runtime.start("worker", "task", process.cwd());
    const one = runtime.stop(started.id);
    const two = runtime.stop(started.id);
    await eventually(() => calls === 1);
    release();
    const [first, shared] = await Promise.all([one, two]);
    assert.deepEqual(first, shared);
    assert.equal(first.run.lifecycle, "retained");
    await runtime.stop(started.id);
    assert.equal(calls, 2);
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
    await rm(started.worktree!.path, { recursive: true, force: true });
  }, ["run-worker-concurrent"], {
    gitStatus: async () => {
      calls++;
      if (calls === 1) await gate;
      return " M file.ts\n";
    },
  });
});

test("failed child-stop milestone persistence does not authorize cleanup-only mutation", async () => {
  let failMilestone = true;
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    const started = await runtime.start("worker", "task", process.cwd());
    const first = await runtime.stop(started.id);
    assert.equal(first.run.lifecycle, "retained");
    assert.equal(first.run.childStopped, undefined);
    assert.equal(first.retained.includes("journal=herdr-subagent-state"), true);
    assert.equal(client.calls.some(({ method }) => method === "worktree.remove"), false);

    const second = await runtime.stop(started.id);
    assert.equal(second.run.childStopped, true);
    assert.equal(second.run.lifecycle, "retained");
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 2);
    await rm(started.worktree!.path, { recursive: true, force: true });
  }, ["run-worker-milestone"], {
    appendState: (_customType, record) => {
      if (record.state === "stopping" && record.childStopped && failMilestone) {
        failMilestone = false;
        throw new Error("milestone failed");
      }
    },
    gitStatus: async () => " M file.ts\n",
  });
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

test("successful enclosing cleanup clears stale pane but preserves any unarchived generation session", async (context) => {
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
      assert.equal(stopped.run.lifecycle, "retained");
      assert.deepEqual(stopped.retained, profile === "worker" ? [
        `branch=${started.worktree!.branch}`,
        `sessionDir=${started.childSessionDir}`,
      ] : [`sessionDir=${started.childSessionDir}`]);
      assert.equal(existsSync(started.childSessionDir), true);
      assert.equal(runtime.list().length, 1);
      if (started.worktree) await rm(started.worktree.path, { recursive: true, force: true });
    }, [`run-${profile}-stop-enclosing`]));
  }
});

test("independent reader starts coexist", async () => {
  await fixture(async (client, runtime) => {
    client.paneIds = ["w-parent:p-one", "w-parent:p-two"];
    client.statuses = ["idle", "idle"];
    await runtime.start("scout", "one", "/repo");
    await eventually(() => client.calls.filter(({ method }) => method === "agent.get").length === 2);
    client.statuses = ["idle", "idle"];
    await runtime.start("researcher", "two", "/repo");
    await eventually(() => client.calls.filter(({ method }) => method === "agent.get").length === 4);
    assert.deepEqual(runtime.list().map(({ id }) => id), ["run-one", "run-two"]);
    assert.deepEqual(client.statusSubscriptions.map(({ paneId }) => paneId), ["w-parent:p-one", "w-parent:p-two"]);
    client.statusSubscriptions[0]!.emit("blocked");
    await eventually(() => runtime.status("run-one").status === "blocked");
    assert.equal(runtime.status("run-two").status, "idle");
  }, ["run-one", "run-two"]);
});

test("starting records create active locators that delete on close and release on shutdown retain", async () => {
  await fixture(async (client, runtime, _deliveries, agentDir) => {
    client.statuses = ["idle", "idle"];
    client.onSendInput = async () => { await appendResult(client, ["done"]); };
    const started = await runtime.start("scout", "inspect", "/repo", { wait: true, timeoutMs: 100 });
    const active = await readRecoveryLocator(agentDir, {
      parentSessionId,
      runId: started.id,
    });
    assert.equal(active?.ownerState, "active");
    assert.equal(active?.parentSessionFile, "/tmp/parent-session.jsonl");
    assert.equal(active?.artifactPath, started.artifactPath);

    const closed = await runtime.stop(started.id);
    assert.equal(closed.run.lifecycle, "closed");
    assert.equal(await readRecoveryLocator(agentDir, {
      parentSessionId,
      runId: started.id,
    }), undefined);
  });

  await fixture(async (client, runtime, _deliveries, agentDir) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "pending", "/repo");
    const summary = await runtime.stopCurrentOwner({
      reason: "test bulk retain",
    });
    assert.equal(summary.results[0]?.run.lifecycle, "retained");
    assert.equal(summary.allClosed, false);
    assert.deepEqual(summary.preservedSessions, [started.childSessionDir]);
    assert.equal((await readRecoveryLocator(agentDir, {
      parentSessionId,
      runId: started.id,
    }))?.ownerState, "active");

    await runtime.shutdown("quit");
    assert.equal((await readRecoveryLocator(agentDir, {
      parentSessionId,
      runId: started.id,
    }))?.ownerState, "released");
  });
});

test("bulk stop includes retained runs, isolates foreign owners, and discards incomplete generations", async () => {
  await fixture(async (client, runtime, _deliveries, agentDir) => {
    client.statuses = ["idle", "idle", "idle"];
    const reader = await runtime.start("scout", "one", "/repo");
    await appendIncompleteSession(client);
    const worker = await runtime.start("worker", "two", process.cwd());
    const ordinary = await runtime.stop(reader.id);
    assert.equal(ordinary.run.lifecycle, "retained");
    assert.equal(ordinary.run.generation?.outcome, undefined);

    const foreign = runtime.runs.get(worker.id)!;
    foreign.parentInstanceId = "instance-foreign";

    const summary = await runtime.stopCurrentOwner({
      reason: "bulk abort",
      discardIncompleteResult: true,
    });
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0]?.run.id, reader.id);
    assert.equal(summary.results[0]?.run.lifecycle, "closed");
    assert.equal(summary.results[0]?.run.generation?.outcome, "aborted");
    assert.equal(summary.allClosed, true);
    assert.equal(runtime.runs.get(worker.id)?.parentInstanceId, "instance-foreign");
    assert.notEqual(runtime.runs.get(worker.id)?.lifecycle, "closed");
    assert.equal(await readRecoveryLocator(agentDir, {
      parentSessionId,
      runId: reader.id,
    }), undefined);
    assert.equal((await readRecoveryLocator(agentDir, {
      parentSessionId,
      runId: worker.id,
    }))?.ownerState, "active");

    foreign.parentInstanceId = "instance-current";
    const workerStop = await runtime.stop(worker.id, { discardIncompleteResult: true });
    assert.equal(workerStop.run.lifecycle, "closed");
    await rm(worker.worktree!.path, { recursive: true, force: true });
  }, ["run-reader", "run-worker-bulk"]);
});

test("overlapping bulk and explicit stop share one in-flight discard policy", async () => {
  await fixture(async (client, runtime) => {
    client.statuses = ["idle"];
    const started = await runtime.start("scout", "overlap", "/repo");
    await appendIncompleteSession(client);

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let closeStarted = false;
    const originalClosePane = client.closePane.bind(client);
    client.closePane = async (paneId, signal) => {
      closeStarted = true;
      await closeGate;
      return originalClosePane(paneId, signal);
    };

    const bulk = runtime.stopCurrentOwner({ reason: "bulk", discardIncompleteResult: true });
    await eventually(() => closeStarted);
    const explicit = runtime.stop(started.id); // non-discard shares the in-flight discard attempt
    releaseClose();
    const [bulkSummary, explicitResult] = await Promise.all([bulk, explicit]);
    assert.equal(bulkSummary.results[0]?.run.lifecycle, "closed");
    assert.equal(explicitResult.run.lifecycle, "closed");
    assert.equal(explicitResult.run.generation?.outcome, "aborted");
    assert.equal(client.calls.filter(({ method }) => method === "pane.close").length, 1);
  });
});

test("bulk stop gives each live run a distinct cleanup deadline", async () => {
  await fixture(async (client, runtime) => {
    client.paneIds = ["w-parent:p-one", "w-parent:p-two"];
    client.statuses = ["idle", "idle"];
    await runtime.start("scout", "one", "/repo");
    client.statuses = ["idle", "idle"];
    await runtime.start("researcher", "two", "/repo");

    const summary = await runtime.stopCurrentOwner({
      reason: "fresh deadlines",
      discardIncompleteResult: true,
    });
    assert.deepEqual(summary.results.map(({ run }) => [run.id, run.lifecycle]), [
      ["run-one", "closed"],
      ["run-two", "closed"],
    ]);
    const cleanup = client.calls.filter(({ method }) => method === "pane.close" || method === "tab.close");
    assert.deepEqual(cleanup.map(({ method }) => method), [
      "pane.close", "tab.close", "pane.close", "tab.close",
    ]);
    assert.equal(cleanup[0]?.signal, cleanup[1]?.signal);
    assert.equal(cleanup[2]?.signal, cleanup[3]?.signal);
    assert.notEqual(cleanup[0]?.signal, cleanup[2]?.signal);
  }, ["run-one", "run-two"]);
});

test("locator create failure surfaces diagnostics and uses startup cleanup", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "runtime-locator-fail-"));
  const client = new FakeHerdr();
  client.statuses = ["idle"];
  const runtime = new SubagentRuntime(client, { workspaceId: "w-parent", agentDir }, {
    idFactory: () => "run-locator-fail",
    instanceIdFactory: () => "instance-current",
    readinessTimeoutMs: 30,
    pollIntervalMs: 1,
    quietPeriodMs: 1,
    cleanupTimeoutMs: 30,
    gitStatus: async () => "",
    appendState: () => {},
    registryOperations: {
      async writeFile() { throw new Error("disk full"); },
      async rename() { throw new Error("unused"); },
      async unlink() { throw new Error("unused"); },
    },
  });
  await runtime.bindParent({
    parentSessionId,
    parentSessionFile: "/tmp/parent-session.jsonl",
    parentEntryId: "parent-leaf",
  }, [], "startup");
  try {
    await assert.rejects(runtime.start("scout", "task", "/repo"), /Recovery locator creation failed: disk full/);
    assert.equal(client.calls.some(({ method }) => method === "agent.input"), false);
    assert.equal(client.calls.some(({ method }) => method === "pane.close"), true);
    assert.deepEqual(await enumerateRecoveryLocators(agentDir), []);
    assert.deepEqual(runtime.list(), []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
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
