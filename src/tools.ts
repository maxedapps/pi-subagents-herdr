import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProfileName } from "./profiles.ts";
import type { GenerationRequest, SubagentRuntime } from "./runtime.ts";

const strict = { additionalProperties: false } as const;
const profiles = StringEnum(["scout", "researcher", "worker"] as const);

export const startSchema = Type.Union([
  Type.Object({
    profile: profiles,
    task: Type.String({ minLength: 1 }),
    wait: Type.Literal(true),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
  }, strict),
  Type.Object({
    profile: profiles,
    task: Type.String({ minLength: 1 }),
    wait: Type.Optional(Type.Literal(false)),
  }, strict),
]);

export const statusSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
}, strict);

export const sendSchema = Type.Union([
  Type.Object({
    id: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    wait: Type.Literal(true),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
  }, strict),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    wait: Type.Optional(Type.Literal(false)),
  }, strict),
]);

export const idSchema = Type.Object({ id: Type.String({ minLength: 1 }) }, strict);

export const stopSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  discardIncompleteResult: Type.Optional(Type.Literal(true)),
}, strict);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function generationRequest(
  runtime: SubagentRuntime,
  params: { wait?: boolean; timeoutMs?: number },
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
  },
  signal: AbortSignal | undefined,
): GenerationRequest {
  return {
    ...runtime.requestFor({
      parentSessionId: sessionManager.getSessionId(),
      parentSessionFile: sessionManager.getSessionFile(),
      parentEntryId: sessionManager.getLeafId(),
    }),
    wait: params.wait ?? false,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(signal ? { signal } : {}),
  };
}

export function registerSubagentTools(pi: ExtensionAPI, runtime: SubagentRuntime): void {
  pi.registerTool({
    name: "subagent_start",
    label: "Start subagent",
    description: "Start one visible fixed-profile Pi subagent. Background is the default; wait:true returns its structured result and automatic artifact path directly.",
    parameters: startSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return result(await runtime.start(
        params.profile as ProfileName,
        params.task,
        ctx.cwd,
        generationRequest(runtime, params, ctx.sessionManager, signal),
      ));
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description: "List current-parent runs or return one run's lifecycle, generation, artifact, structured result, and retained-resource facts.",
    parameters: statusSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = runtime.requestFor({
        parentSessionId: ctx.sessionManager.getSessionId(),
        parentSessionFile: ctx.sessionManager.getSessionFile(),
        parentEntryId: ctx.sessionManager.getLeafId(),
      });
      return result(params.id ? runtime.status(params.id, request) : { runs: runtime.list(request) });
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to subagent",
    description: "Send one follow-up when the prior generation is delivered. Background is the default; wait:true returns the structured result directly.",
    parameters: sendSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return result(await runtime.send(
        params.id,
        params.message,
        generationRequest(runtime, params, ctx.sessionManager, signal),
      ));
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop subagent",
    description: "Stop or retry finalization for a current-parent run. A raced final result is recovered first; discardIncompleteResult:true irreversibly aborts only a proven-stopped generation with no final result.",
    parameters: stopSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return result(await runtime.stop(params.id, {
        ...runtime.requestFor({
          parentSessionId: ctx.sessionManager.getSessionId(),
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          parentEntryId: ctx.sessionManager.getLeafId(),
        }),
        ...(params.discardIncompleteResult ? { discardIncompleteResult: true as const } : {}),
      }));
    },
  });
}
