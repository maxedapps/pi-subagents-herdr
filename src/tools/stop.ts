import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StopToolSchema } from "./schemas.ts";
import { boundedResultText, renderToolCall, renderToolResult } from "./renderers.ts";

export function registerStopTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name, label: "Subagent Stop",
    description: "Gracefully stop, or explicitly force-close, only a freshly identity-verified current-active-branch owned subagent. Worktree cleanup is separate and defaults to retain; remove_if_safe requires captured handoff evidence, parent review, objective Git evidence, cleanliness, no live or unknown panes, and identity-matched removal. This tool never authorizes dirty discard.",
    promptSnippet: "Stop one owned subagent; retain writer worktrees unless safe cleanup is proven",
    parameters: StopToolSchema,
    async execute(_id, params, signal) { const result = await runtime.stop(params, signal); return { content: [{ type: "text", text: boundedResultText(result) }], details: result }; },
    renderCall(args, theme) { return renderToolCall("Subagent stop", `${args.id} ${args.mode ?? "graceful"}/${args.cleanup ?? "retain"}`, theme); },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
