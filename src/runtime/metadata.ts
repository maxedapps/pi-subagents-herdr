import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Harness, ThinkingLevel } from "../contracts/harness.ts";
import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import { parseGenerationSummary, type GenerationSummary } from "../results/contracts.ts";
import { assertEphemeralRuntimeLayout, type EphemeralRuntimeFiles } from "./ephemeral.ts";
import type { BoundedOutput } from "./control.ts";
import type { OwnershipJournalData } from "./ownership.ts";

export interface RuntimeGenerationState {
  readonly nextGeneration: number;
  readonly active?: GenerationSummary;
  readonly bridgeAvailable: boolean;
}

export interface RuntimeRunMetadata {
  readonly schemaVersion: 4;
  readonly runId: string;
  readonly runNonce: string;
  readonly terminalId: string;
  readonly nativeSession?: NativeSessionIdentity;
  readonly profileName: string;
  readonly profileSource: string;
  readonly harness: Harness;
  readonly taskSynopsis: string;
  /** Full delegated assignment exists only until final handoff materialization. */
  readonly assignment?: string;
  readonly artifactWriter: "parent" | "child";
  readonly createdAt: number;
  readonly policy: {
    readonly thinking: ThinkingLevel;
    readonly cwd: string;
    readonly tools: readonly string[];
    readonly mutation: boolean;
    readonly network: boolean;
    readonly requireWorktree: boolean;
  };
  /** Durable paths only. Removed ephemeral files never remain under artifacts. */
  readonly artifacts: Readonly<Record<string, string>>;
  /** Last bounded output permits reload/recovery without premature handoff files. */
  readonly output: BoundedOutput;
  readonly runtime: {
    readonly ephemeralFiles: "retained" | "removed";
    readonly directory?: string;
    readonly systemPrompt?: string;
    readonly sessionDirectory?: string;
    readonly resultExchangeDirectory?: string;
  };
  /** Live generation/bridge summary. Full captures live in results/*.json. */
  readonly generation: RuntimeGenerationState;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${label} must be a non-empty string`); }
function within(root: string, candidate: string): boolean { const value = relative(root, candidate); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }
function parseNative(value: unknown): NativeSessionIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.kind !== "id" && value.kind !== "path")) throw new Error("runtime metadata nativeSession is malformed");
  nonEmpty(value.value, "runtime metadata nativeSession.value"); nonEmpty(value.source, "runtime metadata nativeSession.source");
  return { kind: value.kind, value: value.value, source: value.source };
}

function parseOutput(value: unknown): BoundedOutput {
  if (!isRecord(value)
    || typeof value.text !== "string"
    || value.source !== "recent_unwrapped"
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.truncated !== "boolean"
    || typeof value.herdrTruncated !== "boolean"
    || typeof value.localTruncated !== "boolean"
    || !Number.isSafeInteger(value.returnedBytes) || (value.returnedBytes as number) < 0
    || !Number.isSafeInteger(value.returnedLines) || (value.returnedLines as number) < 0
    || !Number.isSafeInteger(value.maxBytes) || (value.maxBytes as number) < 1
    || !Number.isSafeInteger(value.maxLines) || (value.maxLines as number) < 1
    || Buffer.byteLength(value.text, "utf8") !== value.returnedBytes
    || (value.text.length === 0 ? 0 : value.text.split("\n").length) !== value.returnedLines
    || (value.returnedBytes as number) > (value.maxBytes as number)
    || (value.returnedLines as number) > (value.maxLines as number)) {
    throw new Error("runtime metadata bounded output is malformed");
  }
  return value as unknown as BoundedOutput;
}

function parseGenerationState(value: unknown): RuntimeGenerationState {
  if (!isRecord(value)) throw new Error("runtime metadata generation state is malformed");
  if (!Number.isSafeInteger(value.nextGeneration) || (value.nextGeneration as number) < 1) {
    throw new Error("runtime metadata nextGeneration is malformed");
  }
  if (typeof value.bridgeAvailable !== "boolean") throw new Error("runtime metadata bridgeAvailable is malformed");
  if (value.active !== undefined) parseGenerationSummary(value.active);
  return value as unknown as RuntimeGenerationState;
}

export function parseRuntimeRunMetadata(value: unknown): RuntimeRunMetadata {
  if (!isRecord(value) || value.schemaVersion !== 4 || !isRecord(value.policy) || !isRecord(value.artifacts) || !isRecord(value.runtime)) {
    throw new Error("runtime run metadata is malformed");
  }
  for (const key of ["runId", "runNonce", "terminalId", "profileName", "profileSource", "harness", "taskSynopsis"] as const) nonEmpty(value[key], `runtime metadata ${key}`);
  if (value.assignment !== undefined) nonEmpty(value.assignment, "runtime metadata assignment");
  if (value.artifactWriter !== "parent" && value.artifactWriter !== "child") throw new Error("runtime metadata artifactWriter is malformed");
  if (!["pi", "claude", "codex"].includes(String(value.harness))) throw new Error("runtime metadata harness is malformed");
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0) throw new Error("runtime metadata createdAt is malformed");
  const policy = value.policy;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(policy.thinking)) || typeof policy.cwd !== "string" || !Array.isArray(policy.tools) || !policy.tools.every((item) => typeof item === "string") || typeof policy.mutation !== "boolean" || typeof policy.network !== "boolean" || typeof policy.requireWorktree !== "boolean") throw new Error("runtime metadata policy is malformed");
  if (policy.skills !== undefined) throw new Error("runtime metadata policy.skills is not supported; remove this field");
  for (const [key, path] of Object.entries(value.artifacts)) { nonEmpty(key, "runtime metadata artifact key"); nonEmpty(path, `runtime metadata artifact ${key}`); if (!isAbsolute(path)) throw new Error(`runtime metadata artifact ${key} must be absolute`); }
  parseOutput(value.output);
  const runtime = value.runtime;
  if (runtime.ephemeralFiles !== "retained" && runtime.ephemeralFiles !== "removed") throw new Error("runtime metadata ephemeralFiles is malformed");
  for (const key of ["directory", "systemPrompt", "sessionDirectory", "resultExchangeDirectory"] as const) {
    if (runtime[key] !== undefined) { nonEmpty(runtime[key], `runtime metadata ${key}`); if (!isAbsolute(runtime[key])) throw new Error(`runtime metadata ${key} must be absolute`); }
  }
  if (runtime.ephemeralFiles === "retained" && (typeof runtime.directory !== "string" || typeof runtime.systemPrompt !== "string" || typeof value.assignment !== "string")) {
    throw new Error("retained runtime metadata requires its run-bound directory, system prompt, and full assignment");
  }
  if (runtime.ephemeralFiles === "removed" && (runtime.directory !== undefined || runtime.systemPrompt !== undefined || runtime.sessionDirectory !== undefined || runtime.resultExchangeDirectory !== undefined)) {
    throw new Error("removed runtime metadata must not claim ephemeral paths");
  }
  if (value.harness === "pi" && runtime.ephemeralFiles === "retained" && typeof runtime.sessionDirectory !== "string") throw new Error("retained Pi runtime metadata requires sessionDirectory");
  if (value.harness === "pi" && runtime.ephemeralFiles === "retained" && typeof runtime.resultExchangeDirectory !== "string") {
    throw new Error("retained Pi runtime metadata requires resultExchangeDirectory");
  }
  if (value.harness !== "pi" && runtime.sessionDirectory !== undefined) throw new Error("Claude/Codex runtime metadata must not claim an unused Pi session directory");
  if (value.harness !== "pi" && runtime.resultExchangeDirectory !== undefined) throw new Error("Claude/Codex runtime metadata must not claim a Pi result-exchange directory");
  parseNative(value.nativeSession);
  if (value.generation === undefined) throw new Error("runtime metadata requires generation state");
  parseGenerationState(value.generation);
  return value as unknown as RuntimeRunMetadata;
}

function metadataRuntimeFiles(metadata: RuntimeRunMetadata): EphemeralRuntimeFiles {
  if (metadata.runtime.ephemeralFiles !== "retained") throw new Error("runtime metadata has no retained ephemeral layout");
  return {
    directory: metadata.runtime.directory!,
    systemPrompt: metadata.runtime.systemPrompt!,
    ...(metadata.runtime.sessionDirectory === undefined ? {} : { sessionDirectory: metadata.runtime.sessionDirectory }),
    ...(metadata.runtime.resultExchangeDirectory === undefined ? {} : { resultExchangeDirectory: metadata.runtime.resultExchangeDirectory }),
  };
}

export async function assertRuntimeFilesMatchMetadata(metadata: RuntimeRunMetadata): Promise<void> {
  if (metadata.runtime.ephemeralFiles === "removed") return;
  await assertEphemeralRuntimeLayout(metadata.runId, metadata.harness, metadataRuntimeFiles(metadata));
}

export function assertRuntimeMetadataMatchesJournal(metadata: RuntimeRunMetadata, journal: OwnershipJournalData): void {
  if (metadata.runId !== journal.runId || metadata.runNonce !== journal.runNonce || metadata.terminalId !== journal.resources.terminalId) throw new Error("runtime metadata run nonce/terminal does not match the active-branch journal");
  if (journal.resources.nativeSession !== undefined && JSON.stringify(metadata.nativeSession) !== JSON.stringify(journal.resources.nativeSession)) throw new Error("runtime metadata native session does not match the active-branch journal");
  if (metadata.harness === "pi" && metadata.nativeSession === undefined) throw new Error("Pi recovery metadata lacks mandatory native session identity");
}

/** Read operational metadata without following it outside checkout/.subagents. Missing metadata is a retention condition, not ownership proof. */
export async function readRuntimeRunMetadata(checkout: string, runId: string): Promise<RuntimeRunMetadata | undefined> {
  const canonicalCheckout = await realpath(resolve(checkout));
  const root = join(canonicalCheckout, ".subagents");
  const path = join(root, "runs", runId, "run.json");
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`runtime metadata is not a safe regular file: ${path}`);
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw new Error(`runtime metadata escapes checkout/.subagents: ${canonical}`);
  return parseRuntimeRunMetadata(JSON.parse(await readFile(canonical, "utf8")) as unknown);
}
