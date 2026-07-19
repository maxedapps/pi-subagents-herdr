import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SocketHerdrClient } from "../../src/herdr.ts";
import { SubagentRuntime, type Run } from "../../src/runtime.ts";
import { registerSubagentTools } from "../../src/tools.ts";

const skillPath = fileURLToPath(new URL("../../skills/use-herdr-subagents/SKILL.md", import.meta.url));
const WIDGET_KEY = "herdr-subagents";
const PROFILE_WIDTH = 10;
const noRefresh = () => {};

function phase(run: Run): string {
  if (run.lifecycle === "retained") return "retained";
  if (run.lifecycle === "stopping" || run.lifecycle === "starting") return run.lifecycle;
  if (!run.generation) return "ready";
  if (run.generation.delivery === "queued") return "result queued";
  if (run.generation.delivery === "ready") return "result ready";
  if (run.generation.delivery === "delivered") return "ready";
  if (run.status === "blocked") return "blocked";
  if (run.status === "working") return "working";
  return "waiting for result";
}

export function formatSubagentWidget(runs: readonly Run[]): string[] | undefined {
  const visible = runs.filter((run) => run.lifecycle !== "closed");
  if (!visible.length) return undefined;

  const retained = visible.filter((run) => run.lifecycle === "retained").length;
  const active = visible.length - retained;
  const header = `Subagents · ${active} active${retained ? ` · ${retained} retained` : ""}`;
  const rows = visible.map((run) => {
    const id = (run.id.startsWith("run-") ? run.id.slice(4) : run.id).slice(0, 8);
    const generation = run.generation ? `g${run.generation.number} ` : "";
    return `  ${run.profile.padEnd(PROFILE_WIDTH)} ${id} · ${generation}${phase(run)}`;
  });
  return rows.length <= 5
    ? [header, ...rows]
    : [header, ...rows.slice(0, 4), `+${rows.length - 4} more`];
}

export default function herdrSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_HERDR_SUBAGENT === "1") return;

  const parentInstanceId = randomUUID();
  let refreshWidget: () => void = noRefresh;
  let refreshOwner: object | undefined;
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
    const diagnostics = await runtime.bindParent({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    }, ctx.sessionManager.getBranch(), event.reason);
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
        ui.setWidget(WIDGET_KEY, formatSubagentWidget(runtime.list(request)));
      };
      refreshWidget();
      for (const diagnostic of diagnostics) ui.notify(diagnostic.message, diagnostic.outcome === "closed" || diagnostic.outcome === "cleaned" ? "info" : "warning");
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
  pi.on("agent_settled", async (_event, ctx) => {
    await runtime.settle(runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    }));
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
    }
  });
}
