import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isHarness, type Harness, type ThinkingLevel } from "../contracts/harness.ts";
import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import { parseGenerationSummary, type GenerationSummary } from "../results/contracts.ts";
import { parseRunAttention, type RunAttention } from "../results/action-notices.ts";
import { assertEphemeralRuntimeLayout, type EphemeralRuntimeFiles } from "./ephemeral.ts";
import type { BoundedOutput } from "./control.ts";
import { parseOwnershipJournalData, type OwnershipJournalData } from "./ownership.ts";
import type { WorktreeRecord } from "../worktrees/contracts.ts";
import { decodeWorktreeRecord } from "../worktrees/manager.ts";

export interface RuntimeGenerationState {
  readonly nextGeneration: number;
  readonly active?: GenerationSummary;
  readonly bridgeAvailable: boolean;
}

export interface RuntimeRunMetadata {
  readonly schemaVersion: 5;
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
  readonly lifecycle: "starting" | "running" | "interrupting" | "stopping" | "stopped" | "failed" | "lost";
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
  readonly attention?: RunAttention;
  readonly worktree?: WorktreeRecord;
  readonly ownershipJournal?: OwnershipJournalData;
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
  if (!isRecord(value)) throw new Error("runtime run metadata is malformed");
  if (value.schemaVersion !== 5) throw new Error("runtime run metadata is malformed");
  const candidate = value;
  if (!isRecord(candidate.policy) || !isRecord(candidate.artifacts) || !isRecord(candidate.runtime)) throw new Error("runtime run metadata is malformed");
  for (const key of ["runId", "runNonce", "terminalId", "profileName", "profileSource", "harness", "taskSynopsis"] as const) nonEmpty(candidate[key], `runtime metadata ${key}`);
  if (candidate.assignment !== undefined) nonEmpty(candidate.assignment, "runtime metadata assignment");
  if (candidate.artifactWriter !== "parent" && candidate.artifactWriter !== "child") throw new Error("runtime metadata artifactWriter is malformed");
  if (!isHarness(candidate.harness)) throw new Error("runtime metadata harness is malformed");
  if (!["starting", "running", "interrupting", "stopping", "stopped", "failed", "lost"].includes(String(candidate.lifecycle))) throw new Error("runtime metadata lifecycle is malformed");
  if (!Number.isSafeInteger(candidate.createdAt) || (candidate.createdAt as number) <= 0) throw new Error("runtime metadata createdAt is malformed");
  const policy = candidate.policy as Record<string, unknown>;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(policy.thinking)) || typeof policy.cwd !== "string" || !Array.isArray(policy.tools) || !policy.tools.every((item) => typeof item === "string") || typeof policy.mutation !== "boolean" || typeof policy.network !== "boolean" || typeof policy.requireWorktree !== "boolean") throw new Error("runtime metadata policy is malformed");
  if (policy.skills !== undefined) throw new Error("runtime metadata policy.skills is not supported; remove this field");
  for (const [key, path] of Object.entries(candidate.artifacts as Record<string, unknown>)) { nonEmpty(key, "runtime metadata artifact key"); nonEmpty(path, `runtime metadata artifact ${key}`); if (!isAbsolute(path)) throw new Error(`runtime metadata artifact ${key} must be absolute`); }
  parseOutput(candidate.output);
  const runtime = candidate.runtime as Record<string, unknown>;
  if (runtime.ephemeralFiles !== "retained" && runtime.ephemeralFiles !== "removed") throw new Error("runtime metadata ephemeralFiles is malformed");
  for (const key of ["directory", "systemPrompt", "sessionDirectory", "resultExchangeDirectory"] as const) {
    if (runtime[key] !== undefined) { nonEmpty(runtime[key], `runtime metadata ${key}`); if (!isAbsolute(runtime[key])) throw new Error(`runtime metadata ${key} must be absolute`); }
  }
  if (runtime.ephemeralFiles === "retained" && (typeof runtime.directory !== "string" || typeof runtime.systemPrompt !== "string" || typeof candidate.assignment !== "string")) {
    throw new Error("retained runtime metadata requires its run-bound directory, system prompt, and full assignment");
  }
  if (runtime.ephemeralFiles === "removed" && (runtime.directory !== undefined || runtime.systemPrompt !== undefined || runtime.sessionDirectory !== undefined || runtime.resultExchangeDirectory !== undefined)) {
    throw new Error("removed runtime metadata must not claim ephemeral paths");
  }
  if (candidate.harness === "pi" && runtime.ephemeralFiles === "retained" && typeof runtime.sessionDirectory !== "string") throw new Error("retained Pi runtime metadata requires sessionDirectory");
  if (candidate.harness === "pi" && runtime.ephemeralFiles === "retained" && typeof runtime.resultExchangeDirectory !== "string") {
    throw new Error("retained Pi runtime metadata requires resultExchangeDirectory");
  }
  if (candidate.harness !== "pi" && runtime.sessionDirectory !== undefined) throw new Error("Non-Pi runtime metadata must not claim an unused Pi session directory");
  if (candidate.harness !== "pi" && runtime.resultExchangeDirectory !== undefined) throw new Error("Non-Pi runtime metadata must not claim a Pi result-exchange directory");
  parseNative(candidate.nativeSession);
  if (candidate.generation === undefined) throw new Error("runtime metadata requires generation state");
  parseGenerationState(candidate.generation);
  if (candidate.attention !== undefined) parseRunAttention(candidate.attention);
  if (candidate.worktree !== undefined) decodeWorktreeRecord(candidate.worktree);
  if (candidate.ownershipJournal !== undefined) parseOwnershipJournalData(candidate.ownershipJournal);
  return candidate as unknown as RuntimeRunMetadata;
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

export type RuntimeRunMetadataInventoryEntry =
  | { readonly runId: string; readonly status: "valid"; readonly metadata: RuntimeRunMetadata }
  | { readonly runId: string; readonly status: "malformed" };

/** Inventory safe run-directory names without exposing malformed metadata content. */
export async function inventoryRuntimeRunMetadata(checkout: string): Promise<readonly RuntimeRunMetadataInventoryEntry[]> {
  const canonicalCheckout = await realpath(resolve(checkout));
  const runsRoot = join(canonicalCheckout, ".subagents", "runs");
  let info;
  try { info = await lstat(runsRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runtime runs root is not a safe directory");
  const values: RuntimeRunMetadataInventoryEntry[] = [];
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue;
    try {
      const metadata = await readRuntimeRunMetadata(canonicalCheckout, entry.name);
      values.push(metadata?.runId === entry.name ? { runId: entry.name, status: "valid", metadata } : { runId: entry.name, status: "malformed" });
    } catch { values.push({ runId: entry.name, status: "malformed" }); }
  }
  return values;
}

/** List valid run-bound metadata without letting one malformed stale entry disable recovery. */
export async function listRuntimeRunMetadata(checkout: string): Promise<readonly RuntimeRunMetadata[]> {
  return (await inventoryRuntimeRunMetadata(checkout)).flatMap((entry) => entry.status === "valid" ? [entry.metadata] : []);
}

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
