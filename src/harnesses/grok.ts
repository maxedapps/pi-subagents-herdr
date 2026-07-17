import { readFile } from "node:fs/promises";
import {
  assertLaunchHarness,
  assertThinkingSupported,
  capabilityReport,
  childMetadataEnvironment,
  HarnessConfigurationError,
  resolveExecutable,
  validateLaunchPaths,
  validateResolvedExecutable,
  type AdapterCheckInput,
  type CapabilityReport,
  type HarnessAdapter,
  type HarnessLaunch,
} from "./base.ts";
import { ADAPTER_CAPABILITIES } from "./capabilities.ts";

const MAX_RULES_BYTES = 16 * 1024;

function assertGrokPolicy(input: AdapterCheckInput): void {
  if (input.policy.tools.length !== 0) {
    throw new HarnessConfigurationError("Grok explicit tool lists are not supported; native sandbox/permission controls are used without cross-harness inference");
  }
  if ((input.writableRoots?.length ?? 0) !== 0) {
    throw new HarnessConfigurationError("Grok additional writable roots are not supported; writers are confined to the extension-owned worktree");
  }
  if (input.integrationPolicy !== undefined && input.integrationPolicy !== "integrated") {
    throw new HarnessConfigurationError("Grok does not support the Claude safe-mode integration policy");
  }
}

async function grokRules(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  if (!text.trim() || text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_RULES_BYTES) {
    throw new HarnessConfigurationError("Grok rules must be non-empty, NUL-free, and at most 16 KiB");
  }
  return text;
}

export class GrokHarnessAdapter implements HarnessAdapter {
  readonly kind = "grok" as const;
  readonly capabilities = ADAPTER_CAPABILITIES.grok;

  async check(input: AdapterCheckInput): Promise<CapabilityReport> {
    assertLaunchHarness(input, this.kind);
    assertThinkingSupported(this.capabilities, input.policy.thinking);
    assertGrokPolicy(input);
    const paths = await validateLaunchPaths(input);
    await Promise.all([validateResolvedExecutable(input.executable), grokRules(paths.systemPromptPath)]);
    return capabilityReport(this.capabilities, input.executable);
  }

  async buildLaunch(input: AdapterCheckInput): Promise<HarnessLaunch> {
    await this.check(input);
    const paths = await validateLaunchPaths(input);
    const rules = await grokRules(paths.systemPromptPath);
    const sandbox = input.policy.permissions.mutation
      ? input.policy.permissions.network ? "workspace" : "strict"
      : "read-only";
    const permission = input.policy.permissions.mutation ? "acceptEdits" : "dontAsk";
    const argv: string[] = [
      input.executable,
      "--session-id", input.sessionId,
      "--cwd", paths.cwd,
      "--sandbox", sandbox,
      "--permission-mode", permission,
      "--rules", rules,
      "--no-subagents",
      "--no-memory",
      "--no-auto-update",
    ];
    if (!input.policy.permissions.network) argv.push("--disable-web-search");
    if (input.policy.model !== undefined) argv.push("--model", input.policy.model);
    argv.push("--effort", input.policy.thinking);
    const env = {
      ...childMetadataEnvironment(input.metadata),
      GROK_HERDR_SUBAGENT: "1",
      GROK_HERDR_SUBAGENT_RUN_ID: input.metadata.runId,
      GROK_HERDR_DISABLE_NATIVE_SUBAGENTS: "1",
      GROK_DISABLE_AUTOUPDATER: "1",
    };
    return { argv, env, cwd: paths.cwd, capabilities: this.capabilities };
  }
}

export async function prepareGrokExecutable(configured?: string): Promise<string> {
  return resolveExecutable("grok", configured);
}
