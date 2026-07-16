import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/herdr-subagents/index.ts";

const events: string[] = [];
const tools: string[] = [];
const commands: string[] = [];
const fakeApi = {
  on(event: string) { events.push(event); },
  registerTool(tool: { name: string }) { tools.push(tool.name); },
  registerCommand(name: string) { commands.push(name); },
  getAllTools() { return []; },
};

extension(fakeApi as unknown as ExtensionAPI);
if (events.join(",") !== "resources_discover,session_start,agent_settled,session_shutdown") {
  throw new Error(`Unexpected clean-load event registrations: ${events.join(",")}`);
}
if (tools.join(",") !== "subagent_start,subagent_status,subagent_send,subagent_interrupt,subagent_stop") {
  throw new Error(`Unexpected clean-load tool registrations: ${tools.join(",")}`);
}
if (commands.join(",") !== "subagents,subagents-doctor") throw new Error(`Unexpected clean-load command registrations: ${commands.join(",")}`);
process.stdout.write("clean-load ok: registration only; no runtime resources started\n");
