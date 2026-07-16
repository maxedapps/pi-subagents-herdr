import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { InterruptToolSchema } from "./schemas.ts";
import { boundedResultText, renderToolCall, renderToolResult } from "./renderers.ts";

export function registerInterruptTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name, label: "Subagent Interrupt",
    description: "Interrupt the current turn of a freshly identity-verified current-active-branch owned subagent while preserving its session. An unconfirmed interrupt remains uncertain; interruption is not stop.",
    promptSnippet: "Interrupt one owned subagent turn without stopping its session",
    parameters: InterruptToolSchema,
    async execute(_id, params, signal) { const result = await runtime.interrupt(params, signal); return { content: [{ type: "text", text: boundedResultText(result) }], details: result }; },
    renderCall(args, theme) { return renderToolCall("Subagent interrupt", args.id, theme); },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
