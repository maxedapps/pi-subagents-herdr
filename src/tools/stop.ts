import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StopToolSchema } from "./schemas.ts";
import { boundedResultText, renderToolCall, renderToolResult } from "./renderers.ts";
import { exactToolPayload } from "../results/presentation.ts";

export function registerStopTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name, label: "Subagent Stop",
    description: "Gracefully stop, or explicitly force-close, only a freshly identity-verified current-active-branch owned subagent. The same call is idempotent for an already-stopped owned run and retries cleanup. Writer cleanup defaults to remove_if_safe: it requires parent-persisted result/failure evidence, objective no-change/integration proof, cleanliness, idle owned topology, and exact provenance. Refusals retain work and return an actionable retry reason; dirty discard is never implied.",
    promptSnippet: "Stop one owned subagent and automatically finalize its writer resources when proven safe",
    parameters: StopToolSchema,
    async execute(_id, params, signal) {
      const result = await runtime.stop(params, signal);
      const payload = exactToolPayload(result, boundedResultText);
      return { content: payload.content, details: payload.details };
    },
    renderCall(args, theme) { return renderToolCall("Subagent stop", `${args.id} ${args.mode ?? "graceful"}/${args.cleanup ?? "remove_if_safe"}`, theme); },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
