import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProfileName } from "./profiles.ts";
import type { SubagentRuntime } from "./runtime.ts";

const strict = { additionalProperties: false } as const;

export const startSchema = Type.Object({
  profile: StringEnum(["scout", "researcher", "worker"] as const),
  task: Type.String({ minLength: 1 }),
}, strict);

export const statusSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  wait: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
}, strict);

export const sendSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
}, strict);

export const idSchema = Type.Object({ id: Type.String({ minLength: 1 }) }, strict);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export function registerSubagentTools(pi: ExtensionAPI, runtime: SubagentRuntime): void {
  pi.registerTool({
    name: "subagent_start",
    label: "Start subagent",
    description: "Start one visible fixed-profile Pi subagent. Returns immediately after Pi is ready and the task input is acknowledged.",
    parameters: startSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return result(await runtime.start(params.profile as ProfileName, params.task, ctx.cwd, signal));
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description: "List current-instance runs, or explicitly pull one run's current Herdr status and bounded terminal output.",
    parameters: statusSchema,
    async execute(_toolCallId, params, signal) {
      if (!params.id) {
        if (params.wait || params.timeoutMs !== undefined) throw new Error("wait and timeoutMs require id");
        return result({ runs: runtime.list() });
      }
      return result(await runtime.status(params.id, params.wait ?? false, params.timeoutMs ?? 30_000, signal));
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to subagent",
    description: "Send one follow-up plus Enter to a current-instance run. Inspect status before retrying a transport error.",
    parameters: sendSchema,
    async execute(_toolCallId, params, signal) {
      return result(await runtime.send(params.id, params.message, signal));
    },
  });

  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt subagent",
    description: "Send ctrl+c to a current-instance run. Inspect status before retrying a transport error.",
    parameters: idSchema,
    async execute(_toolCallId, params, signal) {
      return result(await runtime.interrupt(params.id, signal));
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop subagent",
    description: "Close a current-instance run's pane and clean its owned reader tab or clean worker worktree.",
    parameters: idSchema,
    async execute(_toolCallId, params, signal) {
      return result(await runtime.stop(params.id, signal));
    },
  });
}
