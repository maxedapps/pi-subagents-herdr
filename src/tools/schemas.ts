import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const strict = { additionalProperties: false } as const;
const RunId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const Timeout = Type.Integer({ minimum: 1, maximum: 86_400_000 });
const Thinking = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const Harness = StringEnum(["pi", "claude", "codex"] as const);
const SubagentState = StringEnum(["working", "blocked", "done", "idle", "unknown"] as const);

export const StartToolSchema = Type.Object({
  profile: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Discovered subagent profile runtime name" }),
  task: Type.String({ minLength: 1, maxLength: 262_144, description: "One bounded delegated task" }),
  harness: Type.Optional(Harness),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  thinking: Type.Optional(Thinking),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  worktree: Type.Optional(StringEnum(["auto", "shared", "isolated"] as const)),
}, strict);

/**
 * Google-compatible flat schema. Cross-field mode rules are enforced by
 * assertStatusToolInput() at execution because oneOf/anyOf are intentionally
 * avoided:
 * - no id: list; only scope is accepted
 * - id without states: inspect; lines is accepted
 * - id with states: bounded wait, then inspect; timeoutMs and lines are accepted
 */
export const StatusToolSchema = Type.Object({
  id: Type.Optional(RunId),
  scope: Type.Optional(StringEnum(["current_session", "project", "all_owned", "global"] as const, {
    description: "List scope; valid only when id is omitted. Defaults to current_session.",
  })),
  states: Type.Optional(Type.Array(SubagentState, {
    minItems: 1,
    maxItems: 5,
    uniqueItems: true,
    description: "Wait states; valid only with id. Presence selects bounded wait-then-inspect mode.",
  })),
  timeoutMs: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 86_400_000,
    description: "Bounded wait timeout; valid only when id and states are both present.",
  })),
  lines: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 2_000,
    description: "Maximum recent output lines for inspect or wait-then-inspect. Defaults to 160.",
  })),
}, strict);

export const SendToolSchema = Type.Object({
  id: RunId,
  message: Type.String({ minLength: 1, maxLength: 262_144 }),
  timeoutMs: Type.Optional(Timeout),
}, strict);

export const InterruptToolSchema = Type.Object({
  id: RunId,
  timeoutMs: Type.Optional(Timeout),
}, strict);

const IntegrationSchema = Type.Object({
  kind: StringEnum(["no_changes", "commit_contained", "tree_matches"] as const),
  parentCheckoutPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  parentRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, strict);

export const StopToolSchema = Type.Object({
  id: RunId,
  mode: Type.Optional(StringEnum(["graceful", "force"] as const)),
  cleanup: Type.Optional(StringEnum(["retain", "remove_if_safe"] as const)),
  parentReview: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: "Optional audit note describing parent review; objective Git/topology evidence controls cleanup" })),
  integration: Type.Optional(IntegrationSchema),
  timeoutMs: Type.Optional(Timeout),
}, strict);

export type StartToolInput = Static<typeof StartToolSchema>;
export type StatusToolInput = Static<typeof StatusToolSchema>;
export type ListToolInput = { readonly scope?: "current_session" | "project" | "all_owned" | "global" };
export type GetToolInput = { readonly id: string; readonly lines?: number };
export type SendToolInput = Static<typeof SendToolSchema>;
export type WaitToolInput = { readonly id: string; readonly states?: readonly ("working" | "blocked" | "done" | "idle" | "unknown")[]; readonly timeoutMs?: number };
export type InterruptToolInput = Static<typeof InterruptToolSchema>;
export type StopToolInput = Static<typeof StopToolSchema>;

export type StatusMode = "list" | "inspect" | "wait";

export function assertStatusToolInput(input: StatusToolInput): StatusMode {
  if (input.id === undefined) {
    if (input.states !== undefined || input.timeoutMs !== undefined || input.lines !== undefined) {
      throw new Error("subagent_status list mode omits id and accepts only optional scope");
    }
    return "list";
  }
  if (input.scope !== undefined) {
    throw new Error("subagent_status scope is valid only when id is omitted");
  }
  if (input.states === undefined) {
    if (input.timeoutMs !== undefined) {
      throw new Error("subagent_status timeoutMs requires id with explicit states");
    }
    return "inspect";
  }
  return "wait";
}
