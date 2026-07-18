import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { HerdrError, HerdrTimeoutError, SocketHerdrClient, type JsonRecord } from "../src/herdr.ts";

interface Request { id: string; method: string; params: JsonRecord }

async function withServer(
  reply: (request: Request) => unknown | undefined,
  run: (client: SocketHerdrClient) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "minimal-herdr-"));
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

function success(request: Request): JsonRecord {
  const base = { id: request.id };
  switch (request.method) {
    case "ping": return { ...base, result: { type: "pong", version: "0.7.4", protocol: 1 } };
    case "tab.create": return { ...base, result: { type: "tab_created", tab: { workspace_id: "w1", tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } };
    case "agent.start": case "agent.get": return { ...base, result: { type: request.method === "agent.start" ? "agent_started" : "agent_info", agent: { agent: "pi", agent_session: { agent: "pi", kind: "id", value: "session" }, terminal_id: "term", workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3", agent_status: "idle" } } };
    case "agent.read": return { ...base, result: { type: "pane_read", read: { text: "ok", revision: 4, truncated: false } } };
    case "worktree.create": return { ...base, result: { type: "worktree_created", workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" }, worktree: { path: "/tmp/w2", branch: "branch" } } };
    case "worktree.remove": return { ...base, result: { type: "worktree_removed", workspace_id: "w2", path: "/tmp/w2", forced: false } };
    default: return { ...base, result: { type: "ok" } };
  }
}

test("client sends only the minimal Herdr request shapes", async () => {
  const requests: Request[] = [];
  await withServer((request) => { requests.push(request); return success(request); }, async (client) => {
    await client.ping();
    await client.createTab({ workspace_id: "w1", focus: false });
    await client.startAgent({ name: "scout", argv: ["pi"], workspace_id: "w1", tab_id: "w1:t2" });
    await client.getAgent("term");
    assert.deepEqual(await client.readAgent("term"), { text: "ok", revision: 4, truncated: false });
    await client.sendInput("w1:p3", "task");
    await client.sendKeys("w1:p3", ["ctrl+c"]);
    await client.closePane("w1:p3");
    await client.closeTab("w1:t2");
    await client.createWorktree({ workspace_id: "w1", path: "/tmp/w2", branch: "branch", focus: false });
    await client.removeWorktree("w2");
  });
  assert.deepEqual(requests.map(({ method }) => method), [
    "ping", "tab.create", "agent.start", "agent.get", "agent.read", "pane.send_input",
    "pane.send_keys", "pane.close", "tab.close", "worktree.create", "worktree.remove",
  ]);
  assert.deepEqual(requests[4]?.params, { target: "term", source: "recent_unwrapped", lines: 160, strip_ansi: true, format: "text" });
  assert.deepEqual(requests[5]?.params, { pane_id: "w1:p3", text: "task", keys: ["return"] });
  assert.deepEqual(requests[10]?.params, { workspace_id: "w2", force: false });
});

test("client surfaces a representative Herdr API error", async () => {
  await withServer((request) => ({ id: request.id, error: { code: "not_found", message: "gone" } }), async (client) => {
    await assert.rejects(client.getAgent("missing"), /Herdr not_found: gone/);
  });
});

test("client rejects malformed JSON and mismatched response IDs", async (context) => {
  await context.test("malformed JSON", async () => {
    await withServer(() => "not-json", async (client) => assert.rejects(client.ping(), /malformed JSON/));
  });
  await context.test("mismatched ID", async () => {
    await withServer(() => ({ id: "other", result: { type: "pong", version: "0.7.4", protocol: 1 } }), async (client) => {
      await assert.rejects(client.ping(), /response ID mismatch/);
    });
  });
});

test("client bounds stalled requests and honors abort", async (context) => {
  await context.test("response timeout", async () => {
    await withServer(() => undefined, async (client) => {
      await assert.rejects(client.ping(), (error) => error instanceof HerdrTimeoutError);
    });
  });
  await context.test("abort", async () => {
    await withServer(() => undefined, async (client) => {
      const controller = new AbortController();
      const request = client.ping(controller.signal);
      controller.abort(new HerdrError("cancelled"));
      await assert.rejects(request, /cancelled/);
    });
  });
});
