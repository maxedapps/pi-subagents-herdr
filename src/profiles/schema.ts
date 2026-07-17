import type {
  AgentProfile,
  ProfileArtifactSettings,
  ProfileContextSettings,
  ProfilePermission,
  ProfileSource,
  ProfileWorktreePolicy,
} from "../contracts/profile.ts";
import { HARNESSES, type Harness, type ThinkingLevel } from "../contracts/harness.ts";
import { assertRunUniqueArtifactTemplate } from "../artifacts/paths.ts";

export const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROFILE_FIELDS = Object.freeze([
  "name",
  "description",
  "harness",
  "model",
  "thinking",
  "permissions",
  "tools",
  "preferredTools",
  "context",
  "timeout",
  "worktree",
  "disabled",
  "artifacts",
] as const);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PERMISSIONS = ["read-only", "write"] as const;
const WORKTREE_POLICIES = ["forbidden", "optional", "required", "required-for-concurrency"] as const;
const ARTIFACT_FIELDS = ["progress", "handoff", "writer"] as const;
const CONTEXT_FIELDS = ["project", "parent"] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

export class ProfileValidationError extends Error {
  readonly sourcePath: string;
  readonly issues: readonly string[];

  constructor(sourcePath: string, issues: readonly string[]) {
    super(`Invalid agent profile in ${sourcePath}: ${issues.join("; ")}`);
    this.name = "ProfileValidationError";
    this.sourcePath = sourcePath;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  issues: string[],
): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.push(`${field} must be one of: ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T;
}

function optionalString(value: unknown, field: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    issues.push(`${field} must be a non-empty string without NUL bytes`);
    return undefined;
  }
  return value.trim();
}

function stringList(value: unknown, field: string, issues: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${field} must be a non-empty array of identifiers`);
    return undefined;
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !IDENTIFIER_PATTERN.test(item)) {
      issues.push(`${field}[${index}] must be a valid non-empty identifier`);
      continue;
    }
    if (seen.has(item)) {
      issues.push(`${field}[${index}] duplicates ${item}`);
      continue;
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function contextSettings(value: unknown, issues: string[]): ProfileContextSettings | undefined {
  if (!isRecord(value)) {
    issues.push("context must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!CONTEXT_FIELDS.includes(key as (typeof CONTEXT_FIELDS)[number])) issues.push(`context.${key} is unknown`);
  }
  const output: { project?: boolean; parent?: boolean } = {};
  for (const field of CONTEXT_FIELDS) {
    const current = value[field];
    if (current === undefined) continue;
    if (typeof current !== "boolean") issues.push(`context.${field} must be a boolean`);
    else output[field] = current;
  }
  return output;
}

function artifactSettings(value: unknown, issues: string[]): ProfileArtifactSettings | undefined {
  if (!isRecord(value)) {
    issues.push("artifacts must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!ARTIFACT_FIELDS.includes(key as (typeof ARTIFACT_FIELDS)[number])) issues.push(`artifacts.${key} is unknown`);
  }
  const output: {
    progress?: string;
    handoff?: string;
    writer?: "parent" | "child";
  } = {};
  for (const field of ["progress", "handoff"] as const) {
    if (value[field] === undefined) continue;
    const parsed = optionalString(value[field], `artifacts.${field}`, issues);
    if (parsed === undefined) continue;
    try {
      assertRunUniqueArtifactTemplate(parsed);
      output[field] = parsed;
    } catch (error) {
      issues.push(`artifacts.${field} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (value.writer !== undefined) {
    const writer = enumValue(value.writer, "artifacts.writer", ["parent", "child"] as const, issues);
    if (writer !== undefined) output.writer = writer;
  }
  return output;
}

export function validateProfile(
  frontmatter: unknown,
  body: string,
  source: ProfileSource,
): AgentProfile {
  const issues: string[] = [];
  if (!isRecord(frontmatter)) throw new ProfileValidationError(source.path, ["frontmatter must be a YAML mapping"]);

  for (const key of Object.keys(frontmatter)) {
    if (key === "herdr") {
      issues.push(
        frontmatter.herdr === false
          ? "herdr: false is no longer supported; Herdr is mandatory and implicit—remove this field"
          : "herdr is implicit and mandatory—remove this legacy field",
      );
    } else if (key === "skills" || key === "preferredSkills") {
      issues.push(`${key}: remove this field; child Pi now uses normal skill discovery`);
    } else if (key === "runtime" || key === "command" || key === "argv") {
      issues.push(`${key} is an unsupported runtime field; select harness/profile policy instead`);
    } else if (!PROFILE_FIELDS.includes(key as (typeof PROFILE_FIELDS)[number])) {
      issues.push(`${key} is unknown`);
    }
  }

  const name = optionalString(frontmatter.name, "name", issues);
  if (name !== undefined && (!PROFILE_NAME_PATTERN.test(name) || name.length > 64)) {
    issues.push("name must be a 1-64 character lowercase kebab-case identifier");
  }
  const description = optionalString(frontmatter.description, "description", issues);
  if (description !== undefined && description.length > 1024) issues.push("description must be at most 1024 characters");
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) issues.push("profile body must be non-empty");

  const harness = frontmatter.harness === undefined
    ? undefined
    : enumValue(frontmatter.harness, "harness", HARNESSES, issues) as Harness | undefined;
  const model = frontmatter.model === undefined ? undefined : optionalString(frontmatter.model, "model", issues);
  const thinking = frontmatter.thinking === undefined
    ? undefined
    : enumValue(frontmatter.thinking, "thinking", THINKING_LEVELS, issues) as ThinkingLevel | undefined;
  const permissions = frontmatter.permissions === undefined
    ? undefined
    : enumValue(frontmatter.permissions, "permissions", PERMISSIONS, issues) as ProfilePermission | undefined;
  const tools = frontmatter.tools === undefined ? undefined : stringList(frontmatter.tools, "tools", issues);
  const preferredTools = frontmatter.preferredTools === undefined
    ? undefined
    : stringList(frontmatter.preferredTools, "preferredTools", issues);
  const context = frontmatter.context === undefined ? undefined : contextSettings(frontmatter.context, issues);

  let timeout: number | undefined;
  if (frontmatter.timeout !== undefined) {
    if (typeof frontmatter.timeout !== "number" || !Number.isInteger(frontmatter.timeout) || frontmatter.timeout < 1 || frontmatter.timeout > 86_400_000) {
      issues.push("timeout must be an integer from 1 to 86400000 milliseconds");
    } else timeout = frontmatter.timeout;
  }
  const worktree = frontmatter.worktree === undefined
    ? undefined
    : enumValue(frontmatter.worktree, "worktree", WORKTREE_POLICIES, issues) as ProfileWorktreePolicy | undefined;
  let disabled: boolean | undefined;
  if (frontmatter.disabled !== undefined) {
    if (typeof frontmatter.disabled !== "boolean") issues.push("disabled must be a boolean");
    else disabled = frontmatter.disabled;
  }
  const artifacts = frontmatter.artifacts === undefined ? undefined : artifactSettings(frontmatter.artifacts, issues);

  if (issues.length > 0 || name === undefined || description === undefined) {
    throw new ProfileValidationError(source.path, issues.length > 0 ? issues : ["name and description are required"]);
  }

  return {
    name,
    description,
    body: trimmedBody,
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(tools === undefined ? {} : { tools }),
    ...(preferredTools === undefined ? {} : { preferredTools }),
    ...(context === undefined ? {} : { context }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(artifacts === undefined ? {} : { artifacts }),
    source,
  };
}
