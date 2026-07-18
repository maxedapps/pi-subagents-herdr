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

function success(request: Request): JsonRecord {
  const base = { id: request.id };
  switch (request.method) {
    case "tab.create": return { ...base, result: { type: "tab_created", tab: { workspace_id: "w1", tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } };
    case "agent.start": case "agent.get": return { ...base, result: { type: request.method === "agent.start" ? "agent_started" : "agent_info", agent: { agent: "pi", agent_session: { agent: "pi", kind: "id", value: "child-session" }, terminal_id: "term", workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3", agent_status: "idle" } } };
    case "worktree.create": return { ...base, result: { type: "worktree_created", workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" }, worktree: { path: "/tmp/w2", branch: "branch" } } };
    case "worktree.remove": return { ...base, result: { type: "worktree_removed", workspace_id: "w2", path: "/tmp/w2", forced: false } };
    default: return { ...base, result: { type: "ok" } };
  }
}

test("client exposes and sends exactly the eight approved Herdr methods", async () => {
  assert.deepEqual(Object.getOwnPropertyNames(SocketHerdrClient.prototype).filter((name) => name !== "constructor"), [
    "createTab", "startAgent", "getAgent", "sendInput", "closePane", "closeTab", "createWorktree", "removeWorktree",
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
  });
  assert.deepEqual(requests.map(({ method }) => method), [
    "tab.create", "agent.start", "agent.get", "pane.send_input", "pane.close", "tab.close", "worktree.create", "worktree.remove",
  ]);
  assert.deepEqual(requests[2]?.params, { target: "term" });
  assert.deepEqual(requests[3]?.params, { pane_id: "w1:p3", text: "task", keys: ["return"] });
  assert.deepEqual(requests[7]?.params, { workspace_id: "w2", force: false });
});

test("client surfaces API, malformed response, timeout, and abort failures", async (context) => {
  await context.test("API error", async () => {
    await withServer((request) => ({ id: request.id, error: { code: "not_found", message: "gone" } }), async (client) => {
      await assert.rejects(client.getAgent("missing"), /Herdr not_found: gone/);
    });
  });
  await context.test("malformed JSON", async () => {
    await withServer(() => "not-json", async (client) => assert.rejects(client.getAgent("x"), /malformed JSON/));
  });
  await context.test("response timeout", async () => {
    await withServer(() => undefined, async (client) => {
      await assert.rejects(client.getAgent("x"), (error) => error instanceof HerdrTimeoutError);
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
