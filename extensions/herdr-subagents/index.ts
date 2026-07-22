import { getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { enumerateRunArtifacts } from "../../src/artifact.ts";
import { SocketHerdrClient } from "../../src/herdr.ts";
import { buildRecoveryCatalog, formatRecoveryCatalog } from "../../src/recovery.ts";
import {
  SubagentRuntime,
  type BulkStopSummary,
  type Run,
  type StopResult,
} from "../../src/runtime.ts";
import { registerSubagentTools } from "../../src/tools.ts";

const skillPath = fileURLToPath(new URL("../../skills/use-herdr-subagents/SKILL.md", import.meta.url));
const WIDGET_KEY = "herdr-subagents";
const PROFILE_WIDTH = 10;
const noRefresh = () => {};

type WidgetTone = "accent" | "success" | "warning" | "error" | "muted";

type WidgetRow = {
  kind: "agent";
  profile: string;
  id: string;
  generation: string;
  phase: string;
  tone: WidgetTone;
} | {
  kind: "overflow";
  label: string;
  tone: "muted";
};

interface WidgetPresentation {
  header: string;
  rows: WidgetRow[];
}

function phase(run: Run): { label: string; tone: WidgetTone } {
  if (run.lifecycle === "retained") return { label: "retained", tone: "error" };
  if (run.lifecycle === "stopping") return { label: "stopping", tone: "muted" };
  if (run.lifecycle === "starting") return { label: "starting", tone: "accent" };
  if (!run.generation) return { label: "ready", tone: "success" };
  if (run.generation.delivery === "queued") return { label: "result queued", tone: "success" };
  if (run.generation.delivery === "ready") return { label: "result ready", tone: "success" };
  if (run.generation.delivery === "delivered") return { label: "ready", tone: "success" };
  if (run.status === "blocked") return { label: "blocked", tone: "warning" };
  if (run.status === "working") return { label: "working", tone: "accent" };
  return { label: "waiting for result", tone: "muted" };
}

export function retainedCleanupAction(result: StopResult) {
  const { run, workerCleanup } = result;
  if (run.lifecycle !== "retained") return undefined;

  const actionable = result.retained.filter((fact) => !fact.startsWith("branch="));
  const worktreeBlocked = actionable.some((fact) => fact.startsWith("worktree="))
    || (workerCleanup !== undefined && !workerCleanup.removed);
  const incompleteSessionOnly = actionable.length === 1
    && actionable[0]?.startsWith("sessionDir=")
    && run.generation?.artifactParentPersisted === true
    && run.generation.artifactResultPersisted !== true
    && run.generation.outcome !== "aborted"
    && (run.error === undefined || run.error === "Incomplete generation has no archived final result");
  const reason = workerCleanup && !workerCleanup.removed
    ? workerCleanup.reason
    : run.error ?? "owned resource cleanup was incomplete";
  const common = {
    customType: "herdr-subagent-action" as const,
    display: true,
    details: {
      parentSessionId: run.parentSessionId,
      runId: run.id,
      artifactPath: run.artifactPath,
      ...(run.worktree ? { worktree: { ...run.worktree } } : {}),
      reason,
    },
  };

  if (worktreeBlocked && run.worktree) return {
    ...common,
    content: [
      `Run ${run.id} cleanup requires action.`,
      `Worktree: ${run.worktree.path}`,
      `Branch: ${run.worktree.branch}`,
      `Workspace: ${run.worktree.workspaceId}`,
      `Reason: ${reason}`,
      `Artifact: ${run.artifactPath}`,
      `Retry: subagent_stop({ id: "${run.id}" })`,
      "Do not use raw Git-only worktree removal; preserve the work and retry through the extension.",
    ].join("\n"),
  };

  if (incompleteSessionOnly) return {
    ...common,
    content: [
      `Run ${run.id} stopped without an archived final result.`,
      `Artifact: ${run.artifactPath}`,
      `Explicit irreversible discard: subagent_stop({ id: "${run.id}", discardIncompleteResult: true })`,
      "A raced complete result is recovered first. Do not treat repeated ordinary stops as discard consent.",
    ].join("\n"),
  };

  return {
    ...common,
    content: [
      `Run ${run.id} cleanup remains retained.`,
      `Reason: ${reason}`,
      `Artifact: ${run.artifactPath}`,
      `Retry: subagent_stop({ id: "${run.id}" })`,
    ].join("\n"),
  };
}

export function presentSubagentWidget(runs: readonly Run[]): WidgetPresentation | undefined {
  const visible = runs.filter((run) => run.lifecycle !== "closed");
  if (!visible.length) return undefined;

  const retained = visible.filter((run) => run.lifecycle === "retained").length;
  const active = visible.length - retained;
  const rows: WidgetRow[] = visible.map((run) => {
    const status = phase(run);
    return {
      kind: "agent",
      profile: run.profile,
      id: (run.id.startsWith("run-") ? run.id.slice(4) : run.id).slice(0, 8),
      generation: run.generation ? `g${run.generation.number} ` : "",
      phase: status.label,
      tone: status.tone,
    };
  });
  return {
    header: `Subagents · ${active} active${retained ? ` · ${retained} retained` : ""}`,
    rows: rows.length <= 5
      ? rows
      : [...rows.slice(0, 4), { kind: "overflow", label: `+${rows.length - 4} more`, tone: "muted" }],
  };
}

export function formatSubagentWidget(runs: readonly Run[]): string[] | undefined {
  const presentation = presentSubagentWidget(runs);
  if (!presentation) return undefined;
  return [presentation.header, ...presentation.rows.map((row) => row.kind === "overflow"
    ? row.label
    : `  ${row.profile.padEnd(PROFILE_WIDTH)} ${row.id} · ${row.generation}${row.phase}`)];
}

function fit(text: string, width: number, padding = " "): string {
  const fitted = truncateToWidth(text, width, "");
  return fitted + padding.repeat(Math.max(0, width - visibleWidth(fitted)));
}

type EndMessage = { role?: string; stopReason?: string };

export function lastAssistantMessage(messages: readonly EndMessage[]): EndMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export function isAbortedAssistantStop(messages: readonly EndMessage[]): boolean {
  const assistant = lastAssistantMessage(messages);
  return assistant?.role === "assistant" && assistant.stopReason === "aborted";
}

export function formatSessionReplacementConfirm(runs: readonly Run[]): { title: string; message: string } {
  const profiles = [...new Set(runs.map((run) => run.profile))].join(", ");
  return {
    title: "Stop Herdr subagents?",
    message: [
      `This session still owns ${runs.length} non-closed Herdr subagent run(s) (${profiles || "unknown"}).`,
      "Confirmation stops those children, recovers any raced final result, and durably discards unfinished child transcripts.",
      "Dirty worker worktrees and generated branches are preserved.",
      "Refuse or press Escape to keep the current session bound and leave children running.",
    ].join("\n"),
  };
}

export function formatRetainedRecoveryNotice(summary: BulkStopSummary): string | undefined {
  const retained = summary.results.filter((result) => result.run.lifecycle === "retained");
  if (!retained.length && !summary.unprovenLive.length) return undefined;
  const lines = [
    "Herdr subagent cleanup left recoverable residue.",
    ...retained.map((result) => {
      const facts = result.retained.length ? result.retained.join(", ") : "retained resources";
      return `- ${result.run.id} [${result.run.profile}]: ${facts}; artifact ${result.run.artifactPath}`;
    }),
    ...summary.unprovenLive.map((id) => `- ${id}: child stop was not durably proven`),
    "Use subagent_status for current-owner runs and subagent_recover after session replacement.",
  ];
  return lines.join("\n");
}

export function sessionReplacementBlocked(summary: BulkStopSummary): boolean {
  return !summary.allChildrenStopped || summary.unprovenLive.length > 0;
}

function tuiWidget(presentation: WidgetPresentation) {
  return (_tui: TUI, theme: Theme): Component => ({
    render(width: number): string[] {
      if (width <= 0) return [];
      if (width <= 3) return [theme.fg("border", "─".repeat(width))];

      const innerWidth = width - 2;
      const top = theme.fg("border", `╭${fit(`─ ${presentation.header} `, innerWidth, "─")}╮`);
      const body = presentation.rows.map((row) => {
        const content = row.kind === "overflow"
          ? ` ${theme.fg("muted", row.label)}`
          : ` ${theme.fg(row.tone, "●")} ${row.profile.padEnd(PROFILE_WIDTH)} ${theme.fg("dim", `${row.id} · ${row.generation}`)}${theme.fg(row.tone, row.phase)}`;
        return theme.fg("border", "│") + fit(content, innerWidth) + theme.fg("border", "│");
      });
      const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
      return [top, ...body, bottom];
    },
    invalidate() {},
  });
}

export default function herdrSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_HERDR_SUBAGENT === "1") return;

  const socketPath = process.env.HERDR_SOCKET_PATH;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!socketPath || !workspaceId) {
    let notified = false;
    pi.on("session_start", (_event, ctx) => {
      if (notified || !ctx.hasUI) return;
      notified = true;
      ctx.ui.notify("Herdr subagents inactive: start Pi through Herdr to enable them.", "info");
    });
    return;
  }

  const parentInstanceId = randomUUID();
  let refreshWidget: () => void = noRefresh;
  let refreshOwner: object | undefined;
  let catalogSessionId: string | undefined;
  let catalogBuildSessionId: string | undefined;
  let catalogVersion = 0;
  let catalogPending = false;
  const runtime = new SubagentRuntime(
    new SocketHerdrClient({ socketPath }),
    {
      workspaceId,
      agentDir: getAgentDir(),
    },
    {
      instanceIdFactory: () => parentInstanceId,
      parentProcessId: process.pid,
      appendState(customType, record) {
        pi.appendEntry(customType, record);
      },
      deliverResult(message) {
        pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      },
      deliverAction(message) {
        pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      },
      onRunsChanged() {
        refreshWidget();
      },
    },
  );
  registerSubagentTools(pi, runtime);

  pi.on("resources_discover", () => ({ skillPaths: [skillPath] }));
  pi.on("session_start", async (event, ctx) => {
    refreshWidget = noRefresh;
    refreshOwner = undefined;
    catalogPending = false;
    catalogVersion++;
    catalogSessionId = ctx.sessionManager.getSessionId();
    const diagnostics = await runtime.bindParent({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    }, ctx.sessionManager.getBranch(), event.reason);
    const globalDiagnostics = event.reason === "reload"
      ? []
      : await runtime.reconcileGlobalLocators();
    if (ctx.sessionManager.getBranch().some((entry) => entry.type === "compaction")) {
      catalogPending = true;
      catalogVersion++;
    }
    if (ctx.hasUI) {
      const sessionManager = ctx.sessionManager;
      const ui = ctx.ui;
      refreshOwner = sessionManager;
      refreshWidget = () => {
        const request = runtime.requestFor({
          parentSessionId: sessionManager.getSessionId(),
          parentSessionFile: sessionManager.getSessionFile(),
          parentEntryId: sessionManager.getLeafId(),
        });
        const runs = runtime.list(request);
        if (ctx.mode === "tui") {
          const presentation = presentSubagentWidget(runs);
          ui.setWidget(WIDGET_KEY, presentation ? tuiWidget(presentation) : undefined);
        } else {
          ui.setWidget(WIDGET_KEY, formatSubagentWidget(runs));
        }
      };
      refreshWidget();
      for (const diagnostic of diagnostics) ui.notify(diagnostic.message, diagnostic.outcome === "closed" || diagnostic.outcome === "cleaned" ? "info" : "warning");
      for (const diagnostic of globalDiagnostics) {
        ui.notify(diagnostic.message, diagnostic.outcome === "closed" || diagnostic.outcome === "cleaned" ? "info" : "warning");
      }
    }
  });
  pi.on("session_compact", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId !== catalogSessionId) return;
    catalogPending = true;
    catalogVersion++;
  });
  pi.on("context", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!catalogPending || sessionId !== catalogSessionId || catalogBuildSessionId === sessionId) return;
    catalogBuildSessionId = sessionId;
    const buildVersion = catalogVersion;
    try {
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile) throw new Error("Recovery catalog requires a persisted parent session");
      const request = runtime.requestFor({
        parentSessionId: sessionId,
        parentSessionFile,
        parentEntryId: ctx.sessionManager.getLeafId(),
      });
      const catalog = buildRecoveryCatalog({
        entries: ctx.sessionManager.getEntries(),
        branch: ctx.sessionManager.getBranch(),
        parentSessionId: sessionId,
        parentSessionFile,
        currentRuns: runtime.list(request),
        artifacts: await enumerateRunArtifacts(getAgentDir(), sessionId),
      });
      if (ctx.sessionManager.getSessionId() !== sessionId || catalogSessionId !== sessionId) return;
      if (catalogVersion === buildVersion) catalogPending = false;
      return {
        messages: [...event.messages, {
          role: "custom" as const,
          customType: "herdr-subagent-recovery-catalog",
          content: formatRecoveryCatalog(catalog.rows),
          display: false,
          timestamp: Date.now(),
        }],
      };
    } finally {
      if (catalogBuildSessionId === sessionId) catalogBuildSessionId = undefined;
    }
  });
  pi.on("message_end", (event, ctx) => {
    runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    });
    runtime.confirmDelivery(event.message);
  });
  pi.on("agent_end", async (event, ctx) => {
    if (!isAbortedAssistantStop(event.messages)) return;
    const request = runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    });
    if (!runtime.hasNonClosedRuns(request)) return;
    const summary = await runtime.stopCurrentOwner({
      ...request,
      reason: "Parent agent aborted",
      discardIncompleteResult: true,
    });
    refreshWidget();
    if (!ctx.hasUI) return;
    const notice = formatRetainedRecoveryNotice(summary);
    if (notice) ctx.ui.notify(notice, "warning");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const results = await runtime.settle(runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    }));
    for (const result of results) {
      const action = retainedCleanupAction(result);
      if (action) pi.sendMessage(action, { deliverAs: "steer", triggerTurn: true });
    }
  });
  pi.on("session_before_tree", (_event, ctx) => {
    const request = runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    });
    if (runtime.hasOpenRuns(request)) return { cancel: true };
  });

  async function confirmSessionReplacement(ctx: {
    hasUI: boolean;
    ui?: {
      confirm?(title: string, message: string): Promise<boolean>;
      notify?(message: string, type?: "info" | "warning" | "error"): void;
    };
    sessionManager: {
      getSessionId(): string;
      getSessionFile(): string | undefined;
      getLeafId(): string | null;
    };
  }): Promise<{ cancel?: boolean } | void> {
    const request = runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    });
    if (!runtime.hasNonClosedRuns(request)) return;

    const runs = runtime.list(request).filter((run) => run.lifecycle !== "closed");
    if (!ctx.hasUI || !ctx.ui?.confirm) {
      if (ctx.hasUI) {
        ctx.ui?.notify?.(
          "Herdr subagents block headless session replacement while non-closed runs exist. Stop them with subagent_stop first.",
          "warning",
        );
      }
      return { cancel: true };
    }

    const prompt = formatSessionReplacementConfirm(runs);
    const confirmed = await ctx.ui.confirm(prompt.title, prompt.message);
    if (!confirmed) return { cancel: true };

    const summary = await runtime.stopCurrentOwner({
      ...request,
      reason: "Parent session replacement",
      discardIncompleteResult: true,
    });
    refreshWidget();

    if (sessionReplacementBlocked(summary)) {
      const notice = formatRetainedRecoveryNotice(summary)
        ?? "Herdr subagent cleanup could not prove every child stopped; session replacement cancelled.";
      ctx.ui.notify?.(notice, "warning");
      return { cancel: true };
    }

    const release = await runtime.releaseCurrentOwnerLocators(request);
    if (release.failed.length) {
      ctx.ui.notify?.(
        `Herdr recovery locator release failed; session replacement cancelled.\n${release.failed.join("\n")}`,
        "warning",
      );
      return { cancel: true };
    }

    const notice = formatRetainedRecoveryNotice(summary);
    if (notice) ctx.ui.notify?.(notice, "info");
  }

  pi.on("session_before_switch", async (_event, ctx) => confirmSessionReplacement(ctx));
  pi.on("session_before_fork", async (_event, ctx) => confirmSessionReplacement(ctx));
  pi.on("session_shutdown", async (event, ctx) => {
    const sessionManager = ctx.sessionManager;
    const currentRefresh = refreshWidget;
    const ownsRefresh = refreshOwner === undefined || refreshOwner === sessionManager;
    try {
      runtime.requestFor({
        parentSessionId: sessionManager.getSessionId(),
        parentSessionFile: sessionManager.getSessionFile(),
        parentEntryId: sessionManager.getLeafId(),
      });
      await runtime.shutdown(event.reason);
    } finally {
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
      if (ownsRefresh && refreshWidget === currentRefresh) {
        refreshWidget = noRefresh;
        refreshOwner = undefined;
      }
      if (catalogSessionId === sessionManager.getSessionId()) {
        catalogPending = false;
        if (catalogBuildSessionId === catalogSessionId) catalogBuildSessionId = undefined;
        catalogSessionId = undefined;
      }
    }
  });
}
