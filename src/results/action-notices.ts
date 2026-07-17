import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractPersistedCustomMessage } from "./persisted-custom-message.ts";

/** Read-only compatibility constants for schema-v5 sessions written before passive attention. */
export const LEGACY_ACTION_NOTICE_CUSTOM_TYPE = "herdr-subagents.action-required.v1" as const;
export const LEGACY_ACTION_NOTICE_SENTINEL = "HERDR_ACTION_REQUIRED_V1" as const;

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
  /** Inert schema-v5 compatibility state. New attention always remains derived. */
  readonly delivery: {
    readonly stage: ActionDeliveryStage;
    readonly runtimeEpoch?: string;
  };
}

export interface PublicRunAttention extends Omit<RunAttention, "delivery"> {
  readonly deliveryStage: ActionDeliveryStage;
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
  if (Object.keys(value.delivery).some((key) => key !== "stage" && key !== "runtimeEpoch")) throw new Error("run attention delivery contains an unknown field");
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

/** Recognize only exact historical action messages; never generate or replay them. */
export function findLegacyPersistedFailedAction(branch: readonly SessionEntry[], runId: string, noticeId: string): SessionEntry | undefined {
  return branch.find((entry) => {
    const message = extractPersistedCustomMessage(entry);
    if (!message || (message.customType !== LEGACY_ACTION_NOTICE_CUSTOM_TYPE && message.customType !== "herdr-subagents.result.v1")) return false;
    return message.text.split("\n").some((line) => {
      if (!line.startsWith(`${LEGACY_ACTION_NOTICE_SENTINEL} `)) return false;
      try {
        const parsed = JSON.parse(line.slice(LEGACY_ACTION_NOTICE_SENTINEL.length + 1)) as unknown;
        return isRecord(parsed)
          && parsed.noticeId === noticeId
          && parsed.kind === "failed"
          && parsed.runId === runId;
      } catch { return false; }
    });
  });
}
