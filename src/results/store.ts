import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureSafeArtifactDirectory,
  readArtifactSafe,
  writeArtifactAtomic,
  writeArtifactExclusiveOrVerifyExact,
} from "../artifacts/store.ts";
import { resolveArtifactRoots, type ArtifactRoots } from "../artifacts/paths.ts";
import {
  parseResultEnvelope,
  type ResultEnvelopeV1,
} from "./contracts.ts";

const GENERATION_FILE = /^(\d{6})\.json$/;

export function parseGenerationResultFileName(name: string): number | undefined {
  const match = GENERATION_FILE.exec(name);
  if (!match) return undefined;
  const generation = Number.parseInt(match[1]!, 10);
  return generation >= 1 ? generation : undefined;
}

export function generationResultFileName(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 999_999) {
    throw new Error("Result generation must be an integer from 1 through 999999");
  }
  return `${String(generation).padStart(6, "0")}.json`;
}

export function resultDirectoryPath(checkout: string, runId: string): string {
  return join(resolve(checkout), ".subagents", "runs", runId, "results");
}

export function resultFilePath(checkout: string, runId: string, generation: number): string {
  return join(resultDirectoryPath(checkout, runId), generationResultFileName(generation));
}

export async function artifactRootsForCheckout(checkout: string): Promise<ArtifactRoots> {
  return resolveArtifactRoots({ checkout, allowProgress: false });
}

export async function ensureResultDirectory(checkout: string, runId: string, roots?: ArtifactRoots): Promise<string> {
  const resolvedRoots = roots ?? await artifactRootsForCheckout(checkout);
  const directory = resultDirectoryPath(checkout, runId);
  await ensureSafeArtifactDirectory(directory, resolvedRoots);
  return directory;
}

export async function writeResultEnvelope(
  checkout: string,
  envelope: ResultEnvelopeV1,
  roots?: ArtifactRoots,
  options: { readonly replace?: boolean } = {},
): Promise<string> {
  const resolvedRoots = roots ?? await artifactRootsForCheckout(checkout);
  await ensureResultDirectory(checkout, envelope.runId, resolvedRoots);
  const path = resultFilePath(checkout, envelope.runId, envelope.generation);
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  if (options.replace === true) {
    await writeArtifactAtomic(path, body, resolvedRoots, { mode: 0o600, replace: true });
    return path;
  }
  const outcome = await writeArtifactExclusiveOrVerifyExact(path, body, resolvedRoots, { mode: 0o600 });
  if (outcome === "existing-exact") {
    return path;
  }
  return path;
}

export async function updateResultEnvelope(
  checkout: string,
  runId: string,
  generation: number,
  update: (current: ResultEnvelopeV1) => ResultEnvelopeV1,
  roots?: ArtifactRoots,
): Promise<ResultEnvelopeV1> {
  const resolvedRoots = roots ?? await artifactRootsForCheckout(checkout);
  const path = resultFilePath(checkout, runId, generation);
  const current = parseResultEnvelope(JSON.parse((await readArtifactSafe(path, resolvedRoots)).toString("utf8")) as unknown);
  const next = update(current);
  if (
    next.resultId !== current.resultId
    || next.runId !== current.runId
    || next.runNonce !== current.runNonce
    || next.generation !== current.generation
    || next.requestNonce !== current.requestNonce
    || next.source !== current.source
    || next.rawText !== current.rawText
    || next.rawTextSha256 !== current.rawTextSha256
  ) {
    throw new Error("Result envelope immutable fields cannot change on update");
  }
  if (current.deliveredText !== undefined && next.deliveredText !== undefined && current.deliveredText !== next.deliveredText) {
    throw new Error("Result envelope deliveredText is assigned once and cannot change");
  }
  await writeArtifactAtomic(path, `${JSON.stringify(next, null, 2)}\n`, resolvedRoots, { mode: 0o600, replace: true });
  return next;
}

export async function readResultEnvelope(
  checkout: string,
  runId: string,
  generation: number,
  roots?: ArtifactRoots,
): Promise<ResultEnvelopeV1 | undefined> {
  const resolvedRoots = roots ?? await artifactRootsForCheckout(checkout);
  const path = resultFilePath(checkout, runId, generation);
  try {
    const raw = await readArtifactSafe(path, resolvedRoots);
    return parseResultEnvelope(JSON.parse(raw.toString("utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listResultEnvelopes(
  checkout: string,
  runId: string,
  roots?: ArtifactRoots,
): Promise<readonly ResultEnvelopeV1[]> {
  const resolvedRoots = roots ?? await artifactRootsForCheckout(checkout);
  const directory = resultDirectoryPath(checkout, runId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const generations = names
    .map(parseGenerationResultFileName)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  const envelopes: ResultEnvelopeV1[] = [];
  for (const generation of generations) {
    const envelope = await readResultEnvelope(checkout, runId, generation, resolvedRoots);
    if (envelope) envelopes.push(envelope);
  }
  return envelopes;
}

/** Envelopes that may still need dispatch (not yet parent-persisted). */
export async function listUndeliveredResultEnvelopes(
  checkout: string,
  runId: string,
  roots?: ArtifactRoots,
): Promise<readonly ResultEnvelopeV1[]> {
  const all = await listResultEnvelopes(checkout, runId, roots);
  return all.filter((envelope) =>
    envelope.delivery.stage === "captured" || envelope.delivery.stage === "dispatched"
  );
}
