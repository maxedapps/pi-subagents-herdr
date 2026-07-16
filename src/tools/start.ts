import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StartToolSchema } from "./schemas.ts";
import { renderToolCall, renderToolResult, boundedResultText } from "./renderers.ts";

export function registerStartTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name,
    label: "Subagent Start",
    description: "Start one visible subagent after strict profile, ownership, capability, cwd, and worktree validation. Returns after a new turn is proven, not after task completion. There is no hidden or cross-harness fallback.",
    promptSnippet: "Start one bounded, ownership-tracked subagent",
    promptGuidelines: [`Use ${name} only for deliberate bounded delegation with least privilege, a clear output, and a stopping condition.`],
    parameters: StartToolSchema,
    executionMode: "parallel",
    async execute(toolCallId, params, signal) {
      const result = await runtime.start(toolCallId, params, signal);
      return { content: [{ type: "text", text: boundedResultText(result) }], details: result };
    },
    renderCall(args, theme) { return renderToolCall("Subagent start", `${args.profile}: ${args.task.slice(0, 80)}`, theme); },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
