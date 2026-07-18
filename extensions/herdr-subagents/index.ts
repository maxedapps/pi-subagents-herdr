import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SocketHerdrClient } from "../../src/herdr.ts";
import { SubagentRuntime } from "../../src/runtime.ts";
import { registerSubagentTools } from "../../src/tools.ts";

const skillPath = fileURLToPath(new URL("../../skills/use-herdr-subagents/SKILL.md", import.meta.url));

export default function herdrSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_HERDR_SUBAGENT === "1") return;

  const parentInstanceId = randomUUID();
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
    },
  );
  registerSubagentTools(pi, runtime);

  pi.on("resources_discover", () => ({ skillPaths: [skillPath] }));
  pi.on("session_start", async (event, ctx) => {
    const diagnostics = await runtime.bindParent({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    }, ctx.sessionManager.getBranch(), event.reason);
    if (ctx.hasUI) {
      for (const diagnostic of diagnostics) ctx.ui.notify(diagnostic.message, diagnostic.outcome === "closed" || diagnostic.outcome === "cleaned" ? "info" : "warning");
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
    runtime.requestFor({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentEntryId: ctx.sessionManager.getLeafId(),
    });
    await runtime.shutdown(event.reason);
  });
}
