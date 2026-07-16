import type { Diagnostic } from "../contracts/result.ts";
import type { AgentProfile } from "../contracts/profile.ts";

export interface ChildExposedCapabilities {
  /** Tool names in the child's effective launch allowlist/resource set. */
  readonly tools: readonly string[];
  /** Skill names in the child's effective explicit skill resource set. */
  readonly skills: readonly string[];
  /**
   * Exposed tools that trusted adapter/capability review classifies as able to
   * consult external sources. Profile-authored preferred names never populate
   * this set by themselves.
   */
  readonly reviewedExternalResearchTools: readonly string[];
}

export interface SoftCapabilityResolution {
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly missingTools: readonly string[];
  readonly missingSkills: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly research: {
    readonly assignment: boolean;
    readonly available: boolean;
    readonly state: "not-applicable" | "available" | "blocked";
    readonly canClaimExternalResearch: boolean;
  };
}

export interface ResolveSoftCapabilitiesOptions {
  readonly researchAssignment?: boolean;
}

/**
 * Resolve preferences only against resources the child launch will actually
 * expose. Parent tools and globally installed-but-hidden resources are not
 * inputs to this function by design.
 */
export function resolveSoftCapabilities(
  profile: AgentProfile,
  child: ChildExposedCapabilities,
  options: ResolveSoftCapabilitiesOptions = {},
): SoftCapabilityResolution {
  const childTools = new Set(child.tools);
  const childSkills = new Set(child.skills);
  const preferredTools = profile.preferredTools ?? [];
  const preferredSkills = profile.preferredSkills ?? [];
  const tools = preferredTools.filter((name) => childTools.has(name));
  const skills = preferredSkills.filter((name) => childSkills.has(name));
  const missingTools = preferredTools.filter((name) => !childTools.has(name));
  const missingSkills = preferredSkills.filter((name) => !childSkills.has(name));
  const reviewedExternalResearchTools = new Set(
    child.reviewedExternalResearchTools.filter((name) => childTools.has(name)),
  );
  const availableExternalResearchTools = tools.filter((name) => reviewedExternalResearchTools.has(name));
  const diagnostics: Diagnostic[] = [
    ...missingTools.map((name): Diagnostic => ({
      code: "profile-preferred-tool-unavailable",
      message: `Preferred tool is not exposed to child ${profile.name}: ${name}`,
      path: profile.source.path,
      severity: "warning",
    })),
    ...missingSkills.map((name): Diagnostic => ({
      code: "profile-preferred-skill-unavailable",
      message: `Preferred skill is not exposed to child ${profile.name}: ${name}`,
      path: profile.source.path,
      severity: "warning",
    })),
  ];
  const assignment = options.researchAssignment ?? profile.name === "researcher";
  const available = !assignment || availableExternalResearchTools.length > 0;
  if (assignment && !available) {
    diagnostics.push({
      code: "external-research-unavailable",
      message: "No explicitly reviewed external research tool is both preferred and exposed to the child; research is blocked and memory-only output must not be labelled researched or source-checked",
      path: profile.source.path,
      severity: "error",
    });
  }
  return {
    tools,
    skills,
    missingTools,
    missingSkills,
    diagnostics,
    research: {
      assignment,
      available,
      state: !assignment ? "not-applicable" : available ? "available" : "blocked",
      canClaimExternalResearch: assignment && available,
    },
  };
}
