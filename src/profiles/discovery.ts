import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentProfile, ProfileSource, ProfileSourceNamespace, ProfileSourceScope } from "../contracts/profile.ts";
import type { Diagnostic } from "../contracts/result.ts";
import { PACKAGE_ASSETS } from "../package-paths.ts";
import { parseProfile } from "./parser.ts";
import { ProfileValidationError } from "./schema.ts";

export const PROFILE_PRECEDENCE = Object.freeze({
  bundled: 0,
  sharedUser: 1,
  namespacedUser: 2,
  sharedProject: 3,
  namespacedProject: 4,
} as const);

export interface ProfileDiscoveryOptions {
  readonly agentDir: string;
  readonly projectConfigRoot: string;
  readonly projectTrusted: boolean;
  readonly bundledDirectory?: string;
  /** Trusted settings directories; they share namespaced-user priority. */
  readonly additionalUserDirectories?: readonly string[];
  /** Trusted settings directories; ignored unless projectTrusted is true. */
  readonly additionalProjectDirectories?: readonly string[];
}

export interface ProfileShadow {
  readonly name: string;
  readonly winner: ProfileSource;
  readonly shadowed: ProfileSource;
  readonly disabledByWinner: boolean;
}

export interface ProfileDiscoveryResult {
  /** Enabled winning profiles, sorted by case-sensitive runtime name. */
  readonly profiles: readonly AgentProfile[];
  /** All winning profiles, including disabled definitions that hide weaker ones. */
  readonly winners: readonly AgentProfile[];
  readonly shadows: readonly ProfileShadow[];
  readonly diagnostics: readonly Diagnostic[];
  readonly searchedDirectories: readonly string[];
}

export class ProfileDiscoveryError extends Error {
  readonly issues: readonly string[];
  readonly diagnostics: readonly Diagnostic[];

  constructor(issues: readonly string[], diagnostics: readonly Diagnostic[] = []) {
    super(`Profile discovery failed:\n${issues.join("\n")}`);
    this.name = "ProfileDiscoveryError";
    this.issues = issues;
    this.diagnostics = diagnostics;
  }
}

interface DiscoveryRoot {
  readonly directory: string;
  readonly scope: ProfileSourceScope;
  readonly namespace: ProfileSourceNamespace;
  readonly priority: number;
}

function roots(options: ProfileDiscoveryOptions): DiscoveryRoot[] {
  const output: DiscoveryRoot[] = [
    {
      directory: options.bundledDirectory ?? PACKAGE_ASSETS.agents,
      scope: "bundled",
      namespace: "shared",
      priority: PROFILE_PRECEDENCE.bundled,
    },
    {
      directory: join(options.agentDir, "agents"),
      scope: "user",
      namespace: "shared",
      priority: PROFILE_PRECEDENCE.sharedUser,
    },
    {
      directory: join(options.agentDir, "herdr-subagents", "agents"),
      scope: "user",
      namespace: "namespaced",
      priority: PROFILE_PRECEDENCE.namespacedUser,
    },
  ];
  for (const directory of options.additionalUserDirectories ?? []) {
    output.push({ directory, scope: "user", namespace: "namespaced", priority: PROFILE_PRECEDENCE.namespacedUser });
  }
  if (options.projectTrusted) {
    output.push(
      {
        directory: join(options.projectConfigRoot, "agents"),
        scope: "project",
        namespace: "shared",
        priority: PROFILE_PRECEDENCE.sharedProject,
      },
      {
        directory: join(options.projectConfigRoot, "herdr-subagents", "agents"),
        scope: "project",
        namespace: "namespaced",
        priority: PROFILE_PRECEDENCE.namespacedProject,
      },
    );
    for (const directory of options.additionalProjectDirectories ?? []) {
      output.push({ directory, scope: "project", namespace: "namespaced", priority: PROFILE_PRECEDENCE.namespacedProject });
    }
  }
  return output;
}

async function markdownFiles(root: DiscoveryRoot, diagnostics: Diagnostic[]): Promise<string[]> {
  const requested = resolve(root.directory);
  let rootInfo;
  try {
    rootInfo = await lstat(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (rootInfo.isSymbolicLink()) {
    diagnostics.push({
      code: "profile-root-symlink-ignored",
      message: `Ignored symlinked profile root to avoid discovery outside its declared trust root: ${requested}`,
      path: requested,
      severity: "warning",
    });
    return [];
  }
  if (!rootInfo.isDirectory()) {
    throw new ProfileDiscoveryError([`Profile root is not a directory: ${requested}`], diagnostics);
  }
  const canonicalRoot = await realpath(requested);
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          code: "profile-symlink-ignored",
          message: `Ignored symlink during recursive profile discovery: ${path}`,
          path,
          severity: "warning",
        });
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
        output.push(path);
      }
    }
  };
  await visit(canonicalRoot);
  return output;
}

export function discoverProfilesForContext(
  context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  directories: {
    readonly user?: readonly string[];
    readonly project?: readonly string[];
  } = {},
): Promise<ProfileDiscoveryResult> {
  return discoverProfiles({
    agentDir: getAgentDir(),
    projectConfigRoot: join(context.cwd, CONFIG_DIR_NAME),
    projectTrusted: context.isProjectTrusted(),
    ...(directories.user === undefined ? {} : { additionalUserDirectories: directories.user }),
    ...(directories.project === undefined ? {} : { additionalProjectDirectories: directories.project }),
  });
}

export async function discoverProfiles(options: ProfileDiscoveryOptions): Promise<ProfileDiscoveryResult> {
  const diagnostics: Diagnostic[] = [];
  const configuredRoots = roots(options);
  if (!options.projectTrusted) {
    const ignored = [
      join(options.projectConfigRoot, "agents"),
      join(options.projectConfigRoot, "herdr-subagents", "agents"),
      ...(options.additionalProjectDirectories ?? []),
    ];
    diagnostics.push(...ignored.map((path): Diagnostic => ({
      code: "project-profiles-untrusted",
      message: `Ignored project profile directory because the project is not trusted: ${resolve(path)}`,
      path: resolve(path),
      severity: "warning",
    })));
  }

  const candidates: AgentProfile[] = [];
  const validationIssues: string[] = [];
  for (const root of configuredRoots) {
    let files: string[];
    try {
      files = await markdownFiles(root, diagnostics);
    } catch (error) {
      if (error instanceof ProfileDiscoveryError) throw error;
      throw new ProfileDiscoveryError([
        `Unable to recursively read profile root ${resolve(root.directory)}: ${error instanceof Error ? error.message : String(error)}`,
      ], diagnostics);
    }
    for (const path of files) {
      const source: ProfileSource = {
        path,
        scope: root.scope,
        namespace: root.namespace,
        priority: root.priority,
      };
      try {
        candidates.push(parseProfile(await readFile(path, "utf8"), source));
      } catch (error) {
        if (error instanceof ProfileValidationError) validationIssues.push(error.message);
        else validationIssues.push(`Unable to read profile ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (validationIssues.length > 0) throw new ProfileDiscoveryError(validationIssues, diagnostics);

  const byPriorityAndName = new Map<string, AgentProfile[]>();
  for (const profile of candidates) {
    const key = `${profile.source.priority}\0${profile.name}`;
    const same = byPriorityAndName.get(key) ?? [];
    same.push(profile);
    byPriorityAndName.set(key, same);
  }
  const collisionIssues: string[] = [];
  for (const same of byPriorityAndName.values()) {
    if (same.length < 2) continue;
    const paths = same.map((profile) => profile.source.path).sort();
    collisionIssues.push(
      `Same-priority duplicate runtime profile name "${same[0]!.name}" at priority ${same[0]!.source.priority}: ${paths.join(", ")}`,
    );
  }
  if (collisionIssues.length > 0) throw new ProfileDiscoveryError(collisionIssues, diagnostics);

  const grouped = new Map<string, AgentProfile[]>();
  for (const profile of candidates) {
    const same = grouped.get(profile.name) ?? [];
    same.push(profile);
    grouped.set(profile.name, same);
  }
  const winners: AgentProfile[] = [];
  const shadows: ProfileShadow[] = [];
  for (const [name, same] of grouped) {
    same.sort((left, right) => left.source.priority - right.source.priority);
    const winner = same.at(-1)!;
    winners.push(winner);
    for (const shadowed of same.slice(0, -1)) {
      const shadow: ProfileShadow = {
        name,
        winner: winner.source,
        shadowed: shadowed.source,
        disabledByWinner: winner.disabled === true,
      };
      shadows.push(shadow);
      diagnostics.push({
        code: winner.disabled === true ? "profile-disabled-shadow" : "profile-shadowed",
        message: winner.disabled === true
          ? `Disabled profile ${winner.source.path} hides weaker ${shadowed.source.path} for runtime name ${name}`
          : `Profile ${winner.source.path} shadows ${shadowed.source.path} for runtime name ${name}`,
        path: shadowed.source.path,
        severity: "info",
      });
    }
    if (winner.disabled === true) {
      diagnostics.push({
        code: "profile-disabled",
        message: `Profile ${name} is disabled by ${winner.source.path}`,
        path: winner.source.path,
        severity: "info",
      });
    }
  }
  winners.sort((left, right) => left.name.localeCompare(right.name, "en"));
  shadows.sort((left, right) => left.name.localeCompare(right.name, "en") || left.shadowed.path.localeCompare(right.shadowed.path, "en"));
  return {
    profiles: winners.filter((profile) => profile.disabled !== true),
    winners,
    shadows,
    diagnostics,
    searchedDirectories: configuredRoots.map((root) => resolve(root.directory)),
  };
}
