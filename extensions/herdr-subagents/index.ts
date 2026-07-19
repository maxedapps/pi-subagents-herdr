import { getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveArtifactDirectory } from "../../src/artifact.ts";
import { SocketHerdrClient } from "../../src/herdr.ts";
import { SubagentRuntime, type Run, type StopResult } from "../../src/runtime.ts";
import { registerSubagentTools } from "../../src/tools.ts";

const skillPath = fileURLToPath(new URL("../../skills/use-herdr-subagents/SKILL.md", import.meta.url));
const WIDGET_KEY = "herdr-subagents";
const PROFILE_WIDTH = 10;
const noRefresh = () => {};

async function hasRunArtifacts(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .some((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch {
    return false;
  }
}

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
  if (run.lifecycle !== "retained" || !run.worktree) return undefined;
  const reason = workerCleanup && !workerCleanup.removed
    ? workerCleanup.reason
    : run.error ?? "owned worker cleanup was incomplete";
  return {
    customType: "herdr-subagent-action" as const,
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
    display: true,
    details: {
      parentSessionId: run.parentSessionId,
      runId: run.id,
      artifactPath: run.artifactPath,
      worktree: { ...run.worktree },
      reason,
    },
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

  const parentInstanceId = randomUUID();
  let refreshWidget: () => void = noRefresh;
  let refreshOwner: object | undefined;
  let reminderSessionId: string | undefined;
  let reminderDirectory: string | undefined;
  let reminderPending = false;
  const runtime = new SubagentRuntime(
    new SocketHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH ?? "" }),
    {
      workspaceId: process.env.HERDR_WORKSPACE_ID ?? "",
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
    reminderPending = false;
    reminderSessionId = ctx.sessionManager.getSessionId();
    reminderDirectory = resolveArtifactDirectory(getAgentDir(), reminderSessionId);
    const diagnostics = await runtime.bindParent({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    }, ctx.sessionManager.getBranch(), event.reason);
    if (ctx.sessionManager.getBranch().some((entry) => entry.type === "compaction")
      && await hasRunArtifacts(reminderDirectory)) {
      reminderPending = true;
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
    }
  });
  pi.on("session_compact", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId !== reminderSessionId || !reminderDirectory) return;
    reminderPending = await hasRunArtifacts(reminderDirectory);
  });
  pi.on("context", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!reminderPending || sessionId !== reminderSessionId || !reminderDirectory) return;
    reminderPending = false;
    return {
      messages: [...event.messages, {
        role: "custom" as const,
        customType: "herdr-subagent-artifact-reminder",
        content: `Exact subagent exchanges remain under ${reminderDirectory}. List or read the relevant run file before relying on compacted subagent details.`,
        display: false,
        timestamp: Date.now(),
      }],
    };
  });
  pi.on("message_end", (event, ctx) => {
    runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    });
    runtime.confirmDelivery(event.message);
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
      if (reminderSessionId === sessionManager.getSessionId()) {
        reminderPending = false;
        reminderSessionId = undefined;
        reminderDirectory = undefined;
      }
    }
  });
}
