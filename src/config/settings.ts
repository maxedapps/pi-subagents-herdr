import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Harness } from "../contracts/harness.ts";
import type { Diagnostic } from "../contracts/result.ts";

export const SETTINGS_NAMESPACE = "herdr-subagents" as const;
export const SETTINGS_FILENAME = "settings.json" as const;

export interface HerdrSubagentsSettings {
  readonly concurrency: {
    readonly maxRunning: number;
    readonly maxWriters: number;
  };
  readonly defaultHarness: Harness;
  readonly profileDirectories: {
    readonly user: readonly string[];
    readonly project: readonly string[];
  };
  readonly widget: {
    readonly visibility: "auto" | "always" | "never";
  };
  readonly integrations: {
    readonly strictness: "strict" | "warn";
  };
  readonly security: {
    readonly allowedRoots: readonly string[];
    readonly allowBroadeningOverrides: boolean;
    readonly requireWriterWorktree: boolean;
  };
}

type SettingsPatch = {
  concurrency?: { maxRunning?: number; maxWriters?: number };
  defaultHarness?: Harness;
  profileDirectories?: { user?: string[]; project?: string[] };
  widget?: { visibility?: "auto" | "always" | "never" };
  integrations?: { strictness?: "strict" | "warn" };
  security?: {
    allowedRoots?: string[];
    allowBroadeningOverrides?: boolean;
    requireWriterWorktree?: boolean;
  };
};

export interface SettingsLocations {
  readonly user: string;
  readonly project?: string;
}

export interface LoadSettingsOptions {
  readonly agentDir: string;
  readonly projectConfigRoot?: string;
  readonly projectTrusted: boolean;
  readonly workspaceRoot: string;
}

export interface LoadedSettings {
  readonly settings: HerdrSubagentsSettings;
  readonly locations: SettingsLocations;
  readonly loaded: readonly ("user" | "project")[];
  readonly diagnostics: readonly Diagnostic[];
}

export class SettingsValidationError extends Error {
  readonly sourcePath: string;
  readonly issues: readonly string[];

  constructor(sourcePath: string, issues: readonly string[]) {
    super(`Invalid Herdr subagents settings in ${sourcePath}: ${issues.join("; ")}`);
    this.name = "SettingsValidationError";
    this.sourcePath = sourcePath;
    this.issues = issues;
  }
}

export function getSettingsLocations(agentDir: string, projectConfigRoot?: string): SettingsLocations {
  const user = join(agentDir, SETTINGS_NAMESPACE, SETTINGS_FILENAME);
  if (projectConfigRoot === undefined) return { user };
  return { user, project: join(projectConfigRoot, SETTINGS_NAMESPACE, SETTINGS_FILENAME) };
}

export function defaultSettings(workspaceRoot: string): HerdrSubagentsSettings {
  const root = resolve(workspaceRoot);
  if (root === parse(root).root) throw new Error("Workspace root must not be the filesystem root");
  return {
    concurrency: { maxRunning: 4, maxWriters: 1 },
    defaultHarness: "pi",
    profileDirectories: { user: [], project: [] },
    widget: { visibility: "auto" },
    integrations: { strictness: "strict" },
    security: {
      allowedRoots: [root],
      allowBroadeningOverrides: false,
      requireWriterWorktree: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  issues: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is unknown`);
  }
  return value;
}

function stringEnum<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
  issues: string[],
): T | undefined {
  if (typeof value !== "string" || !values.includes(value as T)) {
    issues.push(`${path} must be one of: ${values.join(", ")}`);
    return undefined;
  }
  return value as T;
}

function integer(value: unknown, path: string, min: number, max: number, issues: string[]): number | undefined {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    issues.push(`${path} must be an integer from ${min} to ${max}`);
    return undefined;
  }
  return value;
}

function boolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (typeof value !== "boolean") {
    issues.push(`${path} must be a boolean`);
    return undefined;
  }
  return value;
}

function paths(value: unknown, path: string, sourceDir: string, issues: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of paths`);
    return undefined;
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0 || item.includes("\0")) {
      issues.push(`${path}[${index}] must be a non-empty path without NUL bytes`);
      continue;
    }
    const absolute = isAbsolute(item) ? resolve(item) : resolve(sourceDir, item);
    if (absolute === parse(absolute).root) {
      issues.push(`${path}[${index}] must not grant a filesystem root`);
      continue;
    }
    if (seen.has(absolute)) {
      issues.push(`${path}[${index}] duplicates ${absolute}`);
      continue;
    }
    seen.add(absolute);
    output.push(absolute);
  }
  return output;
}

function parseSettings(value: unknown, sourcePath: string): SettingsPatch {
  const issues: string[] = [];
  const sourceDir = dirname(sourcePath);
  const root = objectAt(
    value,
    "settings",
    [
      "concurrency",
      "defaultHarness",
      "profileDirectories",
      "widget",
      "integrations",
      "security",
    ],
    issues,
  );
  if (root === undefined) throw new SettingsValidationError(sourcePath, issues);

  const patch: SettingsPatch = {};
  if (root.defaultHarness !== undefined) {
    const parsed = stringEnum(root.defaultHarness, "settings.defaultHarness", ["pi", "claude", "codex"], issues);
    if (parsed !== undefined) patch.defaultHarness = parsed;
  }

  if (root.concurrency !== undefined) {
    const obj = objectAt(root.concurrency, "settings.concurrency", ["maxRunning", "maxWriters"], issues);
    if (obj !== undefined) {
      const next: { maxRunning?: number; maxWriters?: number } = {};
      if (obj.maxRunning !== undefined) {
        const parsed = integer(obj.maxRunning, "settings.concurrency.maxRunning", 1, 64, issues);
        if (parsed !== undefined) next.maxRunning = parsed;
      }
      if (obj.maxWriters !== undefined) {
        const parsed = integer(obj.maxWriters, "settings.concurrency.maxWriters", 1, 16, issues);
        if (parsed !== undefined) next.maxWriters = parsed;
      }
      patch.concurrency = next;
    }
  }

  if (root.profileDirectories !== undefined) {
    const obj = objectAt(root.profileDirectories, "settings.profileDirectories", ["user", "project"], issues);
    if (obj !== undefined) {
      const next: { user?: string[]; project?: string[] } = {};
      if (obj.user !== undefined) {
        const parsed = paths(obj.user, "settings.profileDirectories.user", sourceDir, issues);
        if (parsed !== undefined) next.user = parsed;
      }
      if (obj.project !== undefined) {
        const parsed = paths(obj.project, "settings.profileDirectories.project", sourceDir, issues);
        if (parsed !== undefined) next.project = parsed;
      }
      patch.profileDirectories = next;
    }
  }

  if (root.widget !== undefined) {
    const obj = objectAt(root.widget, "settings.widget", ["visibility"], issues);
    if (obj?.visibility !== undefined) {
      const parsed = stringEnum(obj.visibility, "settings.widget.visibility", ["auto", "always", "never"], issues);
      if (parsed !== undefined) patch.widget = { visibility: parsed };
    }
  }

  if (root.integrations !== undefined) {
    const obj = objectAt(root.integrations, "settings.integrations", ["strictness"], issues);
    if (obj?.strictness !== undefined) {
      const parsed = stringEnum(obj.strictness, "settings.integrations.strictness", ["strict", "warn"], issues);
      if (parsed !== undefined) patch.integrations = { strictness: parsed };
    }
  }

  if (root.security !== undefined) {
    const obj = objectAt(
      root.security,
      "settings.security",
      ["allowedRoots", "allowBroadeningOverrides", "requireWriterWorktree"],
      issues,
    );
    if (obj !== undefined) {
      const next: SettingsPatch["security"] = {};
      if (obj.allowedRoots !== undefined) {
        const parsed = paths(obj.allowedRoots, "settings.security.allowedRoots", sourceDir, issues);
        if (parsed !== undefined) next.allowedRoots = parsed;
      }
      if (obj.allowBroadeningOverrides !== undefined) {
        const parsed = boolean(obj.allowBroadeningOverrides, "settings.security.allowBroadeningOverrides", issues);
        if (parsed !== undefined) next.allowBroadeningOverrides = parsed;
      }
      if (obj.requireWriterWorktree !== undefined) {
        const parsed = boolean(obj.requireWriterWorktree, "settings.security.requireWriterWorktree", issues);
        if (parsed !== undefined) next.requireWriterWorktree = parsed;
      }
      patch.security = next;
    }
  }

  if (issues.length > 0) throw new SettingsValidationError(sourcePath, issues);
  return patch;
}

function mergeSettings(base: HerdrSubagentsSettings, patch: SettingsPatch): HerdrSubagentsSettings {
  const merged: HerdrSubagentsSettings = {
    concurrency: { ...base.concurrency, ...patch.concurrency },
    defaultHarness: patch.defaultHarness ?? base.defaultHarness,
    profileDirectories: { ...base.profileDirectories, ...patch.profileDirectories },
    widget: { ...base.widget, ...patch.widget },
    integrations: { ...base.integrations, ...patch.integrations },
    security: { ...base.security, ...patch.security },
  };
  if (merged.concurrency.maxWriters > merged.concurrency.maxRunning) {
    throw new Error("concurrency.maxWriters cannot exceed concurrency.maxRunning after settings merge");
  }
  if (merged.security.allowedRoots.length === 0) {
    throw new Error("security.allowedRoots must retain at least one trusted root");
  }
  return merged;
}

async function readPatch(path: string): Promise<SettingsPatch | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new SettingsValidationError(path, [`JSON parse failed: ${message}`]);
  }
  return parseSettings(value, path);
}

export function loadSettingsForContext(context: ExtensionContext): Promise<LoadedSettings> {
  return loadSettings({
    agentDir: getAgentDir(),
    projectConfigRoot: join(context.cwd, CONFIG_DIR_NAME),
    projectTrusted: context.isProjectTrusted(),
    workspaceRoot: context.cwd,
  });
}

export async function loadSettings(options: LoadSettingsOptions): Promise<LoadedSettings> {
  const locations = getSettingsLocations(options.agentDir, options.projectConfigRoot);
  const loaded: ("user" | "project")[] = [];
  const diagnostics: Diagnostic[] = [];
  let settings = defaultSettings(options.workspaceRoot);

  const user = await readPatch(locations.user);
  if (user !== undefined) {
    settings = mergeSettings(settings, user);
    loaded.push("user");
  }

  if (locations.project !== undefined) {
    if (!options.projectTrusted) {
      diagnostics.push({
        code: "project-settings-untrusted",
        message: `Ignored project Herdr subagents settings because the project is not trusted: ${locations.project}`,
        path: locations.project,
        severity: "warning",
      });
    } else {
      const project = await readPatch(locations.project);
      if (project !== undefined) {
        settings = mergeSettings(settings, project);
        loaded.push("project");
      }
    }
  }

  return { settings, locations, loaded, diagnostics };
}
