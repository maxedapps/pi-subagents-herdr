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

export class PiHarnessAdapter implements HarnessAdapter {
  readonly kind = "pi" as const;
  readonly capabilities = ADAPTER_CAPABILITIES.pi;

  async check(input: AdapterCheckInput): Promise<CapabilityReport> {
    assertLaunchHarness(input, this.kind);
    assertThinkingSupported(this.capabilities, input.policy.thinking);
    await Promise.all([validateResolvedExecutable(input.executable), validateLaunchPaths(input)]);
    return capabilityReport(this.capabilities, input.executable);
  }

  async buildLaunch(input: AdapterCheckInput): Promise<HarnessLaunch> {
    await this.check(input);
    const paths = await validateLaunchPaths(input);
    if (paths.sessionDirectory === undefined) throw new HarnessConfigurationError("Pi requires a private session directory");
    const argv: string[] = [
      input.executable,
      "--session-id", input.sessionId,
      "--session-dir", paths.sessionDirectory,
      "--name", input.sessionName,
      "--thinking", input.policy.thinking,
      "--append-system-prompt", paths.systemPromptPath,
    ];
    if (input.policy.model !== undefined) argv.push("--model", input.policy.model);
    if (input.policy.tools.length === 0) argv.push("--no-tools");
    else argv.push("--tools", input.policy.tools.map((tool) => tool.name).join(","));
    if (input.profile.context?.project !== true) argv.push("--no-context-files");

    const env = {
      ...childMetadataEnvironment(input.metadata),
      PI_SUBAGENT_CHILD: "1",
      PI_HERDR_SUBAGENT: "1",
      PI_HERDR_SUBAGENT_RUN_ID: input.metadata.runId,
      PI_HERDR_SUBAGENT_RUN_NONCE: input.metadata.runNonce,
      PI_HERDR_SUBAGENT_PROFILE: input.metadata.profileName,
      PI_HERDR_SUBAGENT_PARENT_SESSION_ID: input.metadata.parentSessionId,
      ...(input.metadata.parentSessionPath === undefined ? {} : {
        PI_HERDR_SUBAGENT_PARENT_SESSION_PATH: input.metadata.parentSessionPath,
      }),
      ...(input.metadata.resultExchangeDirectory === undefined ? {} : {
        PI_HERDR_SUBAGENT_RESULT_EXCHANGE: input.metadata.resultExchangeDirectory,
      }),
    };
    return { argv, env, cwd: paths.cwd, capabilities: this.capabilities };
  }
}

export async function preparePiExecutable(configured?: string): Promise<string> {
  return resolveExecutable("pi", configured);
}
