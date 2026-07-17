import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { SendToolSchema } from "./schemas.ts";
import { boundedResultText, renderToolCall, renderToolResult } from "./renderers.ts";
import { exactToolPayload } from "../results/presentation.ts";

export function registerSendTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name, label: "Subagent Send",
    description: "Send one atomic same-assignment follow-up to a freshly resolved current-active-branch owned subagent and report whether a new turn was proven. Serializes to one unresolved model generation per run: the child must be blocked, done, or idle with the prior generation captured or closed. Never targets observational, orphaned, or uncertain runs.",
    promptSnippet: "Send a bounded follow-up to one owned subagent",
    parameters: SendToolSchema,
    async execute(_id, params, signal) {
      const result = await runtime.send(params, signal);
      const payload = exactToolPayload(result, boundedResultText);
      return { content: payload.content, details: payload.details };
    },
    renderCall(args, theme) { return renderToolCall("Subagent send", `${args.id}: ${args.message.slice(0, 80)}`, theme); },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
