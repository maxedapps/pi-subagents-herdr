import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { HerdrStatus, RunLifecycle } from "../contracts/state.ts";

export interface SemanticStyle {
  readonly icon: string;
  readonly label: string;
  readonly color: ThemeColor;
}

const HERDR_STYLES: Readonly<Record<HerdrStatus, SemanticStyle>> = {
  blocked: { icon: "!", label: "blocked", color: "warning" },
  working: { icon: "●", label: "working", color: "accent" },
  done: { icon: "✓", label: "done", color: "success" },
  idle: { icon: "○", label: "idle", color: "muted" },
  unknown: { icon: "?", label: "unknown", color: "dim" },
};

const LIFECYCLE_STYLES: Readonly<Record<RunLifecycle, SemanticStyle>> = {
  starting: { icon: "◌", label: "starting", color: "accent" },
  running: { icon: "●", label: "running", color: "accent" },
  interrupting: { icon: "■", label: "interrupting", color: "warning" },
  stopping: { icon: "■", label: "stopping", color: "warning" },
  stopped: { icon: "○", label: "stopped", color: "muted" },
  failed: { icon: "✗", label: "failed", color: "error" },
  lost: { icon: "?", label: "lost", color: "error" },
};

export function semanticStyle(lifecycle: RunLifecycle, status: HerdrStatus): SemanticStyle {
  return lifecycle === "running" ? HERDR_STYLES[status] : LIFECYCLE_STYLES[lifecycle];
}

export function styleSemantic(theme: Theme, lifecycle: RunLifecycle, status: HerdrStatus): { icon: string; label: string } {
  const style = semanticStyle(lifecycle, status);
  return { icon: theme.fg(style.color, style.icon), label: theme.fg(style.color, style.label) };
}

export function ownershipLabel(ownership: string): string {
  if (ownership === "current_session") return "owned by active branch";
  if (ownership === "other_session") return "other session · observational";
  if (ownership === "orphaned") return "orphaned · observational";
  if (ownership === "uncertain") return "uncertain ownership · observational";
  return "global · observational";
}
