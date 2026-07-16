import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StartToolSchema } from "./schemas.ts";
import { renderToolCall, renderToolResult, boundedResultText } from "./renderers.ts";

export function registerStartTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name,
    label: "Subagent Start",
    description: "Start one visible subagent after strict profile, ownership, capability, cwd, and worktree validation. A successful start creates an outstanding result obligation: it is never task completion, and the parent must call subagent_status with the exact returned ID to wait/inspect output and resolve the run. There is no hidden or cross-harness fallback.",
    promptSnippet: "Start one bounded, ownership-tracked subagent",
    promptGuidelines: [`Use ${name} only for deliberate bounded delegation with least privilege, a clear output, and a stopping condition. After every successful ${name}, call subagent_status with that exact ID; list mode does not inspect results.`],
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
