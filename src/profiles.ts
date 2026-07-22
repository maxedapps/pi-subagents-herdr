import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PROFILE_KEYS = new Set([
  "name",
  "description",
  "use-worktree",
  "tools",
  "model",
  "thinking",
]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const BUNDLED_PROFILE_DIRECTORY = fileURLToPath(new URL("../agents", import.meta.url));

export const MAX_PROFILE_DESCRIPTION_LENGTH = 256;

export type ProfileName = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Profile {
  readonly name: ProfileName;
  readonly description: string;
  readonly useWorktree: boolean;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly systemPrompt: string;
  readonly filePath: string;
}

export type ProfileCatalog = Readonly<Record<ProfileName, Profile>>;

export interface LoadProfileCatalogOptions {
  bundledDir?: string;
  userDir?: string;
}

export interface ParentLaunchSnapshot {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface PiLaunch {
  name: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 64
    && PROFILE_NAME_PATTERN.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(filePath: string, message: string): never {
  throw new Error(`Invalid subagent profile ${filePath}: ${message}`);
}

function requireString(
  frontmatter: Record<string, unknown>,
  key: string,
  filePath: string,
): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || !value.trim()) fail(filePath, `${key} must be a non-empty string`);
  return value.trim();
}

function parseProfile(filePath: string): Profile {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(filePath, error instanceof Error ? error.message : String(error));
  }

  const { frontmatter, body } = parsed;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    fail(filePath, "frontmatter must be a mapping");
  }
  const values = frontmatter as Record<string, unknown>;
  const unknownKeys = Object.keys(values).filter((key) => !PROFILE_KEYS.has(key)).sort(compareText);
  if (unknownKeys.length) fail(filePath, `unknown frontmatter key(s): ${unknownKeys.join(", ")}`);

  const name = values.name;
  if (!isProfileName(name)) fail(filePath, "name must be 1-64 characters of lowercase kebab-case");

  const description = requireString(values, "description", filePath);
  if (description.length > MAX_PROFILE_DESCRIPTION_LENGTH) {
    fail(filePath, `description must be at most ${MAX_PROFILE_DESCRIPTION_LENGTH} characters`);
  }

  if (typeof values["use-worktree"] !== "boolean") {
    fail(filePath, "use-worktree must be a boolean");
  }
  const useWorktree = values["use-worktree"];

  let tools: readonly string[] | undefined;
  if (Object.hasOwn(values, "tools")) {
    if (!Array.isArray(values.tools) || values.tools.length === 0) {
      fail(filePath, "tools must be a non-empty array of unique identifiers");
    }
    if (!values.tools.every((tool) => typeof tool === "string" && TOOL_NAME_PATTERN.test(tool))) {
      fail(filePath, "tools must be a non-empty array of unique identifiers");
    }
    if (new Set(values.tools).size !== values.tools.length) {
      fail(filePath, "tools must be a non-empty array of unique identifiers");
    }
    tools = Object.freeze([...values.tools]);
  }

  let model: string | undefined;
  if (Object.hasOwn(values, "model")) model = requireString(values, "model", filePath);

  let thinking: ThinkingLevel | undefined;
  if (Object.hasOwn(values, "thinking")) {
    if (typeof values.thinking !== "string" || !THINKING_LEVELS.has(values.thinking as ThinkingLevel)) {
      fail(filePath, `thinking must be one of: ${[...THINKING_LEVELS].join(", ")}`);
    }
    thinking = values.thinking as ThinkingLevel;
  }

  const systemPrompt = body.trim();
  if (!systemPrompt) fail(filePath, "body must be a non-empty system prompt");

  return Object.freeze({
    name,
    description,
    useWorktree,
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    systemPrompt,
    filePath,
  });
}

function loadLayer(directory: string, optional: boolean): Map<ProfileName, Profile> {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error(`Cannot load subagent profile directory ${directory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const profiles = new Map<ProfileName, Profile>();
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (entry.name === "README.md" || !entry.name.endsWith(".md") || !entry.isFile()) continue;
    const profile = parseProfile(join(directory, entry.name));
    const duplicate = profiles.get(profile.name);
    if (duplicate) {
      throw new Error(`Duplicate subagent profile name ${profile.name} in ${duplicate.filePath} and ${profile.filePath}`);
    }
    profiles.set(profile.name, profile);
  }
  return profiles;
}

export function loadProfileCatalog(options: LoadProfileCatalogOptions = {}): ProfileCatalog {
  const bundled = loadLayer(options.bundledDir ?? BUNDLED_PROFILE_DIRECTORY, false);
  const user = loadLayer(options.userDir ?? join(getAgentDir(), "herdr-subagents", "agents"), true);
  for (const [name, profile] of user) bundled.set(name, profile);

  const catalog = Object.create(null) as Record<ProfileName, Profile>;
  for (const name of [...bundled.keys()].sort(compareText)) catalog[name] = bundled.get(name)!;
  return Object.freeze(catalog);
}

export function buildPiLaunch(
  profile: Profile,
  parent: ParentLaunchSnapshot,
  runId: string,
  childSessionDir: string,
  childSessionId: string,
  artifactPath: string,
): PiLaunch {
  const name = `${profile.name}-${runId.slice(-8)}`;
  const systemPrompt = [
    profile.systemPrompt,
    `Archive: ${artifactPath}. The extension writes this file automatically. Never edit it. After compaction or uncertainty, read it before relying on earlier parent instructions or your prior results.`,
  ].join("\n\n");
  const argv = [
    "pi",
    "--session-dir", childSessionDir,
    "--session-id", childSessionId,
    "--name", name,
  ];
  const model = profile.model ?? parent.model;
  const thinking = profile.thinking ?? parent.thinking;
  if (model) argv.push("--model", model);
  if (thinking) argv.push("--thinking", thinking);
  if (profile.tools) argv.push("--tools", profile.tools.join(","));
  argv.push("--append-system-prompt", systemPrompt);
  return {
    name,
    argv,
    env: { PI_HERDR_SUBAGENT: "1" },
  };
}
