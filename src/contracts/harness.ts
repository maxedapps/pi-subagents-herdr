export const HARNESSES = ["pi", "claude", "codex", "grok"] as const;
export type Harness = typeof HARNESSES[number];
export function isHarness(value: unknown): value is Harness { return typeof value === "string" && (HARNESSES as readonly string[]).includes(value); }

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Capability = "read" | "mutation" | "network";

export interface ToolGrant {
  readonly name: string;
  readonly capabilities: readonly Capability[];
}

export interface PermissionPolicy {
  readonly mutation: boolean;
  readonly network: boolean;
}

export type FilesystemBoundary = "tool-policy" | "os-sandbox" | "native-sandbox";
export type NativeSessionIdentityCapability = "available" | "integrated-policy-only" | "screen-only";
export type HarnessIntegrationPolicy = "integrated" | "safe-mode";

export interface HarnessCapabilities {
  readonly harness: Harness;
  readonly modelSelection: boolean;
  readonly thinkingSelection: boolean;
  readonly explicitToolPolicy: boolean;
  readonly filesystemBoundary: FilesystemBoundary;
  readonly nativeApprovalPolicy: boolean;
  readonly nativeSessionIdentity: NativeSessionIdentityCapability;
  readonly notes: readonly string[];
}

export interface EffectiveHarnessCapabilities extends Omit<HarnessCapabilities, "nativeSessionIdentity"> {
  readonly integrationPolicy: HarnessIntegrationPolicy;
  readonly nativeSessionIdentity: boolean;
}

export interface LaunchPolicy {
  readonly harness: Harness;
  readonly model?: string;
  readonly allowedModels: readonly string[];
  readonly thinking: ThinkingLevel;
  readonly cwd: string;
  readonly trustedRoots: readonly string[];
  readonly tools: readonly ToolGrant[];
  readonly permissions: PermissionPolicy;
  readonly requireWorktree: boolean;
}

export interface LaunchOverrides {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly cwd?: string;
  readonly tools?: readonly string[];
  readonly permissions?: Partial<PermissionPolicy>;
  readonly requireWorktree?: boolean;
}

export interface OverrideResolutionContext {
  readonly toolCatalog: Readonly<Record<string, ToolGrant>>;
  readonly trustedBroadeningEnabled: boolean;
  readonly humanConfirmed: boolean;
  readonly confirmedAdditionalRoots?: readonly string[];
}

export interface EffectiveLaunchPolicy extends LaunchPolicy {
  readonly broadeningReasons: readonly string[];
}

export interface LaunchAdjustment {
  readonly field: "thinking";
  readonly requested: ThinkingLevel;
  readonly effective: ThinkingLevel;
  readonly reason: "clamped_to_profile_policy";
}

export type OverrideResolution =
  | { readonly accepted: true; readonly policy: EffectiveLaunchPolicy; readonly adjustments: readonly LaunchAdjustment[] }
  | { readonly accepted: false; readonly reasons: readonly string[] };

/** Result of the mandatory filesystem check immediately before process/resource launch. */
export type LaunchFilesystemRevalidation =
  | { readonly valid: true; readonly cwd: string; readonly trustedRoots: readonly string[] }
  | { readonly valid: false; readonly reasons: readonly string[] };
