export const TOOL_KEYS = ["start", "status", "send", "interrupt", "stop"] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

export const TOOL_NAMES: Readonly<Record<ToolKey, string>> = Object.freeze({
  start: "subagent_start",
  status: "subagent_status",
  send: "subagent_send",
  interrupt: "subagent_interrupt",
  stop: "subagent_stop",
});

export function publicToolName(key: ToolKey): string {
  return TOOL_NAMES[key];
}
