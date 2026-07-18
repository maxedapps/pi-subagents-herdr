import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { SocketHerdrClient } from "../../src/herdr.ts";
import { SubagentRuntime } from "../../src/runtime.ts";
import { registerSubagentTools } from "../../src/tools.ts";

const skillPath = fileURLToPath(new URL("../../skills/use-herdr-subagents/SKILL.md", import.meta.url));

export default function herdrSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_HERDR_SUBAGENT === "1") return;

  const runtime = new SubagentRuntime(
    new SocketHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH ?? "" }),
    { workspaceId: process.env.HERDR_WORKSPACE_ID ?? "" },
  );
  registerSubagentTools(pi, runtime);
  pi.on("resources_discover", () => ({ skillPaths: [skillPath] }));
}
