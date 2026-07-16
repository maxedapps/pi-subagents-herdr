import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInterruptTool } from "./interrupt.ts";
import { TOOL_NAMES, TOOL_KEYS, type ToolKey } from "./names.ts";
import { registerSendTool } from "./send.ts";
import { HerdrToolRuntimeController } from "./service.ts";
import { registerStartTool } from "./start.ts";
import { registerStatusTool } from "./status.ts";
import { registerStopTool } from "./stop.ts";

const REGISTRARS: Readonly<Record<ToolKey, (pi: ExtensionAPI, runtime: HerdrToolRuntimeController, name: string) => void>> = {
  start: registerStartTool,
  status: registerStatusTool,
  send: registerSendTool,
  interrupt: registerInterruptTool,
  stop: registerStopTool,
};

export interface RegisterToolSurfaceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface RegisteredToolSurface {
  readonly runtime: HerdrToolRuntimeController;
  readonly names: readonly string[];
}

export function registerHerdrToolSurface(pi: ExtensionAPI, options: RegisterToolSurfaceOptions = {}): RegisteredToolSurface {
  const runtime = new HerdrToolRuntimeController(pi, {
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  for (const key of TOOL_KEYS) REGISTRARS[key](pi, runtime, TOOL_NAMES[key]);
  return { runtime, names: TOOL_KEYS.map((key) => TOOL_NAMES[key]) };
}

export * from "./contracts.ts";
export * from "./names.ts";
export * from "./schemas.ts";
export * from "./service.ts";
