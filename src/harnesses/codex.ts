import { isAbsolute, relative } from "node:path";
import {
  assertLaunchHarness,
  assertThinkingSupported,
  canonicalExistingDirectory,
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

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function writableRoots(input: AdapterCheckInput): Promise<readonly string[]> {
  const requested = input.writableRoots ?? [];
  if (!input.policy.permissions.mutation && requested.length > 0) {
    throw new HarnessConfigurationError("Read-only Codex policy cannot grant additional writable roots");
  }
  const trusted = await Promise.all(input.policy.trustedRoots.map((root) => canonicalExistingDirectory(root, "Trusted root")));
  const output: string[] = [];
  for (const root of requested) {
    const canonical = await canonicalExistingDirectory(root, "Codex writable root");
    if (!trusted.some((candidate) => isWithin(candidate, canonical))) {
      throw new HarnessConfigurationError(`Codex writable root is outside monotonic trusted roots: ${canonical}`);
    }
    if (canonical !== input.policy.cwd && !output.includes(canonical)) output.push(canonical);
  }
  return output;
}

function assertCodexPolicy(input: AdapterCheckInput): void {
  if (input.policy.tools.length !== 0) {
    throw new HarnessConfigurationError("Codex has no equivalent explicit tool allowlist; profiles with tools must be rejected rather than inferred across harnesses");
  }
  if ((input.reviewedSkillPaths?.length ?? 0) !== 0 || (input.profile.skills?.length ?? 0) !== 0 || (input.profile.preferredSkills?.length ?? 0) !== 0) {
    throw new HarnessConfigurationError("Codex profile skills/preferredSkills are not loaded by this adapter");
  }
  if (input.integrationPolicy !== undefined && input.integrationPolicy !== "integrated") {
    throw new HarnessConfigurationError("Codex does not support the Claude safe-mode integration policy");
  }
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly kind = "codex" as const;
  readonly capabilities = ADAPTER_CAPABILITIES.codex;

  async check(input: AdapterCheckInput): Promise<CapabilityReport> {
    assertLaunchHarness(input, this.kind);
    assertThinkingSupported(this.capabilities, input.policy.thinking);
    assertCodexPolicy(input);
    await Promise.all([validateResolvedExecutable(input.executable), validateLaunchPaths(input), writableRoots(input)]);
    return capabilityReport(this.capabilities, input.executable);
  }

  async buildLaunch(input: AdapterCheckInput): Promise<HarnessLaunch> {
    await this.check(input);
    const paths = await validateLaunchPaths(input);
    const roots = await writableRoots(input);
    const sandbox = input.policy.permissions.mutation ? "workspace-write" : "read-only";
    const approval = input.policy.permissions.mutation ? "on-request" : "never";
    const argv: string[] = [
      input.executable,
      "--strict-config",
      "--sandbox", sandbox,
      "--ask-for-approval", approval,
      "--cd", paths.cwd,
      "--disable", "multi_agent",
      "--disable", "multi_agent_v2",
      "-c", `model_reasoning_effort=${tomlString(input.policy.thinking)}`,
      "-c", `model_instructions_file=${tomlString(paths.systemPromptPath)}`,
      "-c", "sandbox_workspace_write.writable_roots=[]",
      "-c", `sandbox_workspace_write.network_access=${input.policy.permissions.network ? "true" : "false"}`,
    ];
    if (!input.policy.permissions.network) argv.push("-c", "web_search=\"disabled\"");
    else argv.push("--search");
    if (input.policy.model !== undefined) argv.push("--model", input.policy.model);
    for (const root of roots) argv.push("--add-dir", root);
    const env = {
      ...childMetadataEnvironment(input.metadata),
      CODEX_HERDR_SUBAGENT: "1",
      CODEX_HERDR_SUBAGENT_RUN_ID: input.metadata.runId,
      CODEX_HERDR_DISABLE_NATIVE_SUBAGENTS: "1",
    };
    return { argv, env, cwd: paths.cwd, capabilities: this.capabilities };
  }
}

export async function prepareCodexExecutable(configured?: string): Promise<string> {
  return resolveExecutable("codex", configured);
}
