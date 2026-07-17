import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrToolRuntimeController } from "./service.ts";
import { StatusToolSchema, assertStatusToolInput } from "./schemas.ts";
import { boundedResultText, renderToolCall, renderToolResult } from "./renderers.ts";
import { exactToolPayload } from "../results/presentation.ts";

export function registerStatusTool(pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string): void {
  pi.registerTool({
    name,
    label: "Subagent Status",
    description: "Observe subagents in exactly one mode: omit id to list an optional scope; provide id without states to inspect details, captured result/source/stage when available, and bounded terminal diagnostics; provide id with explicit states to wait with a bounded timeout and then return the same detailed inspection. Project scope and exact-ID inspection passively expose prior stopped cleanup residue without private child output. Automatic completed-result delivery does not require this tool; all other obligations remain passive run.attention until explicit action.",
    promptSnippet: "List subagents, inspect one, or wait for states then inspect output",
    promptGuidelines: [
      "Use subagent_status without id to list; with id to inspect; and with id plus states to wait then inspect. Treat run.attention as an unresolved passive parent obligation. Resolve blocked, failed, timed-out, unknown, review-required, and cleanup-required runs before final reporting. Only completed results arrive automatically; use exact-ID status and explicit subagent_stop for prior stopped cleanup residue.",
    ],
    parameters: StatusToolSchema,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const mode = assertStatusToolInput(params);
      if (mode === "list") {
        const result = await runtime.list(params.scope === undefined ? {} : { scope: params.scope });
        const payload = exactToolPayload(result, boundedResultText);
        return { content: payload.content, details: payload.details };
      }
      if (mode === "wait") {
        const waited = await runtime.wait({
          id: params.id!,
          states: params.states!,
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        }, signal);
        if (!waited.ok) {
          const payload = exactToolPayload(waited, boundedResultText);
          return { content: payload.content, details: payload.details };
        }
        const inspected = await runtime.get({ id: params.id!, ...(params.lines === undefined ? {} : { lines: params.lines }) }, signal);
        const result = inspected.ok ? { ...inspected, observation: { mode: "wait" as const, wait: waited.result } } : inspected;
        const payload = exactToolPayload(result, boundedResultText);
        return { content: payload.content, details: payload.details };
      }
      const result = await runtime.get({ id: params.id!, ...(params.lines === undefined ? {} : { lines: params.lines }) }, signal);
      const details = result.ok ? { ...result, observation: { mode: "inspect" as const } } : result;
      const payload = exactToolPayload(details, boundedResultText);
      return { content: payload.content, details: payload.details };
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
