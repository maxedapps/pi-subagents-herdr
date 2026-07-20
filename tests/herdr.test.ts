import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import {
  HerdrError,
  HerdrSubscriptionTransportError,
  HerdrTimeoutError,
  SocketHerdrClient,
  type JsonRecord,
} from "../src/herdr.ts";

interface Request { id: string; method: string; params: JsonRecord }

async function withServer(
  reply: (request: Request) => unknown | undefined,
  run: (client: SocketHerdrClient) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "structured-herdr-"));
  const socketPath = join(directory, "api.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Request;
      const response = reply(request);
      if (response !== undefined) socket.end(`${typeof response === "string" ? response : JSON.stringify(response)}\n`);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    await run(new SocketHerdrClient({ socketPath, idFactory: () => "request-1", responseTimeoutMs: 30 }));
  } finally {
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
}

async function withSubscriptionServer(
  handle: (request: Request, socket: Socket) => void,
  run: (client: SocketHerdrClient, state: { connections: number; closes: number }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "streaming-herdr-"));
  const socketPath = join(directory, "api.sock");
  const sockets = new Set<Socket>();
  const state = { connections: 0, closes: 0 };
  const server = createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.once("close", () => {
      state.closes++;
      sockets.delete(socket);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Request;
      buffer = buffer.slice(newline + 1);
      handle(request, socket);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    await run(new SocketHerdrClient({ socketPath, idFactory: () => "subscription-1", responseTimeoutMs: 200 }), state);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}

function acknowledgement(request: Request, extra: JsonRecord = {}): JsonRecord {
  return { id: request.id, result: { type: "subscription_started", ...extra }, server_version: "additive" };
}

function statusEvent(
  overrides: JsonRecord = {},
): JsonRecord {
  return {
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p3",
      workspace_id: "w1",
      agent_status: "idle",
      extra_data: true,
      ...overrides,
    },
    sequence: 1,
  };
}

function success(request: Request): JsonRecord {
  const base = { id: request.id };
  switch (request.method) {
    case "tab.create": return { ...base, result: { type: "tab_created", tab: { workspace_id: "w1", tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } };
    case "agent.start": case "agent.get": return { ...base, result: { type: request.method === "agent.start" ? "agent_started" : "agent_info", agent: { agent: "pi", agent_session: { agent: "pi", kind: "id", value: "child-session" }, terminal_id: "term", workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3", agent_status: "idle" } } };
    case "worktree.create": return { ...base, result: { type: "worktree_created", workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" }, worktree: { path: "/tmp/w2", branch: "branch" } } };
    case "worktree.remove": return { ...base, result: { type: "worktree_removed", workspace_id: "w2", path: "/tmp/w2", forced: false } };
    case "workspace.get": return { ...base, result: { type: "workspace_info", workspace: { workspace_id: "w2", worktree: { checkout_path: "/tmp/w2", is_linked_worktree: true } } } };
    default: return { ...base, result: { type: "ok" } };
  }
}

test("client exposes and sends exactly the approved Herdr methods", async () => {
  assert.deepEqual(Object.getOwnPropertyNames(SocketHerdrClient.prototype).filter((name) => name !== "constructor"), [
    "createTab", "startAgent", "getAgent", "subscribeAgentStatus", "sendInput", "closePane", "closeTab", "createWorktree", "removeWorktree",
    "getWorkspace", "closeWorkspace",
  ]);
  const requests: Request[] = [];
  await withServer((request) => { requests.push(request); return success(request); }, async (client) => {
    await client.createTab({ workspace_id: "w1", focus: false });
    const started = await client.startAgent({ name: "scout", argv: ["pi"], workspace_id: "w1", tab_id: "w1:t2" });
    assert.deepEqual(started.agentSession, { agent: "pi", kind: "id", value: "child-session" });
    await client.getAgent("term");
    await client.sendInput("w1:p3", "task");
    await client.closePane("w1:p3");
    await client.closeTab("w1:t2");
    await client.createWorktree({ workspace_id: "w1", path: "/tmp/w2", branch: "branch", focus: false });
    await client.removeWorktree("w2");
    assert.deepEqual(await client.getWorkspace("w2"), {
      workspaceId: "w2",
      worktree: { checkoutPath: "/tmp/w2", isLinkedWorktree: true },
    });
    await client.closeWorkspace("w2");
  });
  assert.deepEqual(requests.map(({ method }) => method), [
    "tab.create", "agent.start", "agent.get", "pane.send_input", "pane.close", "tab.close", "worktree.create", "worktree.remove",
    "workspace.get", "workspace.close",
  ]);
  assert.deepEqual(requests[2]?.params, { target: "term" });
  assert.deepEqual(requests[3]?.params, { pane_id: "w1:p3", text: "task", keys: ["return"] });
  assert.deepEqual(requests[7]?.params, { workspace_id: "w2", force: false });
  assert.deepEqual(requests[8]?.params, { workspace_id: "w2" });
  assert.deepEqual(requests[9]?.params, { workspace_id: "w2" });
});

test("status subscription waits for its correlated acknowledgement and sends an exact-pane request", async () => {
  let serverSocket: Socket | undefined;
  let request: Request | undefined;
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  await withSubscriptionServer((value, socket) => {
    request = value;
    serverSocket = socket;
    received();
  }, async (client) => {
    let resolved = false;
    const pending = client.subscribeAgentStatus("w1:p3", "w1").then((stream) => {
      resolved = true;
      return stream;
    });
    await requestReceived;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    assert.deepEqual(request, {
      id: "subscription-1",
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p3" }] },
    });
    serverSocket!.write(`${JSON.stringify(acknowledgement(request!))}\n`);
    const stream = await pending;
    assert.equal(resolved, true);
    await stream.return?.();
  });
});

test("status subscription incrementally parses fragmented and batched additive NDJSON", async () => {
  await withSubscriptionServer((request, socket) => {
    const first = `${JSON.stringify(acknowledgement(request, { subscription_id: "s1" }))}\n`;
    const events = `${JSON.stringify(statusEvent())}\n${JSON.stringify(statusEvent({ agent_status: "done" }))}\n`;
    socket.write(first.slice(0, 9));
    setImmediate(() => {
      socket.write(first.slice(9) + events);
      socket.end();
    });
  }, async (client) => {
    const stream = await client.subscribeAgentStatus("w1:p3", "w1");
    const events = [];
    for await (const event of stream) events.push(event);
    assert.deepEqual(events, [
      { paneId: "w1:p3", workspaceId: "w1", status: "idle" },
      { paneId: "w1:p3", workspaceId: "w1", status: "done" },
    ]);
  });
});

test("subscription transport failures are explicitly classified without changing ordinary connect errors", async (context) => {
  await context.test("connect failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "missing-herdr-socket-"));
    const socketPath = join(directory, "missing.sock");
    const client = new SocketHerdrClient({ socketPath, connectTimeoutMs: 30 });
    try {
      await assert.rejects(client.subscribeAgentStatus("w1:p3", "w1"), (error) => (
        error instanceof HerdrSubscriptionTransportError
        && error.cause instanceof HerdrError
      ));
      await assert.rejects(client.getAgent("x"), (error) => (
        error instanceof HerdrError
        && !(error instanceof HerdrSubscriptionTransportError)
      ));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await context.test("acknowledgement timeout", async () => {
    await withSubscriptionServer(() => {}, async (client) => {
      await assert.rejects(client.subscribeAgentStatus("w1:p3", "w1"), (error) => (
        error instanceof HerdrSubscriptionTransportError
        && /acknowledgement timed out/.test(error.message)
      ));
    });
  });

  await context.test("EOF before acknowledgement", async () => {
    await withSubscriptionServer((_request, socket) => socket.end(), async (client) => {
      await assert.rejects(client.subscribeAgentStatus("w1:p3", "w1"), (error) => (
        error instanceof HerdrSubscriptionTransportError
      ));
    });
  });
});

test("status subscription rejects wrong acknowledgements and malformed exact-pane events", async (context) => {
  const cases: Array<{ label: string; response: (request: Request) => string }> = [
    { label: "wrong acknowledgement ID", response: (request) => JSON.stringify({ ...acknowledgement(request), id: "other" }) },
    { label: "wrong acknowledgement type", response: (request) => JSON.stringify({ id: request.id, result: { type: "ok" } }) },
    {
      label: "wrong event type",
      response: (request) => `${JSON.stringify(acknowledgement(request))}\n${JSON.stringify({ ...statusEvent(), event: "pane.output_changed" })}`,
    },
    {
      label: "wrong pane",
      response: (request) => `${JSON.stringify(acknowledgement(request))}\n${JSON.stringify(statusEvent({ pane_id: "w1:p-other" }))}`,
    },
    {
      label: "wrong workspace",
      response: (request) => `${JSON.stringify(acknowledgement(request))}\n${JSON.stringify(statusEvent({ workspace_id: "w2" }))}`,
    },
    {
      label: "invalid status",
      response: (request) => `${JSON.stringify(acknowledgement(request))}\n${JSON.stringify(statusEvent({ agent_status: "settled" }))}`,
    },
  ];
  for (const entry of cases) {
    await context.test(entry.label, async () => {
      await withSubscriptionServer((request, socket) => {
        socket.end(`${entry.response(request)}\n`);
      }, async (client) => {
        const pending = client.subscribeAgentStatus("w1:p3", "w1");
        if (entry.label.startsWith("wrong acknowledgement")) {
          await assert.rejects(pending, (error) => (
            error instanceof HerdrError
            && !(error instanceof HerdrSubscriptionTransportError)
          ));
        } else {
          const stream = await pending;
          await assert.rejects(stream.next(), (error) => (
            error instanceof HerdrError
            && !(error instanceof HerdrSubscriptionTransportError)
          ));
        }
      });
    });
  }
});

test("status subscription distinguishes clean EOF from protocol rejection", async (context) => {
  await context.test("clean EOF completes iteration", async () => {
    await withSubscriptionServer((request, socket) => {
      socket.end(`${JSON.stringify(acknowledgement(request))}\n`);
    }, async (client) => {
      const stream = await client.subscribeAgentStatus("w1:p3", "w1");
      assert.deepEqual(await stream.next(), { value: undefined, done: true });
    });
  });
  await context.test("truncated protocol rejects iteration", async () => {
    await withSubscriptionServer((request, socket) => {
      socket.end(`${JSON.stringify(acknowledgement(request))}\n{"event":`);
    }, async (client) => {
      const stream = await client.subscribeAgentStatus("w1:p3", "w1");
      await assert.rejects(stream.next(), (error) => (
        error instanceof HerdrError
        && !(error instanceof HerdrSubscriptionTransportError)
        && /truncated/.test(error.message)
      ));
    });
  });
});

test("status subscription cleanup is idempotent before acknowledgement, while streaming, and on consumer close", async (context) => {
  await context.test("already aborted", async () => {
    await withSubscriptionServer(() => assert.fail("aborted subscription connected"), async (client, state) => {
      const controller = new AbortController();
      controller.abort(new HerdrError("already cancelled"));
      await assert.rejects(client.subscribeAgentStatus("w1:p3", "w1", controller.signal), /already cancelled/);
      assert.equal(state.connections, 0);
    });
  });
  await context.test("pre-ack abort", async () => {
    await withSubscriptionServer(() => {}, async (client, state) => {
      const controller = new AbortController();
      const pending = client.subscribeAgentStatus("w1:p3", "w1", controller.signal);
      await eventually(() => state.connections === 1);
      controller.abort(new HerdrError("pre-ack cancelled"));
      await assert.rejects(pending, /pre-ack cancelled/);
      await eventually(() => state.closes === 1);
      assert.equal(state.closes, 1);
    });
  });
  await context.test("streaming abort", async () => {
    await withSubscriptionServer((request, socket) => socket.write(`${JSON.stringify(acknowledgement(request))}\n`), async (client, state) => {
      const controller = new AbortController();
      const stream = await client.subscribeAgentStatus("w1:p3", "w1", controller.signal);
      const next = stream.next();
      controller.abort(new HerdrError("stream cancelled"));
      await assert.rejects(next, /stream cancelled/);
      await eventually(() => state.closes === 1);
      assert.equal(state.closes, 1);
    });
  });
  await context.test("consumer close", async () => {
    await withSubscriptionServer((request, socket) => {
      socket.write(`${JSON.stringify(acknowledgement(request))}\n${JSON.stringify(statusEvent())}\n`);
    }, async (client, state) => {
      const stream = await client.subscribeAgentStatus("w1:p3", "w1");
      assert.deepEqual(await stream.return?.(), { value: undefined, done: true });
      assert.deepEqual(await stream.return?.(), { value: undefined, done: true });
      assert.deepEqual(await stream.next(), { value: undefined, done: true });
      await eventually(() => state.closes === 1);
      assert.equal(state.closes, 1);
    });
  });
});

test("workspace.get accepts an explicitly null worktree", async () => {
  await withServer((request) => ({
    id: request.id,
    result: { type: "workspace_info", workspace: { workspace_id: "w2", worktree: null } },
  }), async (client) => {
    assert.deepEqual(await client.getWorkspace("w2"), { workspaceId: "w2", worktree: null });
  });
});

test("workspace.get fails closed on malformed required fields", async (context) => {
  const malformed = [
    { label: "workspace id", workspace: { workspace_id: "", worktree: null } },
    { label: "missing worktree", workspace: { workspace_id: "w2" } },
    { label: "checkout path", workspace: { workspace_id: "w2", worktree: { checkout_path: null, is_linked_worktree: true } } },
    { label: "linked-worktree flag", workspace: { workspace_id: "w2", worktree: { checkout_path: "/tmp/w2", is_linked_worktree: "true" } } },
  ];
  for (const entry of malformed) {
    await context.test(entry.label, async () => {
      await withServer((request) => ({ id: request.id, result: { type: "workspace_info", workspace: entry.workspace } }), async (client) => {
        await assert.rejects(client.getWorkspace("w2"), (error) => error instanceof HerdrError);
      });
    });
  }
});

test("client surfaces API, malformed response, timeout, and abort failures", async (context) => {
  await context.test("API error preserves its structured code", async () => {
    await withServer((request) => ({ id: request.id, error: { code: "workspace_not_found", message: "gone" } }), async (client) => {
      await assert.rejects(client.getWorkspace("missing"), (error) => {
        assert.equal(error instanceof HerdrError && error.code, "workspace_not_found");
        assert.match(String(error), /Herdr workspace_not_found: gone/);
        return true;
      });
    });
  });
  await context.test("malformed JSON", async () => {
    await withServer(() => "not-json", async (client) => assert.rejects(client.getAgent("x"), /malformed JSON/));
  });
  await context.test("response timeout", async () => {
    await withServer(() => undefined, async (client) => {
      await assert.rejects(client.getAgent("x"), (error) => (
        error instanceof HerdrTimeoutError
        && !(error instanceof HerdrSubscriptionTransportError)
      ));
    });
  });
  await context.test("abort", async () => {
    await withServer(() => undefined, async (client) => {
      const controller = new AbortController();
      const request = client.getAgent("x", controller.signal);
      controller.abort(new HerdrError("cancelled"));
      await assert.rejects(request, /cancelled/);
    });
  });
});
