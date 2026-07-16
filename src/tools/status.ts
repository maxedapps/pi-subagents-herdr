import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StatusToolSchema, assertStatusToolInput } from "./schemas.ts";
import { boundedResultText, renderToolCall, renderToolResult } from "./renderers.ts";

export function registerStatusTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name,
    label: "Subagent Status",
    description: "Observe subagents in exactly one mode: omit id to list an optional scope; provide id without states to inspect details and bounded recent output; provide id with explicit states to wait with a bounded timeout and then return the same detailed inspection. Scope is list-only, timeoutMs is wait-only, and invalid combinations fail.",
    promptSnippet: "List subagents, inspect one, or wait for states then inspect output",
    promptGuidelines: [
      "Use subagent_status without id to list; with id to inspect; and with id plus states to wait then inspect. Always resolve blocked, failed, timed-out, or unknown subagents rather than firing and forgetting.",
    ],
    parameters: StatusToolSchema,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const mode = assertStatusToolInput(params);
      if (mode === "list") {
        const result = await runtime.list(params.scope === undefined ? {} : { scope: params.scope });
        return { content: [{ type: "text", text: boundedResultText(result) }], details: result };
      }
      if (mode === "wait") {
        const waited = await runtime.wait({
          id: params.id!,
          states: params.states!,
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        }, signal);
        if (!waited.ok) return { content: [{ type: "text", text: boundedResultText(waited) }], details: waited };
        const inspected = await runtime.get({ id: params.id!, ...(params.lines === undefined ? {} : { lines: params.lines }) }, signal);
        const result = inspected.ok ? { ...inspected, observation: { mode: "wait" as const, wait: waited.result } } : inspected;
        return { content: [{ type: "text", text: boundedResultText(result) }], details: result };
      }
      const result = await runtime.get({ id: params.id!, ...(params.lines === undefined ? {} : { lines: params.lines }) }, signal);
      const details = result.ok ? { ...result, observation: { mode: "inspect" as const } } : result;
      return { content: [{ type: "text", text: boundedResultText(details) }], details };
    },
    renderCall(args, theme) {
      const mode = args.id === undefined ? "list" : args.states === undefined ? "inspect" : "wait";
      const detail = mode === "list"
        ? args.scope ?? "current_session"
        : mode === "inspect"
          ? args.id
          : `${args.id} → ${(args.states ?? []).join("/")}`;
      return renderToolCall("Subagent status", `${mode}: ${detail}`, theme);
    },
    renderResult(result, { expanded }, theme) { return renderToolResult(result.details, expanded, theme); },
  });
}
