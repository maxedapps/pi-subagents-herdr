import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { RunSummary, ToolUnavailableResult } from "./contracts.ts";

function statusColor(theme: Theme, status: string, text: string): string {
  if (status === "failed" || status === "lost" || status === "unavailable") return theme.fg("error", text);
  if (status === "blocked" || status === "uncertain" || status === "orphaned") return theme.fg("warning", text);
  if (status === "done" || status === "idle" || status === "stopped" || status === "started") return theme.fg("success", text);
  return theme.fg("accent", text);
}

function icon(status: string): string {
  if (status === "failed" || status === "lost" || status === "unavailable") return "×";
  if (status === "blocked" || status === "uncertain" || status === "orphaned") return "!";
  if (status === "done" || status === "idle" || status === "stopped" || status === "started") return "✓";
  return "●";
}

export function renderToolCall(label: string, detail: string | undefined, theme: Theme): Component {
  return new Text(
    theme.fg("toolTitle", theme.bold(label)) + (detail ? ` ${theme.fg("muted", detail)}` : ""),
    0,
    0,
  );
}

function runLine(run: RunSummary, theme: Theme): string {
  const status = run.lifecycle === "running" ? run.herdrStatus : run.lifecycle;
  return `${statusColor(theme, status, icon(status))} ${theme.fg("accent", run.id)} ${theme.fg("muted", `${run.profile}/${run.harness}`)} ${statusColor(theme, status, status)}`;
}

export function renderToolResult(result: unknown, expanded: boolean, theme: Theme): Component {
  if (!result || typeof result !== "object") return new Text(theme.fg("dim", "No result"), 0, 0);
  const value = result as Record<string, unknown>;
  if (value.ok === false) {
    const unavailable = value as unknown as ToolUnavailableResult;
    return new Text(`${statusColor(theme, unavailable.status, icon(unavailable.status))} ${statusColor(theme, unavailable.status, unavailable.status)} ${theme.fg("muted", unavailable.reason)}`, 0, 0);
  }
  const run = value.run as RunSummary | undefined;
  const runs = value.runs as readonly RunSummary[] | undefined;
  let text = run ? runLine(run, theme) : runs ? theme.fg("accent", `${runs.length} subagent${runs.length === 1 ? "" : "s"}`) : theme.fg("success", "✓ Subagent operation complete");
  if (expanded) {
    const details = run ? {
      ownership: run.ownership,
      topology: { workspaceId: run.workspaceId, tabId: run.tabId, paneId: run.paneId, terminalId: run.terminalId },
      task: run.taskSynopsis,
      worktree: run.worktree,
    } : runs?.slice(0, 20).map((item) => ({ id: item.id, status: item.lifecycle === "running" ? item.herdrStatus : item.lifecycle, ownership: item.ownership }));
    if (details !== undefined) text += `\n${theme.fg("dim", JSON.stringify(details, null, 2))}`;
  }
  return new Text(text, 0, 0);
}

export function boundedResultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  const maximum = 48 * 1024;
  if (Buffer.byteLength(text, "utf8") <= maximum) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n[Tool result text truncated; bounded structured details remain available.]`;
}
