import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StartToolSchema } from "./schemas.ts";
import { renderToolCall, renderToolResult, boundedResultText } from "./renderers.ts";
import { exactToolPayload } from "../results/presentation.ts";

export function registerStartTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name,
    label: "Subagent Start",
    description: "Start one visible subagent after strict profile, ownership, capability, cwd, and worktree validation. A successful start returns immediately while the child runs asynchronously; the child's final assistant response is captured and injected into this parent branch automatically. Use subagent_status with the exact returned ID for live inspection, blockers, or recovery. There is no hidden or cross-harness fallback.",
    promptSnippet: "Start one bounded, ownership-tracked subagent",
    promptGuidelines: [`Use ${name} only for deliberate bounded delegation with least privilege, a clear output, and a stopping condition. After ${name}, results arrive automatically; call subagent_status with the exact ID for live inspection or recovery. List mode does not inspect a single run's result.`],
    parameters: StartToolSchema,
    executionMode: "parallel",
    async execute(toolCallId, params, signal) {
      const result = await runtime.start(toolCallId, params, signal);
      const payload = exactToolPayload(result, boundedResultText);
      return { content: payload.content, details: payload.details };
    },
    renderCall(args, theme) { return renderToolCall("Subagent start", `${args.profile}: ${args.task.slice(0, 80)}`, theme); },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
