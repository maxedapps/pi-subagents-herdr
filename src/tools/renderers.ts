import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { boundUtf8HeadTail, collapsedPreview, extractDeliveredText } from "../results/presentation.ts";
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
  const attention = run.attention?.required ? ` ${theme.fg("warning", `action required: ${run.attention.kind.replaceAll("_", " ")}`)}` : "";
  return `${statusColor(theme, status, icon(status))} ${theme.fg("accent", run.id)} ${theme.fg("muted", `${run.profile}/${run.harness}`)} ${statusColor(theme, status, status)}${attention}`;
}

export function renderToolResult(result: unknown, expanded: boolean, theme: Theme): Component {
  // Prefer exact deliveredText when tools use ExactRenderDetails.
  const delivered = extractDeliveredText(result);
  if (typeof delivered === "string") {
    if (!expanded) {
      const value = result as Record<string, unknown>;
      const nested = value.result as Record<string, unknown> | undefined;
      const run = (nested?.run ?? value.run) as RunSummary | undefined;
      const completion = (nested?.completion ?? value.completion) as { pending?: boolean; delivery?: string } | undefined;
      if (run && completion?.pending === true) {
        const label = completion.delivery === "automatic"
          ? "started · result pending · automatic delivery"
          : "started · result pending · automatic delivery";
        return new Text(`${theme.fg("accent", "●")} ${theme.fg("accent", run.id)} ${theme.fg("muted", `${run.profile}/${run.harness}`)} ${theme.fg("warning", label)}\n${theme.fg("muted", collapsedPreview(delivered))}`, 0, 0);
      }
      if (run) {
        return new Text(`${runLine(run, theme)}\n${theme.fg("muted", collapsedPreview(delivered))}`, 0, 0);
      }
      return new Text(theme.fg("muted", collapsedPreview(delivered)), 0, 0);
    }
    // Expanded: exact model-visible text, nothing reconstructed from richer details.
    return new Text(delivered, 0, 0);
  }

  if (!result || typeof result !== "object") return new Text(theme.fg("dim", "No result"), 0, 0);
  const value = result as Record<string, unknown>;
  if (value.ok === false) {
    const unavailable = value as unknown as ToolUnavailableResult;
    return new Text(`${statusColor(theme, unavailable.status, icon(unavailable.status))} ${statusColor(theme, unavailable.status, unavailable.status)} ${theme.fg("muted", unavailable.reason)}`, 0, 0);
  }
  const run = value.run as RunSummary | undefined;
  const runs = value.runs as readonly RunSummary[] | undefined;
  const completion = value.completion as { pending?: boolean; delivery?: string } | undefined;
  let text = run && completion?.pending === true
    ? `${theme.fg("accent", "●")} ${theme.fg("accent", run.id)} ${theme.fg("muted", `${run.profile}/${run.harness}`)} ${theme.fg("warning", "started · result pending · automatic delivery")}`
    : run ? runLine(run, theme) : runs ? theme.fg("accent", `${runs.length} subagent${runs.length === 1 ? "" : "s"}`) : theme.fg("success", "✓ Subagent operation complete");
  if (expanded) {
    // Fallback only when deliveredText was not provided: show the serialized payload path is preferred.
    text += `\n${theme.fg("dim", "[expanded metadata unavailable without deliveredText]")}`;
  }
  return new Text(text, 0, 0);
}

/** Serialize once for model content; UTF-8 head+tail bound. */
export function boundedResultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return boundUtf8HeadTail(text).text;
}
