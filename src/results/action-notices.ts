import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { authorizeResultDelivery } from "./delivery.ts";
import { extractPersistedCustomMessage } from "./persisted-custom-message.ts";
import { boundUtf8HeadTail } from "./presentation.ts";

export const ACTION_NOTICE_CUSTOM_TYPE = "herdr-subagents.action-required.v1" as const;
export const ACTION_NOTICE_SENTINEL = "HERDR_ACTION_REQUIRED_V1" as const;

export type ActionKind =
  | "writer_review_required"
  | "blocked"
  | "failed"
  | "delivery_uncertain"
  | "cleanup_required"
  | "recovery_required";

export type ActionDeliveryStage = "derived" | "dispatched" | "parent_persisted";

export interface ActionFacts {
  readonly checkoutPath?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly head?: string;
  readonly clean?: boolean;
  readonly commitsAhead?: number;
  readonly noChanges?: boolean;
  readonly parentCheckoutPath?: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly terminalId?: string;
}

export interface RunAttention {
  readonly required: true;
  readonly kind: ActionKind;
  readonly noticeId: string;
  readonly revision: number;
  readonly reason: string;
  readonly nextActions: readonly string[];
  readonly facts?: ActionFacts;
  readonly delivery: {
    readonly stage: ActionDeliveryStage;
    readonly runtimeEpoch?: string;
  };
}

export interface PublicRunAttention extends Omit<RunAttention, "delivery"> {
  readonly deliveryStage: ActionDeliveryStage;
}

export interface ActionNoticeItem {
  readonly runId: string;
  readonly runNonce: string;
  readonly attention: RunAttention;
  readonly parentSessionId: string;
  readonly parentSessionPath?: string;
  readonly terminalId?: string;
  readonly nativeSession?: { readonly kind: "id" | "path"; readonly value: string; readonly source: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRunAttention(value: unknown): RunAttention {
  if (!isRecord(value) || value.required !== true || !["writer_review_required", "blocked", "failed", "delivery_uncertain", "cleanup_required", "recovery_required"].includes(String(value.kind))) {
    throw new Error("run attention is malformed");
  }
  for (const key of ["noticeId", "reason"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0 || value[key].includes("\0")) throw new Error(`run attention ${key} is malformed`);
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("run attention revision is malformed");
  if (!Array.isArray(value.nextActions) || !value.nextActions.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0"))) throw new Error("run attention nextActions are malformed");
  if (value.facts !== undefined) {
    if (!isRecord(value.facts)) throw new Error("run attention facts are malformed");
    const stringKeys = new Set(["checkoutPath", "branch", "base", "head", "parentCheckoutPath", "workspaceId", "tabId", "terminalId"]);
    const booleanKeys = new Set(["clean", "noChanges"]);
    for (const [key, fact] of Object.entries(value.facts)) {
      if (stringKeys.has(key)) { if (typeof fact !== "string" || fact.length === 0 || fact.includes("\0")) throw new Error(`run attention fact ${key} is malformed`); }
      else if (booleanKeys.has(key)) { if (typeof fact !== "boolean") throw new Error(`run attention fact ${key} is malformed`); }
      else if (key === "commitsAhead") { if (!Number.isSafeInteger(fact) || (fact as number) < 0) throw new Error("run attention commitsAhead is malformed"); }
      else throw new Error(`run attention fact ${key} is unknown`);
    }
  }
  if (!isRecord(value.delivery) || !["derived", "dispatched", "parent_persisted"].includes(String(value.delivery.stage))) throw new Error("run attention delivery is malformed");
  if (value.delivery.runtimeEpoch !== undefined && (typeof value.delivery.runtimeEpoch !== "string" || value.delivery.runtimeEpoch.length === 0)) throw new Error("run attention runtimeEpoch is malformed");
  return value as unknown as RunAttention;
}

export function toPublicRunAttention(attention: RunAttention): PublicRunAttention {
  const { delivery, ...rest } = attention;
  return { ...rest, deliveryStage: delivery.stage };
}

function semanticValue(input: {
  readonly kind: ActionKind;
  readonly reason: string;
  readonly nextActions: readonly string[];
  readonly facts?: ActionFacts;
}): string {
  return JSON.stringify({ kind: input.kind, reason: input.reason, nextActions: input.nextActions, facts: input.facts ?? null });
}

export function deriveRunAttention(
  runId: string,
  prior: RunAttention | undefined,
  input: {
    readonly kind: ActionKind;
    readonly reason: string;
    readonly nextActions: readonly string[];
    readonly facts?: ActionFacts;
  },
): RunAttention {
  if (prior && semanticValue(prior) === semanticValue(input)) return prior;
  const revision = (prior?.revision ?? 0) + 1;
  const digest = createHash("sha256").update(`${runId}\0${revision}\0${semanticValue(input)}`, "utf8").digest("hex").slice(0, 24);
  return {
    required: true,
    ...input,
    noticeId: `act-${digest}`,
    revision,
    delivery: { stage: "derived" },
  };
}

export function formatActionNotice(runId: string, attention: RunAttention): string {
  const facts = attention.facts;
  const lines = [
    `${ACTION_NOTICE_SENTINEL} ${JSON.stringify({ noticeId: attention.noticeId, runId, kind: attention.kind, revision: attention.revision })}`,
    `ACTION REQUIRED — ${attention.kind.replaceAll("_", " ")}`,
    `run=${runId}`,
  ];
  if (facts) {
    if (facts.checkoutPath) lines.push(`checkout=${facts.checkoutPath}`);
    if (facts.branch) lines.push(`branch=${facts.branch}`);
    if (facts.base || facts.head) lines.push(`base=${facts.base ?? "unknown"} head=${facts.head ?? "unknown"}`);
    if (facts.clean !== undefined || facts.commitsAhead !== undefined || facts.noChanges !== undefined) {
      lines.push(`clean=${facts.clean ?? "unknown"} commitsAhead=${facts.commitsAhead ?? "unknown"} noChanges=${facts.noChanges ?? "unknown"}`);
    }
    if (facts.workspaceId || facts.tabId || facts.terminalId) {
      lines.push(`workspace=${facts.workspaceId ?? "unknown"} tab=${facts.tabId ?? "unknown"} terminal=${facts.terminalId ?? "unknown"}`);
    }
  }
  lines.push(`reason=${attention.reason}`);
  for (const action of attention.nextActions) lines.push(`next=${action}`);
  return lines.join("\n");
}

export function findPersistedActionNotice(branch: readonly SessionEntry[], noticeId: string): SessionEntry | undefined {
  return branch.find((entry) => {
    const message = extractPersistedCustomMessage(entry);
    if (!message) return false;
    if (message.customType !== ACTION_NOTICE_CUSTOM_TYPE && message.customType !== "herdr-subagents.result.v1") return false;
    return message.text.split("\n").some((line) => {
      if (!line.startsWith(`${ACTION_NOTICE_SENTINEL} `)) return false;
      try {
        const parsed = JSON.parse(line.slice(ACTION_NOTICE_SENTINEL.length + 1)) as unknown;
        if (!isRecord(parsed)) return false;
        if (parsed.noticeId === noticeId) return true;
        if (!Array.isArray(parsed.noticeIds) || parsed.noticeIds.length === 0) return false;
        if (!parsed.noticeIds.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0"))) return false;
        if (new Set(parsed.noticeIds).size !== parsed.noticeIds.length) return false;
        return parsed.noticeIds.includes(noticeId);
      } catch { return false; }
    });
  });
}

export interface ActionNoticeHooks {
  readonly pi: ExtensionAPI;
  readonly runtimeEpoch: string;
  readonly getContext: () => ExtensionContext | undefined;
  readonly listQueued: () => Promise<readonly ActionNoticeItem[]>;
  readonly updateAttention: (runId: string, update: (current: RunAttention) => RunAttention) => Promise<RunAttention | undefined>;
}

const DEBOUNCE_MS = 50;
const REDISPATCH_GRACE_MS = 250;

export class ActionNoticeService {
  readonly #hooks: ActionNoticeHooks;
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #stopped = false;

  constructor(hooks: ActionNoticeHooks) { this.#hooks = hooks; }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  scheduleFlush(delayMs = DEBOUNCE_MS): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush().catch(() => undefined); }, delayMs);
    this.#timer.unref?.();
  }

  noteParentSettled(): void {
    // Settling is a persistence-scan boundary, never permission to resend the
    // same unchanged notice in this runtime epoch.
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
    if (!context) return;
    const sessionId = context.sessionManager.getSessionId();
    const sessionPath = context.sessionManager.getSessionFile();
    const branch = context.sessionManager.getBranch();
    for (const item of await this.#hooks.listQueued()) {
      const auth = authorizeResultDelivery({
        runId: item.runId,
        runNonce: item.runNonce,
        parentSessionId: item.parentSessionId,
        ...(item.parentSessionPath === undefined ? {} : { parentSessionPath: item.parentSessionPath }),
        ...(item.terminalId === undefined ? {} : { terminalId: item.terminalId }),
        ...(item.nativeSession === undefined ? {} : { nativeSession: item.nativeSession }),
        branch,
        sessionId,
        ...(sessionPath === undefined ? {} : { sessionPath }),
      });
      if (!auth.ok) continue;
      const persisted = findPersistedActionNotice(branch, item.attention.noticeId);
      if (persisted) {
        if (item.attention.delivery.stage !== "parent_persisted") {
          await this.#hooks.updateAttention(item.runId, (current) => current.noticeId === item.attention.noticeId
            ? { ...current, delivery: { stage: "parent_persisted" } }
            : current);
        }
        continue;
      }
      if (item.attention.delivery.stage === "parent_persisted") continue;
      const inflight = item.attention.delivery.stage === "dispatched"
        && item.attention.delivery.runtimeEpoch === this.#hooks.runtimeEpoch;
      if (inflight) continue;
      const updated = await this.#hooks.updateAttention(item.runId, (current) => current.noticeId === item.attention.noticeId
        ? { ...current, delivery: { stage: "dispatched", runtimeEpoch: this.#hooks.runtimeEpoch } }
        : current);
      if (!updated || updated.noticeId !== item.attention.noticeId) continue;
      this.#hooks.pi.sendMessage({
        customType: ACTION_NOTICE_CUSTOM_TYPE,
        content: boundUtf8HeadTail(formatActionNotice(item.runId, updated)).text,
        display: true,
        details: { noticeId: updated.noticeId, runId: item.runId, kind: updated.kind, revision: updated.revision },
      }, { deliverAs: "followUp", triggerTurn: true });
    }
    setTimeout(() => { void this.reconcilePersistence().catch(() => undefined); }, 0).unref?.();
  }

  async reconcilePersistence(): Promise<void> {
    const context = this.#hooks.getContext();
    if (!context) return;
    const branch = context.sessionManager.getBranch();
    for (const item of await this.#hooks.listQueued()) {
      const persisted = findPersistedActionNotice(branch, item.attention.noticeId);
      if (!persisted || item.attention.delivery.stage === "parent_persisted") continue;
      await this.#hooks.updateAttention(item.runId, (current) => current.noticeId === item.attention.noticeId
        ? { ...current, delivery: { stage: "parent_persisted" } }
        : current);
    }
  }
}
