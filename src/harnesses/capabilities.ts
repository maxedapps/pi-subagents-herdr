import type { Harness } from "../contracts/harness.ts";
import type { AdapterCapabilities } from "./base.ts";

export const ADAPTER_CAPABILITIES: Readonly<Record<Harness, AdapterCapabilities>> = Object.freeze({
  pi: Object.freeze({
    harness: "pi",
    executable: "pi",
    toolVisibility: "allowlist",
    filesystemConfinement: "none",
    approvalBehavior: "none",
    modelSelection: true,
    supportedThinking: Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
    readiness: "herdr-semantic-state",
    interruptKeys: Object.freeze(["ctrl+c"]),
    gracefulExit: Object.freeze({ kind: "keys", keys: Object.freeze(["ctrl+d"]) }),
    nativeSessionIdentity: "available",
    customizationPolicy: "Extension discovery remains enabled for Herdr integration; skills and prompt templates are discovery-disabled and only reviewed skill paths are added.",
    limitations: Object.freeze([
      "Pi tool allowlists are not an operating-system filesystem sandbox.",
      "Shell-capable tools can invoke other programs; no-recursion is additionally enforced by child guards and instructions.",
    ]),
  }),
  claude: Object.freeze({
    harness: "claude",
    executable: "claude",
    toolVisibility: "allowlist",
    filesystemConfinement: "none",
    approvalBehavior: "native",
    modelSelection: true,
    supportedThinking: Object.freeze(["low", "medium", "high", "xhigh", "max"] as const),
    readiness: "herdr-semantic-state",
    interruptKeys: Object.freeze(["escape"]),
    gracefulExit: Object.freeze({ kind: "keys", keys: Object.freeze(["ctrl+d"]) }),
    nativeSessionIdentity: "integrated-only",
    customizationPolicy: "Integrated mode retains settings/hooks for native Herdr identity but disables slash skills and MCP; safe mode disables all customizations, including Herdr's native-session hook.",
    limitations: Object.freeze([
      "Claude tool and permission policies are not an operating-system filesystem sandbox.",
      "Strict safe mode loses native Herdr session identity; screen state remains available.",
    ]),
  }),
  codex: Object.freeze({
    harness: "codex",
    executable: "codex",
    toolVisibility: "sandbox-only",
    filesystemConfinement: "codex-os-sandbox",
    approvalBehavior: "native",
    modelSelection: true,
    supportedThinking: Object.freeze(["low", "medium", "high"] as const),
    readiness: "herdr-semantic-state",
    interruptKeys: Object.freeze(["escape"]),
    gracefulExit: Object.freeze({ kind: "input", text: "/exit", keys: Object.freeze(["enter"]) }),
    nativeSessionIdentity: "available",
    customizationPolicy: "Explicit sandbox/approval/config overrides disable native multi-agent features and constrain writable roots; no cross-harness tool allowlist is inferred.",
    limitations: Object.freeze([
      "Codex has no equivalent per-built-in-tool allowlist in this adapter; profiles with explicit tools are rejected.",
      "The Codex sandbox governs model-generated shell/file operations; external integrations must not be treated as equivalent tools.",
    ]),
  }),
} as const);

export function adapterCapabilities(harness: Harness): AdapterCapabilities {
  return ADAPTER_CAPABILITIES[harness];
}
