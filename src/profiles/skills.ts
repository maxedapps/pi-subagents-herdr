import { lstat, realpath } from "node:fs/promises";
import { loadSkills, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { Harness } from "../contracts/harness.ts";
import type { AgentProfile } from "../contracts/profile.ts";
import type { Diagnostic } from "../contracts/result.ts";

export interface ResolvedProfileSkill {
  readonly name: string;
  readonly path: string;
  readonly required: boolean;
}

export interface ProfileSkillResolution {
  readonly resources: readonly ResolvedProfileSkill[];
  readonly names: readonly string[];
  readonly paths: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResolveProfileSkillsOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly projectTrusted: boolean;
  readonly commands: readonly SlashCommandInfo[];
  readonly prohibitedNames?: readonly string[];
}

export class ProfileSkillResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileSkillResolutionError";
  }
}

async function reviewedSkill(command: SlashCommandInfo, expectedName: string, options: ResolveProfileSkillsOptions): Promise<string> {
  const sourcePath = command.sourceInfo.path;
  const canonical = await realpath(sourcePath).catch(() => undefined);
  if (!canonical) throw new ProfileSkillResolutionError(`Pi skill ${expectedName} has no existing reviewed resource path: ${sourcePath}`);
  const info = await lstat(canonical);
  if (!info.isFile()) throw new ProfileSkillResolutionError(`Pi skill ${expectedName} must resolve to a regular Markdown file: ${canonical}`);
  const loaded = loadSkills({ cwd: options.cwd, agentDir: options.agentDir, skillPaths: [canonical], includeDefaults: false });
  const exact = loaded.skills.find((skill) => skill.name === expectedName);
  if (!exact) {
    const details = loaded.diagnostics.map((item) => item.message).join("; ");
    throw new ProfileSkillResolutionError(`Pi skill command ${command.name} does not match a loadable reviewed skill at ${canonical}${details ? `: ${details}` : ""}`);
  }
  const exactCanonical = await realpath(exact.filePath);
  if (exactCanonical !== canonical) throw new ProfileSkillResolutionError(`Pi skill ${expectedName} changed identity while it was reviewed`);
  return canonical;
}

/** Resolve only resources Pi actually exposed, then canonicalize each explicit child --skill file. */
export async function resolveProfileSkills(
  profile: AgentProfile,
  harness: Harness,
  options: ResolveProfileSkillsOptions,
): Promise<ProfileSkillResolution> {
  const required = profile.skills ?? [];
  const preferred = profile.preferredSkills ?? [];
  if (harness !== "pi" && (required.length > 0 || preferred.length > 0)) {
    throw new ProfileSkillResolutionError(`${harness} does not support Pi profile skills; remove skills/preferredSkills or use harness: pi`);
  }
  if (harness !== "pi") return { resources: [], names: [], paths: [], diagnostics: [] };

  const prohibited = new Set(options.prohibitedNames ?? ["use-subagents"]);
  const commands = new Map<string, SlashCommandInfo[]>();
  for (const command of options.commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    if (!options.projectTrusted && command.sourceInfo.scope === "project") continue;
    const name = command.name.slice("skill:".length);
    const same = commands.get(name) ?? [];
    same.push(command);
    commands.set(name, same);
  }

  const resources: ResolvedProfileSkill[] = [];
  const diagnostics: Diagnostic[] = [];
  const resolveOne = async (name: string, isRequired: boolean): Promise<void> => {
    if (prohibited.has(name)) {
      if (isRequired) throw new ProfileSkillResolutionError(`Required skill ${name} is parent-only orchestration and cannot be exposed to a child`);
      diagnostics.push({ code: "profile-preferred-skill-prohibited", message: `Preferred skill is parent-only and was not exposed to child ${profile.name}: ${name}`, path: profile.source.path, severity: "warning" });
      return;
    }
    const candidates = commands.get(name) ?? [];
    if (candidates.length === 0) {
      if (isRequired) throw new ProfileSkillResolutionError(`Required Pi profile skill is unavailable from the current trusted Pi/package resources: ${name}`);
      diagnostics.push({ code: "profile-preferred-skill-unavailable", message: `Preferred skill is not exposed to child ${profile.name}: ${name}`, path: profile.source.path, severity: "warning" });
      return;
    }
    const canonicalCandidates = new Map<string, SlashCommandInfo>();
    for (const command of candidates) canonicalCandidates.set(await reviewedSkill(command, name, options), command);
    if (canonicalCandidates.size !== 1) {
      throw new ProfileSkillResolutionError(`Pi skill ${name} is ambiguous across reviewed resource paths: ${[...canonicalCandidates.keys()].join(", ")}`);
    }
    const path = canonicalCandidates.keys().next().value!;
    const existing = resources.find((resource) => resource.path === path);
    if (existing) return;
    resources.push({ name, path, required: isRequired });
  };

  for (const name of required) await resolveOne(name, true);
  for (const name of preferred) await resolveOne(name, false);
  return {
    resources,
    names: resources.map((resource) => resource.name),
    paths: resources.map((resource) => resource.path),
    diagnostics,
  };
}
