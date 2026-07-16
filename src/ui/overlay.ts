import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { DashboardRun, DashboardState } from "./status.ts";
import { statusSummaryLabel } from "./status.ts";
import { renderDashboardRow } from "./widget.ts";

export type OverlayAction =
  | { readonly type: "close" }
  | { readonly type: "refresh" }
  | { readonly type: "stop"; readonly id: string }
  | { readonly type: "focus"; readonly id: string };

export class OverlaySelection {
  selectedId: string | undefined;
  selectedIndex = 0;
  offset = 0;

  replace(runs: readonly DashboardRun[], pageSize: number): void {
    const previousIndex = this.selectedIndex;
    const byId = this.selectedId === undefined ? -1 : runs.findIndex((run) => run.id === this.selectedId);
    this.selectedIndex = byId >= 0 ? byId : Math.min(previousIndex, Math.max(0, runs.length - 1));
    this.selectedId = runs[this.selectedIndex]?.id;
    this.clamp(runs.length, pageSize);
  }

  move(delta: number, runs: readonly DashboardRun[], pageSize: number): void {
    if (runs.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(runs.length - 1, this.selectedIndex + delta));
    this.selectedId = runs[this.selectedIndex]?.id;
    this.clamp(runs.length, pageSize);
  }

  clamp(length: number, pageSize: number): void {
    if (length === 0) { this.selectedIndex = 0; this.offset = 0; this.selectedId = undefined; return; }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, length - 1));
    if (this.selectedIndex < this.offset) this.offset = this.selectedIndex;
    if (this.selectedIndex >= this.offset + pageSize) this.offset = this.selectedIndex - pageSize + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, length - pageSize)));
  }
}

function pad(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class SubagentsOverlay implements Component {
  readonly selection = new OverlaySelection();
  #state: DashboardState;
  #message: string | undefined;
  #pageSize = 8;

  constructor(
    initialState: DashboardState,
    private readonly theme: Theme,
    private readonly onAction: (action: OverlayAction) => void,
    private readonly requestRender: () => void,
  ) {
    this.#state = initialState;
    this.selection.replace(initialState.runs, this.#pageSize);
  }

  get state(): DashboardState { return this.#state; }
  get selectedRun(): DashboardRun | undefined { return this.#state.runs[this.selection.selectedIndex]; }

  setState(state: DashboardState): void {
    this.#state = state;
    this.selection.replace(state.runs, this.#pageSize);
    this.requestRender();
  }

  setMessage(message: string | undefined): void { this.#message = message; this.requestRender(); }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.onAction({ type: "close" }); return; }
    if (data === "r") { this.onAction({ type: "refresh" }); return; }
    if (matchesKey(data, Key.up)) { this.selection.move(-1, this.#state.runs, this.#pageSize); this.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.selection.move(1, this.#state.runs, this.#pageSize); this.requestRender(); return; }
    const run = this.selectedRun;
    if (!run) return;
    if (matchesKey(data, Key.enter)) this.onAction({ type: "focus", id: run.id });
    else if (data === "x") this.onAction({ type: "stop", id: run.id });
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 24) {
      const run = this.selectedRun;
      return [
        truncateToWidth("Subagents", width, ""),
        truncateToWidth(run ? `${run.profile} ${run.herdrStatus}` : "No owned runs", width, ""),
        ...(this.#message ? [truncateToWidth(this.#message, width, "")] : []),
        truncateToWidth("Enter focus · x stop · r refresh · Esc close", width, ""),
      ];
    }
    const inner = width - 2;
    const border = (value: string) => this.theme.fg("borderAccent", value);
    const row = (value = "", selected = false): string => {
      const body = pad(value, inner);
      return border("│") + (selected ? this.theme.bg("selectedBg", body) : body) + border("│");
    };
    const title = ` Subagents · current owned · ${statusSummaryLabel(this.#state.summary)}`;
    const lines = [border(`╭${"─".repeat(inner)}╮`), row(this.theme.fg("accent", this.theme.bold(title)))];
    if (this.#state.connection === "unavailable") lines.push(row(` ${this.theme.fg("warning", this.#state.error ?? "Subagent backend unavailable")}`));
    else if (this.#state.runs.length === 0) lines.push(row(` ${this.theme.fg("muted", "No current-session owned runs")}`));
    else {
      this.selection.clamp(this.#state.runs.length, this.#pageSize);
      const visible = this.#state.runs.slice(this.selection.offset, this.selection.offset + this.#pageSize);
      for (let index = 0; index < visible.length; index += 1) {
        const absolute = this.selection.offset + index;
        const run = visible[index]!;
        const marker = absolute === this.selection.selectedIndex ? "▶ " : "  ";
        lines.push(row(marker + renderDashboardRow(run, Math.max(1, inner - 2), this.theme), absolute === this.selection.selectedIndex));
      }
      if (this.#state.runs.length > this.#pageSize) lines.push(row(` ${this.theme.fg("dim", `${this.selection.offset + 1}-${this.selection.offset + visible.length} of ${this.#state.runs.length}`)}`));
    }
    if (this.#message) lines.push(row(` ${this.theme.fg("warning", this.#message)}`));
    lines.push(row());
    lines.push(row(` ${this.theme.fg("dim", "↑↓ select · Enter focus · x stop · r refresh · Esc close")}`));
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void { /* Theme is injected and evaluated during every render. */ }
}
