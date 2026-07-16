import type { RunLifecycle } from "../contracts/state.ts";
import type { ListToolResult, RunSummary } from "../tools/contracts.ts";

export type DashboardScope = "current_session" | "all_owned" | "global";

export interface DashboardRun extends RunSummary {
  readonly changedOutput: boolean;
}

export interface DashboardSummary {
  readonly total: number;
  readonly blocked: number;
  readonly working: number;
  readonly ready: number;
  readonly done: number;
  readonly idle: number;
  readonly unknown: number;
  readonly failures: number;
}

export interface DashboardState {
  readonly scope: DashboardScope;
  readonly connection: "connected" | "unavailable";
  readonly runs: readonly DashboardRun[];
  readonly summary: DashboardSummary;
  readonly updatedAt: number;
  readonly error?: string;
}

const LIFECYCLE_ORDER: Readonly<Record<RunLifecycle, number>> = {
  failed: 0,
  lost: 1,
  running: 2,
  interrupting: 3,
  stopping: 4,
  starting: 5,
  stopped: 6,
};
const STATUS_ORDER = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 } as const;

export function emptyDashboardSummary(): DashboardSummary {
  return { total: 0, blocked: 0, working: 0, ready: 0, done: 0, idle: 0, unknown: 0, failures: 0 };
}

export function isFailure(run: RunSummary): boolean {
  return run.lifecycle === "failed" || run.lifecycle === "lost";
}

export function isDashboardVisible(run: RunSummary): boolean {
  return run.lifecycle !== "stopped";
}

export function summarizeDashboardRuns(runs: readonly RunSummary[]): DashboardSummary {
  const summary = emptyDashboardSummary();
  const mutable = { ...summary };
  for (const run of runs) {
    mutable.total += 1;
    if (isFailure(run)) {
      mutable.failures += 1;
      continue;
    }
    if (run.herdrStatus === "blocked") mutable.blocked += 1;
    else if (run.herdrStatus === "working") mutable.working += 1;
    else if (run.herdrStatus === "done") { mutable.done += 1; mutable.ready += 1; }
    else if (run.herdrStatus === "idle") { mutable.idle += 1; mutable.ready += 1; }
    else mutable.unknown += 1;
  }
  return mutable;
}

export function statusSummaryLabel(summary: DashboardSummary): string {
  const parts: string[] = [];
  if (summary.blocked) parts.push(`${summary.blocked} blocked`);
  if (summary.working) parts.push(`${summary.working} working`);
  if (summary.ready) parts.push(`${summary.ready} ready`);
  if (summary.unknown) parts.push(`${summary.unknown} unknown`);
  if (summary.failures) parts.push(`${summary.failures} failed`);
  return parts.join(" · ") || "none";
}

export class DashboardProjector {
  readonly #seenRevisions = new Map<string, number>();
  readonly #knownRevisions = new Map<string, number>();

  markSeen(id: string, revision?: number): void {
    const value = revision ?? this.#knownRevisions.get(id);
    if (value !== undefined) this.#seenRevisions.set(id, value);
  }

  project(scope: DashboardScope, result: ListToolResult, now = Date.now()): DashboardState {
    if (!result.ok) {
      return {
        scope,
        connection: "unavailable",
        runs: [],
        summary: emptyDashboardSummary(),
        updatedAt: now,
        error: result.reason,
      };
    }
    const liveIds = new Set<string>();
    const runs = result.runs.filter(isDashboardVisible).map((run): DashboardRun => {
      liveIds.add(run.id);
      const revision = run.outputRevision;
      if (revision !== undefined) {
        this.#knownRevisions.set(run.id, revision);
        if (!this.#seenRevisions.has(run.id)) this.#seenRevisions.set(run.id, revision);
      }
      const seen = this.#seenRevisions.get(run.id);
      return { ...run, changedOutput: revision !== undefined && seen !== undefined && revision > seen };
    });
    for (const id of this.#knownRevisions.keys()) {
      if (!liveIds.has(id)) { this.#knownRevisions.delete(id); this.#seenRevisions.delete(id); }
    }
    runs.sort((left, right) =>
      LIFECYCLE_ORDER[left.lifecycle] - LIFECYCLE_ORDER[right.lifecycle]
      || STATUS_ORDER[left.herdrStatus] - STATUS_ORDER[right.herdrStatus]
      || left.profile.localeCompare(right.profile)
      || left.id.localeCompare(right.id));
    return {
      scope,
      connection: "connected",
      runs,
      summary: summarizeDashboardRuns(runs),
      updatedAt: now,
    };
  }
}

export function adaptiveRefreshDelay(state: DashboardState, overlayOpen = false): number | undefined {
  if (overlayOpen) return 1_500;
  if (state.runs.length === 0) return undefined;
  if (state.runs.some((run) => run.lifecycle === "starting" || run.lifecycle === "interrupting" || run.lifecycle === "stopping" || run.herdrStatus === "working")) return 1_500;
  return 5_000;
}
