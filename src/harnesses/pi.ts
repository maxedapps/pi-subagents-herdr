import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

async function reviewedSkills(input: AdapterCheckInput): Promise<readonly string[]> {
  const requested = input.reviewedSkillPaths ?? [];
  if ((input.profile.skills?.length ?? 0) > requested.length) {
    throw new HarnessConfigurationError("Every required Pi profile skill must resolve to an explicit reviewed --skill path");
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const path of requested) {
    if (!isAbsolute(path)) throw new HarnessConfigurationError("Reviewed Pi skill paths must be absolute");
    const canonical = await realpath(path).catch(() => undefined);
    if (!canonical) throw new HarnessConfigurationError(`Reviewed Pi skill path does not exist: ${path}`);
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) {
      throw new HarnessConfigurationError(`Reviewed Pi skill path is not a regular file/directory: ${path}`);
    }
    if (!seen.has(canonical)) { seen.add(canonical); output.push(canonical); }
  }
  return output;
}

export class PiHarnessAdapter implements HarnessAdapter {
  readonly kind = "pi" as const;
  readonly capabilities = ADAPTER_CAPABILITIES.pi;

  async check(input: AdapterCheckInput): Promise<CapabilityReport> {
    assertLaunchHarness(input, this.kind);
    assertThinkingSupported(this.capabilities, input.policy.thinking);
    await Promise.all([validateResolvedExecutable(input.executable), validateLaunchPaths(input), reviewedSkills(input)]);
    return capabilityReport(this.capabilities, input.executable);
  }

  async buildLaunch(input: AdapterCheckInput): Promise<HarnessLaunch> {
    await this.check(input);
    const paths = await validateLaunchPaths(input);
    if (paths.sessionDirectory === undefined) throw new HarnessConfigurationError("Pi requires a private session directory");
    const skills = await reviewedSkills(input);
    const argv: string[] = [
      input.executable,
      "--session-id", input.sessionId,
      "--session-dir", paths.sessionDirectory,
      "--name", input.sessionName,
      "--thinking", input.policy.thinking,
      "--append-system-prompt", paths.systemPromptPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
    ];
    if (input.policy.model !== undefined) argv.push("--model", input.policy.model);
    if (input.policy.tools.length === 0) argv.push("--no-tools");
    else argv.push("--tools", input.policy.tools.map((tool) => tool.name).join(","));
    if (input.profile.context?.project !== true) argv.push("--no-context-files");
    for (const path of skills) argv.push("--skill", path);

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
    };
    return { argv, env, cwd: paths.cwd, capabilities: this.capabilities };
  }
}

export async function preparePiExecutable(configured?: string): Promise<string> {
  return resolveExecutable("pi", configured);
}
