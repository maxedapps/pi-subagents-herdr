import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrSubagentsExtension } from "../../src/lifecycle/extension.ts";

/**
 * Registration only. Sockets, timers, processes, settings reads, and UI are
 * deferred to session lifecycle services or explicit registered tool calls.
 */
export default function herdrSubagentsExtension(pi: ExtensionAPI): void {
  registerHerdrSubagentsExtension(pi);
}
