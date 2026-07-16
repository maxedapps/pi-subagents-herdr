import type { Harness, ThinkingLevel } from "../contracts/harness.ts";
import type { HerdrStatus, RunLifecycle } from "../contracts/state.ts";
import type { BoundedOutput } from "../runtime/control.ts";
import type { WorktreeStateView } from "../worktrees/contracts.ts";

export type ToolAvailability = "ready" | "blocked" | "unavailable";

export interface ToolUnavailableResult {
  readonly ok: false;
  readonly status: "blocked" | "unavailable";
  readonly reason: string;
}

export interface RunSummary {
  readonly id: string;
  readonly profile: string;
  readonly harness: Harness;
  readonly lifecycle: RunLifecycle;
  readonly herdrStatus: HerdrStatus;
  readonly ownership: "current_session" | "other_session" | "orphaned" | "uncertain" | "observational";
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly taskSynopsis: string;
  readonly agentRevision?: number;
  /** Recent-output revision, populated by UI-specific observational refreshes. */
  readonly outputRevision?: number;
  readonly customStatus?: string;
  readonly focused?: boolean;
  readonly terminalId?: string;
  readonly paneId?: string;
  readonly tabId?: string;
  readonly workspaceId?: string;
  readonly worktree?: WorktreeStateView;
}

export interface StartToolSuccess {
  readonly ok: true;
  readonly status: "started" | "blocked";
  readonly run: RunSummary;
  readonly effective: {
    readonly harness: Harness;
    readonly model?: string;
    readonly thinking: ThinkingLevel;
    readonly cwd: string;
    readonly tools: readonly string[];
    readonly skills: readonly string[];
    readonly skillDiagnostics: readonly string[];
    readonly permissions: { readonly mutation: boolean; readonly network: boolean };
    readonly isolatedWorktree: boolean;
    readonly broadeningReasons: readonly string[];
  };
  readonly output: BoundedOutput;
  readonly reason?: string;
}

export interface ListToolSuccess {
  readonly ok: true;
  readonly scope: "current_session" | "project" | "all_owned" | "global";
  readonly runs: readonly RunSummary[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface GetToolSuccess {
  readonly ok: true;
  readonly run: RunSummary;
  readonly effectiveProfile: {
    readonly source?: string;
    readonly description: string;
    readonly harness: Harness;
    readonly model?: string;
    readonly thinking: ThinkingLevel;
    readonly cwd: string;
    readonly tools: readonly string[];
    readonly skills: readonly string[];
  };
  readonly ownership: {
    readonly runNonce: string;
    readonly parentSessionId: string;
    readonly parentSessionPath?: string;
    readonly branchEntryId: string;
    readonly terminalId?: string;
    readonly nativeSession?: { readonly kind: "id" | "path"; readonly value: string; readonly source: string };
  };
  readonly topology: { readonly workspaceId?: string; readonly tabId?: string; readonly paneId?: string };
  readonly output: BoundedOutput;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly runtime: {
    readonly ephemeralFiles: "retained" | "removed";
    readonly piSessionData: "retained" | "removed" | "not-applicable";
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ActionToolSuccess<T = unknown> {
  readonly ok: true;
  readonly action: "send" | "wait" | "interrupt" | "stop";
  readonly run: RunSummary;
  readonly result: T;
  readonly cleanup?: unknown;
}

export type StartToolResult = StartToolSuccess | ToolUnavailableResult;
export type ListToolResult = ListToolSuccess | ToolUnavailableResult;
export type GetToolResult = GetToolSuccess | ToolUnavailableResult;
export type ActionToolResult<T = unknown> = ActionToolSuccess<T> | ToolUnavailableResult;
