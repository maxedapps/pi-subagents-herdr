import type { Harness } from "../contracts/harness.ts";
import {
  createCapturedResult,
  parseBridgeResponse,
  type CapturedResult,
  type GenerationSummary,
} from "./contracts.ts";
import { readBridgeResponse } from "./child-bridge.ts";

export interface PendingGeneration {
  readonly generation: number;
  readonly requestNonce: string;
  readonly summary: GenerationSummary;
}

export interface ExtractorRunView {
  readonly id: string;
  readonly runNonce: string;
  readonly harness: Harness;
  readonly ephemeral?: {
    readonly directory: string;
    readonly resultExchangeDirectory?: string;
  };
}

export type CaptureOutcome =
  | { readonly kind: "captured"; readonly result: CapturedResult }
  | { readonly kind: "not-ready" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Capture the structured Pi bridge response for one generation.
 * There is no terminal or legacy path: missing/malformed/non-Pi yields not-ready or unavailable.
 */
export async function tryCapturePiBridge(input: {
  readonly run: ExtractorRunView;
  readonly generation: PendingGeneration;
  readonly graceExpired?: boolean;
}): Promise<CaptureOutcome> {
  if (input.run.harness !== "pi") {
    return { kind: "unavailable", reason: `Harness ${input.run.harness} has no structured final-message capture` };
  }
  const exchange = input.run.ephemeral?.resultExchangeDirectory;
  if (!exchange) {
    return { kind: "unavailable", reason: "Pi child has no result-exchange directory" };
  }
  const response = await readBridgeResponse(exchange, input.generation.generation);
  if (!response) {
    if (input.graceExpired) {
      return { kind: "unavailable", reason: "Pi bridge response file missing after settlement grace" };
    }
    return { kind: "not-ready" };
  }
  try {
    const validated = parseBridgeResponse(response);
    if (
      validated.runId !== input.run.id
      || validated.runNonce !== input.run.runNonce
      || validated.generation !== input.generation.generation
      || validated.requestNonce !== input.generation.requestNonce
    ) {
      return { kind: "unavailable", reason: "Pi bridge response identity does not match the pending generation" };
    }
    return {
      kind: "captured",
      result: createCapturedResult({
        runId: input.run.id,
        runNonce: input.run.runNonce,
        generation: input.generation.generation,
        requestNonce: input.generation.requestNonce,
        rawText: validated.rawText,
        stopReason: validated.stopReason,
        emptyFinal: validated.emptyFinal,
        ...(validated.messageIdentity === undefined ? {} : { messageIdentity: validated.messageIdentity }),
      }),
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `Pi bridge response malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
