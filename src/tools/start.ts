import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StartToolSchema } from "./schemas.ts";
import { renderToolCall, renderToolResult, boundedResultText } from "./renderers.ts";
import { exactToolPayload } from "../results/presentation.ts";

export function registerStartTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name,
    label: "Subagent Start",
    description: "Start one visible subagent for a bounded task. Prefer profile defaults; higher requested thinking may be clamped and reported. Returns immediately and delivers results automatically.",
    promptSnippet: "Start one bounded, ownership-tracked subagent",
    promptGuidelines: [
      `Use ${name} for one bounded delegation with a clear output and stopping condition.`,
      "Omit optional overrides unless required; inspect adjustments and passive run.attention state through subagent_status.",
    ],
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
