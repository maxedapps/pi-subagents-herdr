import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JsonValue } from "../../src/contracts/protocol.ts";

export interface FakeHerdrRequest { readonly id?: string; readonly method?: string; readonly params?: JsonValue; readonly [key: string]: JsonValue | undefined; }
export interface FakeRawReply { readonly $fake: "raw"; readonly chunks: readonly string[]; readonly end?: boolean; }
export interface FakeNoReply { readonly $fake: "none"; }
export type FakeHerdrReply = JsonValue | FakeRawReply | FakeNoReply;
export type FakeHerdrHandler = (request: FakeHerdrRequest) => FakeHerdrReply | Promise<FakeHerdrReply>;
export interface FakeHerdrServer {
  readonly socketPath: string; readonly requests: readonly FakeHerdrRequest[]; readonly openSocketCount: number;
  broadcast(value: JsonValue): void; broadcastSubscriptions(value: JsonValue): void; disconnectClients(): void; close(): Promise<void>;
}
function isRaw(reply: FakeHerdrReply): reply is FakeRawReply { return typeof reply === "object" && reply !== null && !Array.isArray(reply) && "$fake" in reply && reply.$fake === "raw"; }
function isNone(reply: FakeHerdrReply): reply is FakeNoReply { return typeof reply === "object" && reply !== null && !Array.isArray(reply) && "$fake" in reply && reply.$fake === "none"; }

export async function startFakeHerdrServer(handler: FakeHerdrHandler): Promise<FakeHerdrServer> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-fake-")); await mkdir(directory, { recursive: true });
  const socketPath = join(directory, "herdr.sock"); const requests: FakeHerdrRequest[] = []; const sockets = new Set<Socket>(); const subscriptionSockets = new Set<Socket>();
  const prune = (socket: Socket) => { sockets.delete(socket); subscriptionSockets.delete(socket); };
  const broadcastTo = (targets: Set<Socket>, value: JsonValue) => {
    const line = `${JSON.stringify(value)}\n`;
    for (const socket of [...targets]) {
      if (socket.destroyed || !socket.writable || socket.writableEnded) { prune(socket); continue; }
      try { socket.write(line, (error) => { if (error) { prune(socket); socket.destroy(); } }); }
      catch { prune(socket); socket.destroy(); }
    }
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => prune(socket)); socket.on("error", () => { prune(socket); socket.destroy(); }); let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void (async () => {
          let parsed: unknown;
          try { parsed = JSON.parse(line) as unknown; } catch { socket.write(`${JSON.stringify({ id: "", error: { code: "invalid_request", message: "Malformed JSON" } })}\n`); return; }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { socket.write(`${JSON.stringify({ id: "", error: { code: "invalid_request", message: "Expected object" } })}\n`); return; }
          const request = parsed as FakeHerdrRequest; requests.push(request); if (request.method === "events.subscribe") subscriptionSockets.add(socket); const response = await handler(request);
          if (isNone(response)) return;
          if (isRaw(response)) { for (const part of response.chunks) socket.write(part); if (response.end) socket.end(); return; }
          socket.write(`${JSON.stringify(response)}\n`);
        })().catch((error: unknown) => socket.destroy(error instanceof Error ? error : new Error(String(error))));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
  let closed = false;
  return {
    socketPath, get requests() { return requests; }, get openSocketCount() { return sockets.size; },
    broadcast(value) { broadcastTo(sockets, value); },
    broadcastSubscriptions(value) { broadcastTo(subscriptionSockets, value); },
    disconnectClients() { for (const socket of sockets) socket.destroy(); },
    async close() { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
