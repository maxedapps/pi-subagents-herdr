import type { ToolGrant } from "../contracts/harness.ts";
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

const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = Object.freeze({
  read: "Read", Read: "Read",
  grep: "Grep", Grep: "Grep",
  find: "Glob", Glob: "Glob",
  bash: "Bash", Bash: "Bash",
  edit: "Edit", Edit: "Edit",
  write: "Write", Write: "Write",
  web_search: "WebSearch", WebSearch: "WebSearch",
  fetch_content: "WebFetch", WebFetch: "WebFetch",
});

function mapTools(tools: readonly ToolGrant[]): readonly string[] {
  const output: string[] = [];
  for (const tool of tools) {
    const mapped = CLAUDE_TOOL_MAP[tool.name];
    if (mapped === undefined) {
      throw new HarnessConfigurationError(`Claude has no reviewed tool mapping for ${tool.name}; cross-harness inference is forbidden`);
    }
    if (!output.includes(mapped)) output.push(mapped);
  }
  return output;
}

function assertClaudePolicy(input: AdapterCheckInput, tools: readonly string[]): void {
  const mutating = tools.some((tool) => tool === "Bash" || tool === "Edit" || tool === "Write");
  if (mutating && !input.policy.permissions.mutation) {
    throw new HarnessConfigurationError("Claude read-only policy contradicts a mutation-capable Bash/Edit/Write tool");
  }
  const network = tools.some((tool) => tool === "Bash" || tool === "WebSearch" || tool === "WebFetch");
  if (network && !input.policy.permissions.network) {
    throw new HarnessConfigurationError("Claude network-disabled policy contradicts a network-capable Bash/Web tool");
  }
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly kind = "claude" as const;
  readonly capabilities = ADAPTER_CAPABILITIES.claude;

  async check(input: AdapterCheckInput): Promise<CapabilityReport> {
    assertLaunchHarness(input, this.kind);
    assertThinkingSupported(this.capabilities, input.policy.thinking);
    const tools = mapTools(input.policy.tools);
    assertClaudePolicy(input, tools);
    await Promise.all([validateResolvedExecutable(input.executable), validateLaunchPaths(input)]);
    const integrationPolicy = input.integrationPolicy ?? "integrated";
    if (integrationPolicy !== "integrated" && integrationPolicy !== "safe-mode") {
      throw new HarnessConfigurationError(`Unsupported Claude integration policy ${String(integrationPolicy)}`);
    }
    return capabilityReport(this.capabilities, input.executable);
  }

  async buildLaunch(input: AdapterCheckInput): Promise<HarnessLaunch> {
    await this.check(input);
    const paths = await validateLaunchPaths(input);
    const tools = mapTools(input.policy.tools);
    const integrationPolicy = input.integrationPolicy ?? "integrated";
    const argv: string[] = [
      input.executable,
      "--session-id", input.sessionId,
      "--name", input.sessionName,
      "--tools", tools.join(","),
      "--disallowedTools", "Agent,Task",
      "--permission-mode", input.policy.permissions.mutation ? "acceptEdits" : "plan",
      "--effort", input.policy.thinking,
      "--append-system-prompt-file", paths.systemPromptPath,
      "--strict-mcp-config",
      "--mcp-config", "{\"mcpServers\":{}}",
      "--disable-slash-commands",
      "--agents", "{}",
      "--no-chrome",
    ];
    if (input.policy.model !== undefined) argv.push("--model", input.policy.model);
    if (integrationPolicy === "safe-mode") argv.push("--safe-mode");
    const env = {
      ...childMetadataEnvironment(input.metadata),
      CLAUDE_HERDR_SUBAGENT: "1",
      CLAUDE_HERDR_SUBAGENT_RUN_ID: input.metadata.runId,
      ...(integrationPolicy === "safe-mode" ? { CLAUDE_CODE_SAFE_MODE: "1" } : {}),
    };
    return { argv, env, cwd: paths.cwd, capabilities: this.capabilities };
  }
}

export async function prepareClaudeExecutable(configured?: string): Promise<string> {
  return resolveExecutable("claude", configured);
}
