import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { BoundedOutput } from "../runtime/control.ts";
import type { DashboardRun, DashboardScope } from "./status.ts";
import { ownershipLabel } from "./theme.ts";

export interface UiRunDetails {
  readonly run: DashboardRun;
  readonly output?: BoundedOutput;
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly actionDisabledReason?: string;
  readonly error?: string;
}

export function actionDisabledReason(run: DashboardRun, scope: DashboardScope = "current_session"): string | undefined {
  if (scope === "all_owned") return "Actions disabled: all-owned scope is strictly observational; switch to current scope.";
  if (scope === "global") return "Actions disabled: global scope is strictly observational; switch to current scope.";
  if (run.ownership === "current_session") return undefined;
  if (run.ownership === "other_session") return "Actions disabled: this run belongs to another parent session.";
  if (run.ownership === "orphaned") return "Actions disabled: no ownership proof exists on the current active branch.";
  if (run.ownership === "uncertain") return "Actions disabled: active-branch and live terminal identity cannot be proven.";
  return "Actions disabled: global subagent rows are strictly observational.";
}

function cleanOutputLines(output: BoundedOutput | undefined, limit: number): string[] {
  if (!output?.text) return [];
  return output.text.replaceAll("\r", "").split("\n").slice(-limit);
}

export function renderRunDetails(details: UiRunDetails | undefined, width: number, theme: Theme, outputLines = 4): string[] {
  if (!details || width <= 0) return [];
  const run = details.run;
  const lines = [
    truncateToWidth(theme.fg("muted", `${ownershipLabel(run.ownership)} · ${run.terminalId ?? "no terminal"}`), width, ""),
    truncateToWidth(theme.fg("dim", run.taskSynopsis), width, ""),
  ];
  const disabled = details.actionDisabledReason ?? actionDisabledReason(run);
  if (disabled) lines.push(truncateToWidth(theme.fg("warning", disabled), width, ""));
  if (details.error) lines.push(truncateToWidth(theme.fg("error", details.error), width, ""));
  const output = cleanOutputLines(details.output, outputLines);
  if (output.length > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `Recent output${details.output?.truncated ? " (truncated)" : ""}:`), width, ""));
    for (const line of output) lines.push(truncateToWidth(theme.fg("text", `  ${line}`), width, ""));
  } else {
    lines.push(truncateToWidth(theme.fg("dim", "Recent output: none"), width, ""));
  }
  return lines;
}
