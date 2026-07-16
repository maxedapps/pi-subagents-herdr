import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { JsonValue } from "../contracts/protocol.ts";
import { decodeEvent, decodeResponseEnvelope, expectResult, type HerdrSubscriptionEvent, type ResponseEnvelope, type WireRecord } from "./protocol.ts";

export interface HerdrTransportOptions {
  readonly socketPath: string;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly idFactory?: () => string;
}
export interface RequestOptions { readonly signal?: AbortSignal; readonly responseTimeoutMs?: number; }
export class HerdrUnavailableError extends Error { constructor(message: string, readonly rootCause?: unknown) { super(message); this.name = "HerdrUnavailableError"; } }
export class HerdrTimeoutError extends Error { constructor(readonly phase: "connect" | "response", readonly timeoutMs: number) { super(`Herdr ${phase} timed out after ${timeoutMs}ms`); this.name = "HerdrTimeoutError"; } }

function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"); }
function parseLine(line: string): unknown { try { return JSON.parse(line) as unknown; } catch (error) { throw new HerdrUnavailableError("Herdr returned malformed JSON", error); } }

export class HerdrSubscriptionStream implements AsyncIterable<HerdrSubscriptionEvent> {
  readonly requestId: string;
  #socket: Socket;
  #values: HerdrSubscriptionEvent[] = [];
  #waiters: Array<{ resolve: (value: IteratorResult<HerdrSubscriptionEvent>) => void; reject: (error: unknown) => void }> = [];
  #ended = false;
  #error: unknown;
  constructor(requestId: string, socket: Socket) { this.requestId = requestId; this.#socket = socket; }
  push(value: HerdrSubscriptionEvent): void { const waiter = this.#waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else this.#values.push(value); }
  fail(error: unknown): void { if (this.#ended) return; this.#ended = true; this.#error = error; for (const waiter of this.#waiters.splice(0)) waiter.reject(error); }
  finish(): void { if (this.#ended) return; this.#ended = true; for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined }); }
  close(): void { this.#socket.destroy(); this.finish(); }
  [Symbol.asyncIterator](): AsyncIterator<HerdrSubscriptionEvent> {
    return { next: () => {
      const value = this.#values.shift(); if (value) return Promise.resolve({ done: false, value });
      if (this.#error !== undefined) return Promise.reject(this.#error);
      if (this.#ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }, return: async () => { this.close(); return { done: true, value: undefined }; } };
  }
}

export class HerdrNdjsonTransport {
  readonly socketPath: string;
  readonly connectTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly maxLineBytes: number;
  #idFactory: () => string;
  constructor(options: HerdrTransportOptions) {
    if (!options.socketPath) throw new HerdrUnavailableError("HERDR_SOCKET_PATH is required");
    this.socketPath = options.socketPath; this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000; this.maxLineBytes = options.maxLineBytes ?? 2_000_000;
    this.#idFactory = options.idFactory ?? (() => `pi-herdr-${randomUUID()}`);
  }

  async request(method: string, params: WireRecord = {}, options: RequestOptions = {}): Promise<ResponseEnvelope> {
    const id = this.#idFactory();
    const socket = await this.#connect(options.signal);
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      let settled = false; let buffer = "";
      const timeoutMs = options.responseTimeoutMs ?? this.responseTimeoutMs;
      const timer = setTimeout(() => finish(new HerdrTimeoutError("response", timeoutMs)), timeoutMs);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); socket.removeAllListeners(); socket.destroy(); };
      const finish = (error?: unknown, value?: ResponseEnvelope) => { if (settled) return; settled = true; cleanup(); error === undefined ? resolve(value!) : reject(error); };
      const onAbort = () => finish(abortError(options.signal!));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxLineBytes) return finish(new HerdrUnavailableError("Herdr response exceeded the line limit"));
        const newline = buffer.indexOf("\n"); if (newline < 0) return;
        const line = buffer.slice(0, newline); if (!line.trim()) return finish(new HerdrUnavailableError("Herdr returned an empty response line"));
        try { finish(undefined, decodeResponseEnvelope(parseLine(line), id)); } catch (error) { finish(error); }
      });
      socket.once("error", (error) => finish(new HerdrUnavailableError("Herdr socket request failed", error)));
      socket.once("end", () => finish(new HerdrUnavailableError(buffer.length > 0 ? "Herdr response was truncated" : "Herdr disconnected before responding")));
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async subscribe(params: WireRecord, options: RequestOptions = {}): Promise<HerdrSubscriptionStream> {
    const id = this.#idFactory(); const socket = await this.#connect(options.signal); const stream = new HerdrSubscriptionStream(id, socket);
    return new Promise((resolve, reject) => {
      let acknowledged = false; let settled = false; let buffer = "";
      const timeoutMs = options.responseTimeoutMs ?? this.responseTimeoutMs;
      const timer = setTimeout(() => fail(new HerdrTimeoutError("response", timeoutMs)), timeoutMs);
      const cleanupOpen = () => { clearTimeout(timer); };
      const fail = (error: unknown) => { if (!settled) { settled = true; cleanupOpen(); socket.destroy(); reject(error); } else stream.fail(error); };
      const onAbort = () => { socket.destroy(); fail(abortError(options.signal!)); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxLineBytes) return fail(new HerdrUnavailableError("Herdr subscription line exceeded the limit"));
        while (true) {
          const newline = buffer.indexOf("\n"); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
          try {
            const parsed = parseLine(line);
            if (!acknowledged) {
              const envelope = decodeResponseEnvelope(parsed, id);
              try { expectResult(envelope, "subscription_started"); }
              catch (error) { throw new HerdrUnavailableError("Herdr did not provide a valid subscription acknowledgement", error); }
              acknowledged = true; settled = true; cleanupOpen(); resolve(stream);
            } else stream.push(decodeEvent(parsed));
          } catch (error) { fail(error); return; }
        }
      });
      socket.once("close", () => options.signal?.removeEventListener("abort", onAbort));
      socket.once("error", (error) => fail(new HerdrUnavailableError("Herdr subscription socket failed", error)));
      socket.once("end", () => {
        if (buffer.trim()) fail(new HerdrUnavailableError("Herdr subscription stream ended with a truncated line"));
        else if (!acknowledged) fail(new HerdrUnavailableError("Herdr disconnected before subscription acknowledgement"));
        else stream.finish();
      });
      socket.write(`${JSON.stringify({ id, method: "events.subscribe", params })}\n`);
    });
  }

  #connect(signal?: AbortSignal): Promise<Socket> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath); let settled = false;
      const timer = setTimeout(() => finish(new HerdrTimeoutError("connect", this.connectTimeoutMs)), this.connectTimeoutMs);
      const onAbort = () => finish(abortError(signal!));
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); socket.removeListener("error", onError); if (error) { socket.destroy(); reject(error); } else resolve(socket); };
      const onError = (error: Error) => finish(new HerdrUnavailableError(`Unable to connect to Herdr at ${this.socketPath}`, error));
      signal?.addEventListener("abort", onAbort, { once: true }); socket.once("error", onError); socket.once("connect", () => finish());
    });
  }
}
