import { realpathSync, statSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import type {
  EffectiveHarnessCapabilities,
  EffectiveLaunchPolicy,
  Harness,
  HarnessCapabilities,
  HarnessIntegrationPolicy,
  LaunchFilesystemRevalidation,
  LaunchOverrides,
  LaunchPolicy,
  OverrideResolution,
  OverrideResolutionContext,
  ThinkingLevel,
  ToolGrant,
} from "../contracts/harness.ts";

export const HARNESS_CAPABILITIES: Readonly<Record<Harness, HarnessCapabilities>> = Object.freeze({
  pi: Object.freeze({
    harness: "pi",
    modelSelection: true,
    thinkingSelection: true,
    explicitToolPolicy: true,
    filesystemBoundary: "tool-policy",
    nativeApprovalPolicy: false,
    nativeSessionIdentity: "available",
    notes: Object.freeze([
      "Tool allowlists reduce exposed operations but are not an operating-system filesystem sandbox.",
    ]),
  }),
  claude: Object.freeze({
    harness: "claude",
    modelSelection: true,
    thinkingSelection: true,
    explicitToolPolicy: true,
    filesystemBoundary: "tool-policy",
    nativeApprovalPolicy: true,
    nativeSessionIdentity: "integrated-policy-only",
    notes: Object.freeze([
      "Tool and permission modes are not an operating-system filesystem sandbox.",
      "Strict safe mode disables the separate Herdr native-session integration.",
    ]),
  }),
  codex: Object.freeze({
    harness: "codex",
    modelSelection: true,
    thinkingSelection: true,
    explicitToolPolicy: false,
    filesystemBoundary: "os-sandbox",
    nativeApprovalPolicy: true,
    nativeSessionIdentity: "available",
    notes: Object.freeze(["Filesystem confinement is provided by Codex sandbox policy, not by tool names alone."]),
  }),
});

const THINKING_ORDER: Readonly<Record<ThinkingLevel, number>> = Object.freeze({
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
});

export function resolveHarnessCapabilities(
  harness: Harness,
  integrationPolicy: HarnessIntegrationPolicy = "integrated",
): EffectiveHarnessCapabilities {
  if (integrationPolicy === "safe-mode" && harness !== "claude") {
    throw new Error(`Safe mode is not a supported integration policy for ${harness}`);
  }
  const capabilities = HARNESS_CAPABILITIES[harness];
  return {
    ...capabilities,
    integrationPolicy,
    nativeSessionIdentity:
      capabilities.nativeSessionIdentity === "available" || integrationPolicy === "integrated",
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    throw new Error(`${label} must be an existing directory: ${absolute}`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(canonical).isDirectory();
  } catch {
    // Preserve one fail-closed diagnostic for paths that changed during validation.
  }
  if (!isDirectory) throw new Error(`${label} must be an existing directory: ${absolute}`);
  return canonical;
}

function safeRoots(roots: readonly string[], label: string): string[] {
  return roots.map((root) => {
    const canonical = canonicalDirectory(root, label);
    if (canonical === parse(canonical).root) throw new Error("A filesystem root cannot be a trusted root");
    return canonical;
  });
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Re-resolve canonical paths immediately before any launch resource is
 * created. Resolution-time validation is not a launch authorization because
 * directories and symlinks can change between policy resolution and spawn.
 */
export function revalidateLaunchFilesystemBoundary(
  policy: Pick<EffectiveLaunchPolicy, "cwd" | "trustedRoots">,
): LaunchFilesystemRevalidation {
  try {
    const cwd = canonicalDirectory(policy.cwd, "Launch cwd");
    const trustedRoots = safeRoots(policy.trustedRoots, "Launch trusted root");
    if (cwd !== policy.cwd || trustedRoots.some((root, index) => root !== policy.trustedRoots[index])) {
      return { valid: false, reasons: ["Launch filesystem paths changed after policy resolution"] };
    }
    if (!trustedRoots.some((root) => isWithin(root, cwd))) {
      return { valid: false, reasons: [`Launch cwd is outside canonical trusted roots: ${cwd}`] };
    }
    return { valid: true, cwd, trustedRoots };
  } catch (error) {
    return {
      valid: false,
      reasons: [error instanceof Error ? error.message : "Launch filesystem revalidation failed"],
    };
  }
}

function cloneTool(tool: ToolGrant): ToolGrant {
  return { name: tool.name, capabilities: [...tool.capabilities] };
}

function validatePolicy(policy: LaunchPolicy): readonly string[] {
  const reasons: string[] = [];
  const names = new Set<string>();
  for (const tool of policy.tools) {
    if (names.has(tool.name)) reasons.push(`Duplicate baseline tool: ${tool.name}`);
    names.add(tool.name);
    if (tool.capabilities.includes("mutation") && !policy.permissions.mutation) {
      reasons.push(`Baseline mutation tool ${tool.name} contradicts read-only permissions`);
    }
    if (tool.capabilities.includes("network") && !policy.permissions.network) {
      reasons.push(`Baseline network tool ${tool.name} contradicts network-disabled permissions`);
    }
  }
  return reasons;
}

export function resolveMonotonicOverrides(
  baseline: LaunchPolicy,
  overrides: LaunchOverrides,
  context: OverrideResolutionContext,
): OverrideResolution {
  const invalidBaseline = validatePolicy(baseline);
  if (invalidBaseline.length > 0) return { accepted: false, reasons: invalidBaseline };

  let roots: string[];
  let additionalRoots: string[];
  let baselineCwd: string;
  try {
    roots = safeRoots(baseline.trustedRoots, "Trusted root");
    additionalRoots = safeRoots(context.confirmedAdditionalRoots ?? [], "Confirmed additional root");
    baselineCwd = canonicalDirectory(baseline.cwd, "Baseline cwd");
  } catch (error) {
    return { accepted: false, reasons: [error instanceof Error ? error.message : "Invalid launch directory"] };
  }
  if (!roots.some((root) => isWithin(root, baselineCwd))) {
    return { accepted: false, reasons: [`Baseline cwd is outside configured trusted roots: ${baselineCwd}`] };
  }

  const broadeningReasons: string[] = [];
  const hardRejections: string[] = [];
  const baselineTools = new Map(baseline.tools.map((tool) => [tool.name, tool] as const));

  let tools = baseline.tools.map(cloneTool);
  if (overrides.tools !== undefined) {
    const requested = new Set(overrides.tools);
    if (requested.size !== overrides.tools.length) hardRejections.push("Requested tools contain duplicates");
    tools = [];
    for (const name of requested) {
      const existing = baselineTools.get(name);
      if (existing !== undefined) {
        tools.push(cloneTool(existing));
        continue;
      }
      const catalogTool = context.toolCatalog[name];
      if (catalogTool === undefined) {
        hardRejections.push(`Unknown tool cannot be granted: ${name}`);
        continue;
      }
      broadeningReasons.push(`adds tool ${name}`);
      tools.push(cloneTool(catalogTool));
    }
  }

  const permissions = {
    mutation: overrides.permissions?.mutation ?? baseline.permissions.mutation,
    network: overrides.permissions?.network ?? baseline.permissions.network,
  };
  if (permissions.mutation && !baseline.permissions.mutation) broadeningReasons.push("enables mutation capability");
  if (permissions.network && !baseline.permissions.network) broadeningReasons.push("enables network capability");

  for (const tool of tools) {
    if (tool.capabilities.includes("mutation") && !permissions.mutation) {
      hardRejections.push(`Mutation-capable tool ${tool.name} contradicts effective permissions`);
    }
    if (tool.capabilities.includes("network") && !permissions.network) {
      hardRejections.push(`Network-capable tool ${tool.name} contradicts effective permissions`);
    }
  }

  const thinking = overrides.thinking ?? baseline.thinking;
  if (THINKING_ORDER[thinking] > THINKING_ORDER[baseline.thinking]) {
    broadeningReasons.push(`raises thinking from ${baseline.thinking} to ${thinking}`);
  }

  const model = overrides.model ?? baseline.model;
  if (overrides.model !== undefined && overrides.model !== baseline.model) {
    if (!baseline.allowedModels.includes(overrides.model)) broadeningReasons.push(`selects non-allowlisted model ${overrides.model}`);
  }

  let cwd: string;
  try {
    cwd = canonicalDirectory(overrides.cwd ?? baseline.cwd, "Effective cwd");
  } catch (error) {
    return { accepted: false, reasons: [error instanceof Error ? error.message : "Invalid effective cwd"] };
  }
  if (!isWithin(baselineCwd, cwd)) broadeningReasons.push(`expands cwd outside baseline ${baselineCwd}`);
  const insideTrustedRoot = roots.some((root) => isWithin(root, cwd));
  const insideConfirmedRoot = additionalRoots.some((root) => isWithin(root, cwd));
  const effectiveRoots = insideTrustedRoot ? roots : uniquePaths([...roots, ...additionalRoots]);
  if (!insideTrustedRoot && !insideConfirmedRoot) {
    hardRejections.push(`cwd is outside configured trusted roots: ${cwd}`);
  } else if (!insideTrustedRoot) {
    broadeningReasons.push(`uses interactively confirmed additional root for cwd ${cwd}`);
  }

  const requireWorktree = overrides.requireWorktree ?? baseline.requireWorktree;
  if (baseline.requireWorktree && !requireWorktree) broadeningReasons.push("weakens required worktree isolation");

  if (hardRejections.length > 0) return { accepted: false, reasons: hardRejections };
  if (broadeningReasons.length > 0 && !(context.trustedBroadeningEnabled && context.humanConfirmed)) {
    return {
      accepted: false,
      reasons: [
        ...broadeningReasons,
        "Broadening requires a trusted namespaced setting and interactive human confirmation",
      ],
    };
  }

  const policy: EffectiveLaunchPolicy = {
    harness: baseline.harness,
    allowedModels: [...baseline.allowedModels],
    thinking,
    cwd,
    trustedRoots: effectiveRoots,
    tools,
    permissions,
    requireWorktree,
    broadeningReasons,
  };
  if (model !== undefined) return { accepted: true, policy: { ...policy, model } };
  return { accepted: true, policy };
}
