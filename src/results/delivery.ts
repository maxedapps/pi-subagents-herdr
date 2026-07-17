import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiBranchEntry } from "../runtime/ownership.ts";
import { recoverActiveBranchOwnership } from "../runtime/ownership.ts";
import {
  assertMonotonicDeliveryStage,
  deliveryStageRank,
  MODEL_VISIBLE_BYTE_LIMIT,
  RESULT_CUSTOM_TYPE,
  RESULT_SENTINEL_PREFIX,
  type DeliveryStage,
  type ResultEnvelopeV1,
} from "./contracts.ts";
import { boundUtf8HeadTail } from "./presentation.ts";
import { updateResultEnvelope } from "./store.ts";

export interface DeliveryAuthorizationInput {
  readonly runId: string;
  readonly runNonce: string;
  readonly parentSessionId: string;
  readonly parentSessionPath?: string;
  readonly terminalId?: string;
  readonly nativeSession?: { readonly kind: "id" | "path"; readonly value: string; readonly source: string };
  readonly branch: readonly PiBranchEntry[];
  readonly sessionId: string;
  readonly sessionPath?: string;
}

export interface DeliveryItem {
  readonly envelope: ResultEnvelopeV1;
  readonly profileName: string;
  readonly terminalId?: string;
  readonly nativeSession?: { readonly kind: "id" | "path"; readonly value: string; readonly source: string };
  /** Optional same-revision action block carried by this result delivery. */
  readonly actionText?: string;
}

export interface DeliveryRuntimeHooks {
  readonly pi: ExtensionAPI;
  readonly getContext: () => ExtensionContext | undefined;
  readonly getCheckout: () => string | undefined;
  readonly runtimeEpoch: string;
  readonly listQueued: () => Promise<readonly DeliveryItem[]>;
  readonly onStageAdvanced?: (envelope: ResultEnvelopeV1) => void;
}

const DISPATCH_DEBOUNCE_MS = 50;
const REDISPATCH_GRACE_MS = 250;

export function authorizeResultDelivery(input: DeliveryAuthorizationInput): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.sessionId !== input.parentSessionId) {
    return { ok: false, reason: "Parent session ID does not match the result/journal parent" };
  }
  if (input.parentSessionPath !== undefined && input.sessionPath !== undefined && input.parentSessionPath !== input.sessionPath) {
    return { ok: false, reason: "Parent session path does not match the result/journal parent" };
  }
  if (input.parentSessionPath !== undefined && input.sessionPath === undefined) {
    return { ok: false, reason: "Parent session path is required when the journal/result records one" };
  }
  const recovered = recoverActiveBranchOwnership(input.branch).get(input.runId);
  if (!recovered || recovered.state === "uncertain") {
    return { ok: false, reason: recovered?.state === "uncertain" ? recovered.issues.join("; ") : "Run ownership journal is not active on the current branch" };
  }
  if (recovered.state !== "owned") {
    return { ok: false, reason: `Active-branch ownership is ${recovered.state}` };
  }
  const journal = recovered.journal;
  if (journal.runNonce !== input.runNonce) {
    return { ok: false, reason: "Active-branch journal run nonce does not match" };
  }
  if (journal.parent.sessionId !== input.parentSessionId) {
    return { ok: false, reason: "Active-branch journal parent session does not match" };
  }
  if (
    journal.parent.sessionPath !== undefined
    && (input.parentSessionPath === undefined || journal.parent.sessionPath !== input.parentSessionPath)
  ) {
    return { ok: false, reason: "Active-branch journal parent session path does not match" };
  }
  if (journal.resources.terminalId !== undefined) {
    if (input.terminalId === undefined) {
      return { ok: false, reason: "Terminal identity is required for delivery authorization" };
    }
    if (journal.resources.terminalId !== input.terminalId) {
      return { ok: false, reason: "Active-branch journal terminal identity does not match" };
    }
  }
  if (journal.resources.nativeSession !== undefined) {
    if (input.nativeSession === undefined) {
      return { ok: false, reason: "Native session identity is required for delivery authorization" };
    }
    if (JSON.stringify(journal.resources.nativeSession) !== JSON.stringify(input.nativeSession)) {
      return { ok: false, reason: "Active-branch journal native session does not match" };
    }
  }
  return { ok: true };
}

/** One result → one model-visible payload (no multi-result batching). */
export function buildDeliveredText(input: {
  readonly envelope: ResultEnvelopeV1;
  readonly profileName: string;
  readonly deliveryId: string;
  readonly actionText?: string;
  readonly maxBytes?: number;
}): string {
  const { envelope, profileName } = input;
  const header = [
    `${RESULT_SENTINEL_PREFIX} ${JSON.stringify({
      resultId: envelope.resultId,
      deliveryId: input.deliveryId,
      runId: envelope.runId,
      profile: profileName,
      generation: envelope.generation,
      source: envelope.source,
      limitations: "structured-final",
      ...(envelope.stopReason && envelope.stopReason !== "stop" ? { stopReason: envelope.stopReason } : {}),
      ...(envelope.emptyFinal ? { emptyFinal: true } : {}),
    })}`,
    `Subagent result for ${envelope.runId} (${profileName}) generation ${envelope.generation}`,
    `source=${envelope.source} stage=${envelope.delivery.stage}`,
    "",
  ].join("\n");
  const action = input.actionText ? `\n\n${input.actionText}` : "";
  return boundUtf8HeadTail(`${header}${envelope.rawText}${action}`, input.maxBytes ?? MODEL_VISIBLE_BYTE_LIMIT).text;
}

export function computeDeliveryId(resultId: string, payloadHash: string): string {
  return `del-${createHash("sha256").update(`${resultId}\0${payloadHash}`, "utf8").digest("hex").slice(0, 24)}`;
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
      .map((block) => String((block as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

export function findPersistedResultMessage(
  branch: readonly PiBranchEntry[],
  deliveryId: string,
): PiBranchEntry | undefined {
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    if ((message as { customType?: unknown }).customType !== RESULT_CUSTOM_TYPE) continue;
    const text = messageText(message as { content?: unknown });
    if (text.includes(deliveryId) || text.includes(`"deliveryId":${JSON.stringify(deliveryId)}`)) return entry;
  }
  return undefined;
}

export function findPersistedResultByResultId(
  branch: readonly PiBranchEntry[],
  resultId: string,
): PiBranchEntry | undefined {
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    if ((message as { customType?: unknown }).customType !== RESULT_CUSTOM_TYPE) continue;
    const text = messageText(message as { content?: unknown });
    if (text.includes(resultId)) return entry;
  }
  return undefined;
}

function advanceStage(from: DeliveryStage, to: DeliveryStage): DeliveryStage {
  if (deliveryStageRank(to) < deliveryStageRank(from)) return from;
  assertMonotonicDeliveryStage(from, to);
  return to;
}

export class ResultDeliveryService {
  readonly #hooks: DeliveryRuntimeHooks;
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #stopped = false;
  #parentSettledPending = false;

  constructor(hooks: DeliveryRuntimeHooks) {
    this.#hooks = hooks;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  scheduleFlush(delayMs = DISPATCH_DEBOUNCE_MS): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch(() => undefined);
    }, delayMs);
    this.#timer.unref?.();
  }

  noteParentSettled(): void {
    this.#parentSettledPending = true;
    this.scheduleFlush(REDISPATCH_GRACE_MS);
  }

  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#flushLocked().finally(() => { this.#flushing = undefined; });
    return this.#flushing;
  }

  async #flushLocked(): Promise<void> {
    if (this.#stopped) return;
    const context = this.#hooks.getContext();
    const checkout = this.#hooks.getCheckout();
    if (!context || !checkout) return;

    const sessionId = context.sessionManager.getSessionId();
    const sessionPath = context.sessionManager.getSessionFile();
    const branch = context.sessionManager.getBranch() as readonly PiBranchEntry[];
    const queued = await this.#hooks.listQueued();
    if (queued.length === 0) return;

    // One result per delivery — stable order by capture time then result id.
    const ordered = [...queued].sort((left, right) => {
      if (left.envelope.capturedAt !== right.envelope.capturedAt) return left.envelope.capturedAt - right.envelope.capturedAt;
      return left.envelope.resultId.localeCompare(right.envelope.resultId);
    });

    for (const item of ordered) {
      const auth = authorizeResultDelivery({
        runId: item.envelope.runId,
        runNonce: item.envelope.runNonce,
        parentSessionId: item.envelope.delivery.parentSessionId,
        ...(item.envelope.delivery.parentSessionPath === undefined ? {} : { parentSessionPath: item.envelope.delivery.parentSessionPath }),
        ...(item.terminalId === undefined ? {} : { terminalId: item.terminalId }),
        ...(item.nativeSession === undefined ? {} : { nativeSession: item.nativeSession }),
        branch,
        sessionId,
        ...(sessionPath === undefined ? {} : { sessionPath }),
      });
      if (!auth.ok) continue;

      const existing = findPersistedResultByResultId(branch, item.envelope.resultId);
      if (existing) {
        if (deliveryStageRank(item.envelope.delivery.stage) < deliveryStageRank("parent_persisted")) {
          const advanced = await updateResultEnvelope(checkout, item.envelope.runId, item.envelope.generation, (current) => ({
            ...current,
            ...(current.deliveredText === undefined
              ? {
                  deliveredText: buildDeliveredText({
                    envelope: current,
                    profileName: item.profileName,
                    deliveryId: current.delivery.deliveryId
                      ?? computeDeliveryId(current.resultId, createHash("sha256").update(current.rawText, "utf8").digest("hex")),
                    ...(item.actionText === undefined ? {} : { actionText: item.actionText }),
                  }),
                }
              : {}),
            delivery: {
              ...current.delivery,
              stage: advanceStage(current.delivery.stage, "parent_persisted"),
              parentEntryId: existing.id,
              inFlight: false,
            },
          }));
          this.#hooks.onStageAdvanced?.(advanced);
        }
        continue;
      }

      if (item.envelope.delivery.stage === "parent_persisted") continue;

      const inflightSameEpoch = item.envelope.delivery.inFlight
        && item.envelope.delivery.runtimeEpoch === this.#hooks.runtimeEpoch
        && item.envelope.delivery.stage === "dispatched"
        && !this.#parentSettledPending;
      if (inflightSameEpoch) continue;

      // Build payload in memory; freeze deliveredText once at dispatch.
      const provisionalHash = createHash("sha256").update(item.envelope.rawText, "utf8").digest("hex");
      const deliveryId = item.envelope.delivery.deliveryId
        ?? computeDeliveryId(item.envelope.resultId, provisionalHash);
      const existingDelivery = findPersistedResultMessage(branch, deliveryId);
      if (existingDelivery) {
        const advanced = await updateResultEnvelope(checkout, item.envelope.runId, item.envelope.generation, (current) => ({
          ...current,
          ...(current.deliveredText === undefined
            ? { deliveredText: buildDeliveredText({ envelope: current, profileName: item.profileName, deliveryId, ...(item.actionText === undefined ? {} : { actionText: item.actionText }) }) }
            : {}),
          delivery: {
            ...current.delivery,
            stage: advanceStage(current.delivery.stage, "parent_persisted"),
            deliveryId: current.delivery.deliveryId ?? deliveryId,
            parentEntryId: existingDelivery.id,
            inFlight: false,
          },
        }));
        this.#hooks.onStageAdvanced?.(advanced);
        continue;
      }

      let sendText = item.envelope.deliveredText;
      const advanced = await updateResultEnvelope(checkout, item.envelope.runId, item.envelope.generation, (current) => {
        const frozen = current.deliveredText ?? buildDeliveredText({
          envelope: current,
          profileName: item.profileName,
          deliveryId: current.delivery.deliveryId ?? deliveryId,
          ...(item.actionText === undefined ? {} : { actionText: item.actionText }),
        });
        return {
          ...current,
          deliveredText: frozen,
          delivery: {
            ...current.delivery,
            stage: advanceStage(current.delivery.stage, "dispatched"),
            deliveryId: current.delivery.deliveryId ?? deliveryId,
            attempt: (current.delivery.attempt ?? 0) + 1,
            attemptedAt: Date.now(),
            runtimeEpoch: this.#hooks.runtimeEpoch,
            inFlight: true,
          },
        };
      });
      sendText = advanced.deliveredText ?? sendText;
      this.#hooks.onStageAdvanced?.(advanced);
      if (!sendText) continue;

      this.#hooks.pi.sendMessage({
        customType: RESULT_CUSTOM_TYPE,
        content: sendText,
        display: true,
        details: { deliveryId: advanced.delivery.deliveryId ?? deliveryId, resultIds: [advanced.resultId] },
      }, { deliverAs: "followUp", triggerTurn: true });
    }

    this.#parentSettledPending = false;
    setTimeout(() => {
      void this.reconcilePersistence().catch(() => undefined);
    }, 0).unref?.();
  }

  async reconcilePersistence(): Promise<void> {
    const context = this.#hooks.getContext();
    const checkout = this.#hooks.getCheckout();
    if (!context || !checkout) return;
    const branch = context.sessionManager.getBranch() as readonly PiBranchEntry[];
    const queued = await this.#hooks.listQueued();
    for (const item of queued) {
      if (item.envelope.delivery.stage !== "dispatched" && item.envelope.delivery.stage !== "captured") continue;
      const byResult = findPersistedResultByResultId(branch, item.envelope.resultId);
      const byDelivery = item.envelope.delivery.deliveryId
        ? findPersistedResultMessage(branch, item.envelope.delivery.deliveryId)
        : undefined;
      const entry = byResult ?? byDelivery;
      if (!entry) continue;
      const advanced = await updateResultEnvelope(checkout, item.envelope.runId, item.envelope.generation, (current) => ({
        ...current,
        delivery: {
          ...current.delivery,
          stage: advanceStage(current.delivery.stage, "parent_persisted"),
          parentEntryId: entry.id,
          inFlight: false,
        },
      }));
      this.#hooks.onStageAdvanced?.(advanced);
    }
  }
}
