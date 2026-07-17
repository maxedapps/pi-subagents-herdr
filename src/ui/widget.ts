import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { DashboardRun, DashboardState } from "./status.ts";
import { statusSummaryLabel } from "./status.ts";
import { semanticStyle } from "./theme.ts";

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function runLabel(run: DashboardRun): string {
  const suffix = run.id.startsWith("global:") ? run.id.slice(7) : run.id;
  const short = suffix.length > 12 ? suffix.slice(-8) : suffix;
  return run.profile === "observational" ? short : `${run.profile}/${short}`;
}

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderDashboardRow(run: DashboardRun, width: number, theme: Theme, selected = false): string {
  if (width <= 0) return "";
  const semantic = semanticStyle(run.lifecycle, run.herdrStatus);
  const icon = theme.fg(semantic.color, semantic.icon);
  const status = theme.fg(semantic.color, semantic.label);
  const elapsed = theme.fg("dim", formatElapsed(run.elapsedMs));
  const label = theme.fg("text", runLabel(run));
  const action = run.attention?.required ? ` ${theme.fg("warning", run.attention.kind.replaceAll("_", " "))}` : "";
  const custom = run.customStatus ? ` ${theme.fg("warning", run.customStatus)}` : action;
  let content: string;
  if (width < 36) content = `${icon} ${label} ${status}`;
  else if (width < 64) content = `${icon} ${label} ${status}${custom} ${elapsed}`;
  else content = `${icon} ${label}  ${theme.fg("muted", run.harness)}  ${status}${custom}  ${elapsed}`;
  const fitted = padToWidth(content, width);
  return selected ? theme.bg("selectedBg", fitted) : fitted;
}

export class SubagentsWidget implements Component {
  #cachedWidth: number | undefined;
  #cachedFingerprint: string | undefined;
  #cachedLines: string[] | undefined;

  constructor(
    private readonly getState: () => DashboardState,
    private readonly theme: Theme,
    private readonly maxRows = 5,
  ) {}

  render(width: number): string[] {
    const state = this.getState();
    if (width <= 0 || state.runs.length === 0) return [];
    const fingerprint = JSON.stringify(state.runs.map((run) => [run.id, run.lifecycle, run.herdrStatus, run.customStatus, run.attention?.noticeId, run.elapsedMs]));
    if (this.#cachedLines && this.#cachedWidth === width && this.#cachedFingerprint === fingerprint) return this.#cachedLines;
    const title = width < 28 ? `Subagents ${state.summary.total}` : `Subagents · ${statusSummaryLabel(state.summary)}`;
    const lines = [truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width, "")];
    const visible = state.runs.slice(0, this.maxRows);
    for (const run of visible) lines.push(truncateToWidth(renderDashboardRow(run, width, this.theme), width, ""));
    if (state.runs.length > visible.length) {
      lines.push(truncateToWidth(this.theme.fg("dim", `… +${state.runs.length - visible.length} more · /subagents`), width, ""));
    }
    this.#cachedWidth = width;
    this.#cachedFingerprint = fingerprint;
    this.#cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedFingerprint = undefined;
    this.#cachedLines = undefined;
  }
}
