import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseResultRequestMarker,
  parseResultRequestWire,
  type BridgeResponseV1,
  type ResultRequestMarker,
} from "./contracts.ts";

export type BridgeCorrelationState = "idle" | "active" | "invalid";

export interface ChildBridgeEnvironment {
  readonly runId: string;
  readonly runNonce: string;
  readonly resultExchangeDirectory: string;
}

export interface AssistantCandidate {
  readonly rawText: string;
  readonly stopReason: string;
  readonly emptyFinal: boolean;
  readonly messageIdentity?: string;
}

interface ActiveCorrelation {
  readonly marker: ResultRequestMarker;
  candidate?: AssistantCandidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractAssistantText(message: unknown): AssistantCandidate | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const rawText = parts.join("");
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "stop";
  const messageIdentity = typeof message.responseId === "string" && message.responseId.length > 0
    ? message.responseId
    : typeof message.timestamp === "number"
      ? `ts:${message.timestamp}`
      : undefined;
  return {
    rawText,
    stopReason,
    emptyFinal: rawText.length === 0,
    ...(messageIdentity === undefined ? {} : { messageIdentity }),
  };
}

export function extractUserText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

export function requestFilePath(exchangeDirectory: string, generation: number): string {
  return join(exchangeDirectory, "requests", `${String(generation).padStart(6, "0")}.json`);
}

export function responseFilePath(exchangeDirectory: string, generation: number): string {
  return join(exchangeDirectory, "responses", `${String(generation).padStart(6, "0")}.json`);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Result exchange path must be a real directory");
  if ((info.mode & 0o077) !== 0) throw new Error("Result exchange path must be private");
}

export async function writeResultRequestFile(
  exchangeDirectory: string,
  marker: ResultRequestMarker,
): Promise<string> {
  const directory = join(exchangeDirectory, "requests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  const path = requestFilePath(exchangeDirectory, marker.generation);
  const body = `${JSON.stringify({
    schemaVersion: 1,
    runId: marker.runId,
    runNonce: marker.runNonce,
    generation: marker.generation,
    requestNonce: marker.requestNonce,
    writtenAt: Date.now(),
  }, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}

export async function readResultRequestFile(
  exchangeDirectory: string,
  generation: number,
): Promise<ResultRequestMarker | undefined> {
  const path = requestFilePath(exchangeDirectory, generation);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseResultRequestMarker(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function consumeResultRequestFile(
  exchangeDirectory: string,
  generation: number,
): Promise<ResultRequestMarker | undefined> {
  const path = requestFilePath(exchangeDirectory, generation);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const marker = parseResultRequestMarker(raw);
    await rm(path, { force: true });
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeBridgeResponse(
  exchangeDirectory: string,
  response: BridgeResponseV1,
): Promise<string> {
  const directory = join(exchangeDirectory, "responses");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  const path = responseFilePath(exchangeDirectory, response.generation);
  const body = `${JSON.stringify(response, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

export async function readBridgeResponse(
  exchangeDirectory: string,
  generation: number,
): Promise<BridgeResponseV1 | undefined> {
  const path = responseFilePath(exchangeDirectory, generation);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(raw) || raw.schemaVersion !== 1) throw new Error("bridge response malformed");
    return raw as unknown as BridgeResponseV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function createChildBridgeState(env: ChildBridgeEnvironment) {
  let state: BridgeCorrelationState = "idle";
  let active: ActiveCorrelation | undefined;
  let lastDiagnostic: string | undefined;

  async function onUserMessage(text: string): Promise<void> {
    const parsed = parseResultRequestWire(text);
    if (!parsed) {
      if (state === "active") {
        state = "invalid";
        active = undefined;
        lastDiagnostic = "Unmarked user input invalidated active generation correlation";
      }
      return;
    }
    if (parsed.marker.runId !== env.runId || parsed.marker.runNonce !== env.runNonce) {
      state = "invalid";
      active = undefined;
      lastDiagnostic = "Result request marker run identity does not match child environment";
      return;
    }
    if (state === "active") {
      state = "invalid";
      active = undefined;
      lastDiagnostic = "Second result request marker while a generation was active invalidated correlation";
      return;
    }
    const expected = await readResultRequestFile(env.resultExchangeDirectory, parsed.marker.generation);
    if (
      !expected
      || expected.runId !== parsed.marker.runId
      || expected.runNonce !== parsed.marker.runNonce
      || expected.generation !== parsed.marker.generation
      || expected.requestNonce !== parsed.marker.requestNonce
    ) {
      state = "invalid";
      active = undefined;
      lastDiagnostic = "Result request marker does not match the private request file";
      return;
    }
    await consumeResultRequestFile(env.resultExchangeDirectory, parsed.marker.generation);
    state = "active";
    active = { marker: parsed.marker };
    lastDiagnostic = undefined;
  }

  function onAssistantMessage(message: unknown): void {
    if (state !== "active" || !active) return;
    const candidate = extractAssistantText(message);
    if (!candidate) return;
    active.candidate = candidate;
  }

  async function onSettled(): Promise<BridgeResponseV1 | undefined> {
    if (state !== "active" || !active) {
      state = "idle";
      active = undefined;
      return undefined;
    }
    const marker = active.marker;
    // Do not invent an empty successful final when no assistant candidate was observed
    // (aborts/errors without message_end). Parent falls back after grace.
    if (!active.candidate) {
      state = "idle";
      active = undefined;
      lastDiagnostic = "agent_settled without an assistant candidate; no structured result published";
      return undefined;
    }
    const candidate = active.candidate;
    const response: BridgeResponseV1 = {
      schemaVersion: 1,
      runId: marker.runId,
      runNonce: marker.runNonce,
      generation: marker.generation,
      requestNonce: marker.requestNonce,
      rawText: candidate.rawText,
      stopReason: candidate.stopReason,
      emptyFinal: candidate.emptyFinal,
      ...(candidate.messageIdentity === undefined ? {} : { messageIdentity: candidate.messageIdentity }),
      publishedAt: Date.now(),
    };
    await writeBridgeResponse(env.resultExchangeDirectory, response);
    state = "idle";
    active = undefined;
    return response;
  }

  return {
    get state() { return state; },
    get diagnostic() { return lastDiagnostic; },
    get activeGeneration() { return active?.marker.generation; },
    onUserMessage,
    onAssistantMessage,
    onSettled,
  };
}

export function resolveChildBridgeEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChildBridgeEnvironment | undefined {
  if (environment.PI_HERDR_SUBAGENT !== "1") return undefined;
  const runId = environment.PI_HERDR_SUBAGENT_RUN_ID;
  const runNonce = environment.PI_HERDR_SUBAGENT_RUN_NONCE;
  const exchange = environment.PI_HERDR_SUBAGENT_RESULT_EXCHANGE;
  if (!runId || !runNonce || !exchange) return undefined;
  return {
    runId,
    runNonce,
    resultExchangeDirectory: resolve(exchange),
  };
}

/** Register only the narrow child result bridge. No parent tools/resources/UI. */
export function registerChildResultBridge(
  pi: ExtensionAPI,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly mode: "child-bridge"; readonly registeredEvents: readonly string[] } | undefined {
  const env = resolveChildBridgeEnvironment(environment);
  if (!env) return undefined;
  const bridge = createChildBridgeState(env);

  pi.on("message_end", async (event) => {
    const message = (event as { message?: unknown }).message;
    if (!isRecord(message)) return;
    if (message.role === "user") {
      const text = extractUserText(message);
      if (text !== undefined) await bridge.onUserMessage(text);
      return;
    }
    if (message.role === "assistant") bridge.onAssistantMessage(message);
  });

  pi.on("agent_settled", async () => {
    try {
      await bridge.onSettled();
    } catch {
      // Bridge publish failures remain local; parent reconciliation reports capture unavailable.
    }
  });

  return {
    mode: "child-bridge",
    registeredEvents: ["message_end", "agent_settled"],
  };
}

export async function ensureResultExchangeLayout(exchangeDirectory: string): Promise<{
  readonly directory: string;
  readonly requests: string;
  readonly responses: string;
}> {
  const lexical = resolve(exchangeDirectory);
  await mkdir(lexical, { recursive: true, mode: 0o700 });
  await chmod(lexical, 0o700);
  const directory = await realpath(lexical);
  const requests = join(directory, "requests");
  const responses = join(directory, "responses");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  await mkdir(responses, { recursive: true, mode: 0o700 });
  await chmod(requests, 0o700);
  await chmod(responses, 0o700);
  return { directory, requests, responses };
}
