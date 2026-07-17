import { createHash } from "node:crypto";

export const RESULT_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const RESULT_REQUEST_MARKER = "HERDR_RESULT_REQUEST_V1" as const;
export const RESULT_CUSTOM_TYPE = "herdr-subagents.result.v1" as const;
export const RESULT_SENTINEL_PREFIX = "HERDR_RESULT_V1" as const;
export const MODEL_VISIBLE_BYTE_LIMIT = 48 * 1024;

/** Exact Pi finals and truthfully labeled bounded Herdr terminal transcripts. */
export type ResultSource = "pi-final-assistant" | "herdr-terminal-output";

export interface TerminalOutputMetadata {
  readonly outputRevision: number;
  readonly truncated: boolean;
}

/**
 * Delivery stages (truthful, minimal):
 * - captured: durable result file exists
 * - dispatched: sendMessage requested (may still be memory-queued)
 * - parent_persisted: matching custom message on the active branch
 */
export type DeliveryStage = "captured" | "dispatched" | "parent_persisted";

/** Single generation lifecycle — no dual submission/capture machines. */
export type GenerationPhase = "preparing" | "submitted" | "captured" | "closed" | "blocked";

/** Certainty of pane-input delivery once phase is submitted. */
export type SubmissionCertainty = "confirmed" | "unconfirmed" | "uncertain";

export interface ResultDeliveryState {
  readonly stage: DeliveryStage;
  readonly parentSessionId: string;
  readonly parentSessionPath?: string;
  readonly parentEntryId?: string;
  readonly deliveryId?: string;
  readonly attempt?: number;
  readonly attemptedAt?: number;
  readonly runtimeEpoch?: string;
  readonly inFlight?: boolean;
  readonly lastError?: string;
}

export interface ResultEnvelopeV1 {
  readonly schemaVersion: typeof RESULT_ENVELOPE_SCHEMA_VERSION;
  readonly resultId: string;
  readonly runId: string;
  readonly runNonce: string;
  readonly generation: number;
  readonly requestNonce: string;
  readonly source: ResultSource;
  readonly terminalOutput?: TerminalOutputMetadata;
  readonly rawText: string;
  readonly rawTextSha256: string;
  readonly capturedAt: number;
  readonly deliveredText?: string;
  readonly stopReason?: string;
  readonly emptyFinal?: boolean;
  readonly messageIdentity?: string;
  readonly delivery: ResultDeliveryState;
}

export interface GenerationSummary {
  readonly generation: number;
  readonly requestNonce: string;
  readonly inputSha256: string;
  readonly phase: GenerationPhase;
  /** Set once input has been attempted (phase submitted or later). */
  readonly certainty?: SubmissionCertainty;
  readonly resultId?: string;
  readonly source?: ResultSource;
  readonly preparedAt: number;
  readonly closedReason?: string;
}

export interface BridgeResponseV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly runNonce: string;
  readonly generation: number;
  readonly requestNonce: string;
  readonly rawText: string;
  readonly stopReason: string;
  readonly emptyFinal: boolean;
  readonly messageIdentity?: string;
  readonly publishedAt: number;
}

export interface ResultRequestMarker {
  readonly runId: string;
  readonly runNonce: string;
  readonly generation: number;
  readonly requestNonce: string;
}

/** Compact status projection — no internal delivery attempt/epoch noise. */
export interface PublicResultView {
  readonly resultId: string;
  readonly generation: number;
  readonly source: ResultSource;
  readonly terminalOutput?: TerminalOutputMetadata;
  readonly deliveryStage: DeliveryStage;
  readonly rawTextSha256: string;
  readonly stopReason?: string;
  readonly emptyFinal?: boolean;
  readonly deliveredText?: string;
}

export interface CapturedResult {
  readonly resultId: string;
  readonly runId: string;
  readonly runNonce: string;
  readonly generation: number;
  readonly requestNonce: string;
  readonly source: ResultSource;
  readonly terminalOutput?: TerminalOutputMetadata;
  readonly rawText: string;
  readonly rawTextSha256: string;
  readonly capturedAt: number;
  readonly stopReason?: string;
  readonly emptyFinal?: boolean;
  readonly messageIdentity?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL`);
  }
}

function positiveInt(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
}

function nonNegInt(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeResultId(input: {
  readonly runId: string;
  readonly runNonce: string;
  readonly generation: number;
  readonly requestNonce: string;
  readonly rawTextSha256: string;
  readonly source: ResultSource;
}): string {
  const material = [
    input.runId,
    input.runNonce,
    String(input.generation),
    input.requestNonce,
    input.rawTextSha256,
    input.source,
  ].join("\0");
  return `res-${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32)}`;
}

export function parseResultSource(value: unknown): ResultSource {
  if (value === "pi-final-assistant" || value === "herdr-terminal-output") return value;
  throw new Error("result source is malformed");
}

export function parseTerminalOutputMetadata(value: unknown): TerminalOutputMetadata {
  if (!isRecord(value)) throw new Error("result terminalOutput is malformed");
  nonNegInt(value.outputRevision, "result terminalOutput outputRevision");
  if (typeof value.truncated !== "boolean") throw new Error("result terminalOutput truncated is malformed");
  return value as unknown as TerminalOutputMetadata;
}

export function parseDeliveryStage(value: unknown): DeliveryStage {
  if (value === "captured" || value === "dispatched" || value === "parent_persisted") return value;
  throw new Error("delivery stage is malformed");
}

const STAGE_RANK: Readonly<Record<DeliveryStage, number>> = {
  captured: 0,
  dispatched: 1,
  parent_persisted: 2,
};

export function assertMonotonicDeliveryStage(from: DeliveryStage, to: DeliveryStage): void {
  if (STAGE_RANK[to] < STAGE_RANK[from]) {
    throw new Error(`Delivery stage regression from ${from} to ${to} is not allowed`);
  }
}

export function deliveryStageRank(stage: DeliveryStage): number {
  return STAGE_RANK[stage];
}

export function parseGenerationPhase(value: unknown): GenerationPhase {
  if (
    value === "preparing"
    || value === "submitted"
    || value === "captured"
    || value === "closed"
    || value === "blocked"
  ) return value;
  throw new Error("generation phase is malformed");
}

export function parseSubmissionCertainty(value: unknown): SubmissionCertainty {
  if (value === "confirmed" || value === "unconfirmed" || value === "uncertain") return value;
  throw new Error("submission certainty is malformed");
}

export function parseResultDeliveryState(value: unknown): ResultDeliveryState {
  if (!isRecord(value)) throw new Error("result delivery state is malformed");
  parseDeliveryStage(value.stage);
  nonEmpty(value.parentSessionId, "result delivery parentSessionId");
  if (value.parentSessionPath !== undefined) nonEmpty(value.parentSessionPath, "result delivery parentSessionPath");
  if (value.parentEntryId !== undefined) nonEmpty(value.parentEntryId, "result delivery parentEntryId");
  if (value.deliveryId !== undefined) nonEmpty(value.deliveryId, "result delivery deliveryId");
  if (value.attempt !== undefined) positiveInt(value.attempt, "result delivery attempt");
  if (value.attemptedAt !== undefined) nonNegInt(value.attemptedAt, "result delivery attemptedAt");
  if (value.runtimeEpoch !== undefined) nonEmpty(value.runtimeEpoch, "result delivery runtimeEpoch");
  if (value.inFlight !== undefined && typeof value.inFlight !== "boolean") throw new Error("result delivery inFlight is malformed");
  if (value.lastError !== undefined) nonEmpty(value.lastError, "result delivery lastError");
  return value as unknown as ResultDeliveryState;
}

export function parseResultEnvelope(value: unknown): ResultEnvelopeV1 {
  if (!isRecord(value) || value.schemaVersion !== RESULT_ENVELOPE_SCHEMA_VERSION) {
    throw new Error("result envelope schema is malformed");
  }
  for (const key of ["resultId", "runId", "runNonce", "requestNonce", "rawTextSha256"] as const) {
    nonEmpty(value[key], `result envelope ${key}`);
  }
  positiveInt(value.generation, "result envelope generation");
  nonNegInt(value.capturedAt, "result envelope capturedAt");
  if (typeof value.rawText !== "string" || value.rawText.includes("\0")) throw new Error("result envelope rawText is malformed");
  const source = parseResultSource(value.source);
  if (source === "herdr-terminal-output") {
    parseTerminalOutputMetadata(value.terminalOutput);
    if ((value.rawText as string).trim().length === 0) throw new Error("terminal result rawText must be non-empty");
  } else if (value.terminalOutput !== undefined) {
    throw new Error("Pi final result must not include terminalOutput metadata");
  }
  const rawTextSha256 = sha256Text(value.rawText as string);
  if (rawTextSha256 !== value.rawTextSha256) throw new Error("result envelope rawTextSha256 does not match rawText");
  const expectedId = computeResultId({
    runId: value.runId as string,
    runNonce: value.runNonce as string,
    generation: value.generation as number,
    requestNonce: value.requestNonce as string,
    rawTextSha256,
    source,
  });
  if (expectedId !== value.resultId) throw new Error("result envelope resultId does not match immutable fields");
  if (value.deliveredText !== undefined && (typeof value.deliveredText !== "string" || value.deliveredText.includes("\0"))) {
    throw new Error("result envelope deliveredText is malformed");
  }
  if (value.stopReason !== undefined) nonEmpty(value.stopReason, "result envelope stopReason");
  if (value.emptyFinal !== undefined && typeof value.emptyFinal !== "boolean") throw new Error("result envelope emptyFinal is malformed");
  if (value.messageIdentity !== undefined) nonEmpty(value.messageIdentity, "result envelope messageIdentity");
  parseResultDeliveryState(value.delivery);
  return value as unknown as ResultEnvelopeV1;
}

export function parseGenerationSummary(value: unknown): GenerationSummary {
  if (!isRecord(value)) throw new Error("generation summary is malformed");
  positiveInt(value.generation, "generation summary generation");
  nonEmpty(value.requestNonce, "generation summary requestNonce");
  nonEmpty(value.inputSha256, "generation summary inputSha256");
  parseGenerationPhase(value.phase);
  nonNegInt(value.preparedAt, "generation summary preparedAt");
  if (value.certainty !== undefined) parseSubmissionCertainty(value.certainty);
  if (value.resultId !== undefined) nonEmpty(value.resultId, "generation summary resultId");
  if (value.source !== undefined) parseResultSource(value.source);
  if (value.closedReason !== undefined) nonEmpty(value.closedReason, "generation summary closedReason");
  return value as unknown as GenerationSummary;
}

export function parseBridgeResponse(value: unknown): BridgeResponseV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("bridge response schema is malformed");
  for (const key of ["runId", "runNonce", "requestNonce", "stopReason"] as const) nonEmpty(value[key], `bridge response ${key}`);
  positiveInt(value.generation, "bridge response generation");
  nonNegInt(value.publishedAt, "bridge response publishedAt");
  if (typeof value.rawText !== "string" || value.rawText.includes("\0")) throw new Error("bridge response rawText is malformed");
  if (typeof value.emptyFinal !== "boolean") throw new Error("bridge response emptyFinal is malformed");
  if (value.messageIdentity !== undefined) nonEmpty(value.messageIdentity, "bridge response messageIdentity");
  return value as unknown as BridgeResponseV1;
}

export function parseResultRequestMarker(value: unknown): ResultRequestMarker {
  if (!isRecord(value)) throw new Error("result request marker is malformed");
  nonEmpty(value.runId, "result request runId");
  nonEmpty(value.runNonce, "result request runNonce");
  nonEmpty(value.requestNonce, "result request requestNonce");
  positiveInt(value.generation, "result request generation");
  return {
    runId: value.runId,
    runNonce: value.runNonce,
    generation: value.generation,
    requestNonce: value.requestNonce,
  };
}

export function formatResultRequestWire(marker: ResultRequestMarker, taskOrFollowUp: string): string {
  if (taskOrFollowUp.includes("\0")) throw new Error("Wrapped task text must not contain NUL bytes");
  const header = `${RESULT_REQUEST_MARKER} ${JSON.stringify({
    runId: marker.runId,
    runNonce: marker.runNonce,
    generation: marker.generation,
    requestNonce: marker.requestNonce,
  })}`;
  return `${header}\n---\n${JSON.stringify(taskOrFollowUp)}`;
}

export function parseResultRequestWire(text: string): { readonly marker: ResultRequestMarker; readonly task: string } | undefined {
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0) return undefined;
  const firstLine = text.slice(0, firstNewline);
  if (!firstLine.startsWith(`${RESULT_REQUEST_MARKER} `)) return undefined;
  const jsonPart = firstLine.slice(RESULT_REQUEST_MARKER.length + 1);
  let marker: ResultRequestMarker;
  try {
    marker = parseResultRequestMarker(JSON.parse(jsonPart) as unknown);
  } catch {
    return undefined;
  }
  const rest = text.slice(firstNewline + 1);
  if (!rest.startsWith("---\n")) return undefined;
  try {
    const task = JSON.parse(rest.slice(4)) as unknown;
    if (typeof task !== "string") return undefined;
    return { marker, task };
  } catch {
    return undefined;
  }
}

export function generationIsOpen(summary: GenerationSummary): boolean {
  return summary.phase === "preparing" || summary.phase === "submitted";
}

export function generationAwaitingCapture(summary: GenerationSummary): boolean {
  return summary.phase === "submitted";
}

export function toPublicResultView(envelope: ResultEnvelopeV1): PublicResultView {
  return {
    resultId: envelope.resultId,
    generation: envelope.generation,
    source: envelope.source,
    ...(envelope.terminalOutput === undefined ? {} : { terminalOutput: envelope.terminalOutput }),
    deliveryStage: envelope.delivery.stage,
    rawTextSha256: envelope.rawTextSha256,
    ...(envelope.emptyFinal === undefined ? {} : { emptyFinal: envelope.emptyFinal }),
    ...(envelope.stopReason === undefined ? {} : { stopReason: envelope.stopReason }),
    ...(envelope.deliveredText === undefined ? {} : { deliveredText: envelope.deliveredText }),
  };
}

export function createCapturedResult(input: {
  readonly runId: string;
  readonly runNonce: string;
  readonly generation: number;
  readonly requestNonce: string;
  readonly source: ResultSource;
  readonly terminalOutput?: TerminalOutputMetadata;
  readonly rawText: string;
  readonly stopReason?: string;
  readonly emptyFinal?: boolean;
  readonly messageIdentity?: string;
  readonly capturedAt?: number;
}): CapturedResult {
  const source = input.source;
  if (source === "herdr-terminal-output") {
    if (!input.terminalOutput) throw new Error("herdr-terminal-output requires terminalOutput metadata");
    parseTerminalOutputMetadata(input.terminalOutput);
    if (input.rawText.trim().length === 0) throw new Error("herdr-terminal-output requires non-empty text");
  } else if (input.terminalOutput !== undefined) {
    throw new Error("pi-final-assistant must not include terminalOutput metadata");
  }
  const rawTextSha256 = sha256Text(input.rawText);
  const resultId = computeResultId({
    runId: input.runId,
    runNonce: input.runNonce,
    generation: input.generation,
    requestNonce: input.requestNonce,
    rawTextSha256,
    source,
  });
  return {
    resultId,
    runId: input.runId,
    runNonce: input.runNonce,
    generation: input.generation,
    requestNonce: input.requestNonce,
    source,
    ...(input.terminalOutput === undefined ? {} : { terminalOutput: input.terminalOutput }),
    rawText: input.rawText,
    rawTextSha256,
    capturedAt: input.capturedAt ?? Date.now(),
    ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
    ...(input.emptyFinal === undefined ? {} : { emptyFinal: input.emptyFinal }),
    ...(input.messageIdentity === undefined ? {} : { messageIdentity: input.messageIdentity }),
  };
}

export function capturedToEnvelope(
  captured: CapturedResult,
  delivery: ResultDeliveryState,
  deliveredText?: string,
): ResultEnvelopeV1 {
  return {
    schemaVersion: RESULT_ENVELOPE_SCHEMA_VERSION,
    resultId: captured.resultId,
    runId: captured.runId,
    runNonce: captured.runNonce,
    generation: captured.generation,
    requestNonce: captured.requestNonce,
    source: captured.source,
    ...(captured.terminalOutput === undefined ? {} : { terminalOutput: captured.terminalOutput }),
    rawText: captured.rawText,
    rawTextSha256: captured.rawTextSha256,
    capturedAt: captured.capturedAt,
    ...(deliveredText === undefined ? {} : { deliveredText }),
    ...(captured.stopReason === undefined ? {} : { stopReason: captured.stopReason }),
    ...(captured.emptyFinal === undefined ? {} : { emptyFinal: captured.emptyFinal }),
    ...(captured.messageIdentity === undefined ? {} : { messageIdentity: captured.messageIdentity }),
    delivery,
  };
}
