import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, parse, resolve } from "node:path";
import type {
  EffectiveHarnessCapabilities,
  EffectiveLaunchPolicy,
  Harness,
  HarnessIntegrationPolicy,
  ThinkingLevel,
} from "../contracts/harness.ts";
import type { AgentProfile } from "../contracts/profile.ts";

export type ToolVisibilityEnforcement = "allowlist" | "sandbox-only";
export type ApprovalBehavior = "none" | "native";
export type ReadinessSignal = "herdr-semantic-state";
export type ExitAction =
  | { readonly kind: "keys"; readonly keys: readonly string[] }
  | { readonly kind: "input"; readonly text: string; readonly keys: readonly string[] };

export interface AdapterCapabilities {
  readonly harness: Harness;
  readonly executable: string;
  readonly toolVisibility: ToolVisibilityEnforcement;
  readonly filesystemConfinement: "none" | "codex-os-sandbox";
  readonly approvalBehavior: ApprovalBehavior;
  readonly modelSelection: true;
  readonly supportedThinking: readonly ThinkingLevel[];
  readonly readiness: ReadinessSignal;
  readonly interruptKeys: readonly string[];
  readonly gracefulExit: ExitAction;
  readonly nativeSessionIdentity: "available" | "integrated-only";
  readonly customizationPolicy: string;
  readonly limitations: readonly string[];
}

export interface ChildMetadata {
  readonly runId: string;
  readonly runNonce: string;
  readonly profileName: string;
  readonly parentSessionId: string;
  readonly parentSessionPath?: string;
  /** Pi-only private result-exchange directory for the child bridge. */
  readonly resultExchangeDirectory?: string;
}

export interface LaunchContext {
  readonly policy: EffectiveLaunchPolicy;
  readonly profile: AgentProfile;
  readonly executable?: string;
  readonly sessionId: string;
  readonly sessionName: string;
  /** Pi-only private session directory. Other harnesses must not create one. */
  readonly sessionDirectory?: string;
  readonly systemPromptPath: string;
  readonly integrationPolicy?: HarnessIntegrationPolicy;
  /** Additional Codex write roots already authorized by monotonic policy. */
  readonly writableRoots?: readonly string[];
  readonly metadata: ChildMetadata;
}

export interface AdapterCheckInput extends LaunchContext {
  readonly executable: string;
}

export interface CapabilityReport {
  readonly ok: boolean;
  readonly capabilities: AdapterCapabilities;
  readonly executable: string;
  readonly diagnostics: readonly string[];
}

export interface HarnessLaunch {
  /** Full Herdr argv, including argv[0]. Never contains the delegated task. */
  readonly argv: readonly string[];
  /** Explicit child metadata/guards. Herdr supplies its own topology environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly capabilities: AdapterCapabilities;
}

export interface HarnessAdapter {
  readonly kind: Harness;
  readonly capabilities: AdapterCapabilities;
  check(input: AdapterCheckInput): Promise<CapabilityReport>;
  buildLaunch(input: AdapterCheckInput): Promise<HarnessLaunch>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DANGEROUS_ARGUMENTS = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "--bg",
  "--background",
  "--worktree",
  "--tmux",
]);

export class HarnessConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessConfigurationError";
  }
}

export function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value.startsWith("-")) {
    throw new HarnessConfigurationError(`${label} is not a safe CLI identifier`);
  }
}

export function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME.test(value) || value.startsWith("-")) {
    throw new HarnessConfigurationError(`${label} is not a safe runtime name`);
  }
}

export function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new HarnessConfigurationError(`${label} must be a UUID`);
}

export function rejectDangerousArguments(values: readonly string[], label = "Harness arguments"): void {
  for (const value of values) {
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new HarnessConfigurationError(`${label} contain a control character`);
    }
    const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (DANGEROUS_ARGUMENTS.has(option)) {
      throw new HarnessConfigurationError(`${label} contain prohibited option ${option}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = candidate.slice(root.length);
  return candidate === root || (candidate.startsWith(root) && (root.endsWith("/") || relative.startsWith("/")));
}

export async function canonicalExistingDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new HarnessConfigurationError(`${label} must be absolute`);
  const canonical = await realpath(resolve(path)).catch(() => undefined);
  if (!canonical || canonical === parse(canonical).root) {
    throw new HarnessConfigurationError(`${label} must be an existing non-root directory`);
  }
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnessConfigurationError(`${label} must be a real directory`);
  return canonical;
}

export async function assertPrivateSystemPrompt(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new HarnessConfigurationError("System prompt path must be absolute");
  const canonical = await realpath(path).catch(() => undefined);
  if (!canonical) throw new HarnessConfigurationError(`System prompt file does not exist: ${path}`);
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessConfigurationError("System prompt path must be a regular file");
  if ((info.mode & 0o077) !== 0) throw new HarnessConfigurationError("System prompt file must not be group/world accessible");
  return canonical;
}

export async function assertPrivateSessionDirectory(path: string): Promise<string> {
  const canonical = await canonicalExistingDirectory(path, "Session directory");
  const info = await lstat(canonical);
  if ((info.mode & 0o077) !== 0) throw new HarnessConfigurationError("Session directory must not be group/world accessible");
  return canonical;
}

export async function validateResolvedExecutable(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new HarnessConfigurationError("Resolved executable path must be absolute");
  await access(path, constants.X_OK).catch(() => { throw new HarnessConfigurationError(`Executable is no longer executable: ${path}`); });
  const canonical = await realpath(path).catch(() => undefined);
  if (!canonical || canonical !== path) throw new HarnessConfigurationError(`Executable identity changed after discovery: ${path}`);
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessConfigurationError("Executable must be a regular file");
  return canonical;
}

export async function resolveExecutable(name: string, configured: string | undefined, pathValue = process.env.PATH): Promise<string> {
  const requested = configured ?? name;
  rejectDangerousArguments([requested], "Executable");
  const candidates = isAbsolute(requested)
    ? [requested]
    : (pathValue ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, requested));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      if (info.isFile() && !info.isSymbolicLink()) return canonical;
    } catch {
      // Continue deterministic PATH search.
    }
  }
  throw new HarnessConfigurationError(`Executable ${requested} was not found as an executable file`);
}

export function assertLaunchHarness(input: LaunchContext, expected: Harness): void {
  if (input.policy.harness !== expected || input.profile.harness !== undefined && input.profile.harness !== expected) {
    throw new HarnessConfigurationError(`No cross-harness fallback: expected ${expected}, received ${input.policy.harness}`);
  }
  assertSafeName(input.sessionName, "Session name");
  assertUuid(input.sessionId, "Session id");
  assertSafeName(input.metadata.runId, "Run id");
  assertSafeName(input.metadata.runNonce, "Run nonce");
  assertSafeName(input.metadata.profileName, "Profile name");
  assertSafeIdentifier(input.metadata.parentSessionId, "Parent session id");
  if (input.policy.model !== undefined) assertSafeIdentifier(input.policy.model, "Model");
  for (const tool of input.policy.tools) {
    assertSafeIdentifier(tool.name, "Tool name");
    if (tool.name.toLowerCase().includes("subagent") || tool.name.toLowerCase().includes("delegate")) {
      throw new HarnessConfigurationError(`Recursive orchestration tool is prohibited in children: ${tool.name}`);
    }
  }
}

export async function validateLaunchPaths(input: LaunchContext): Promise<{ cwd: string; systemPromptPath: string; sessionDirectory?: string }> {
  const cwd = await canonicalExistingDirectory(input.policy.cwd, "Launch cwd");
  const roots = await Promise.all(input.policy.trustedRoots.map((root) => canonicalExistingDirectory(root, "Trusted root")));
  if (!roots.some((root) => isWithin(root, cwd))) throw new HarnessConfigurationError("Launch cwd is outside trusted roots");
  const systemPromptPath = await assertPrivateSystemPrompt(input.systemPromptPath);
  const sessionDirectory = input.sessionDirectory === undefined
    ? undefined
    : await assertPrivateSessionDirectory(input.sessionDirectory);
  return { cwd, systemPromptPath, ...(sessionDirectory === undefined ? {} : { sessionDirectory }) };
}

export function childMetadataEnvironment(metadata: ChildMetadata): Record<string, string> {
  const env: Record<string, string> = {
    HERDR_SUBAGENT: "1",
    HERDR_SUBAGENT_NO_RECURSION: "1",
    HERDR_SUBAGENT_RUN_ID: metadata.runId,
    HERDR_SUBAGENT_RUN_NONCE: metadata.runNonce,
    HERDR_SUBAGENT_PROFILE: metadata.profileName,
    HERDR_SUBAGENT_PARENT_SESSION_ID: metadata.parentSessionId,
  };
  if (metadata.parentSessionPath !== undefined) env.HERDR_SUBAGENT_PARENT_SESSION_PATH = metadata.parentSessionPath;
  return env;
}

export function capabilityReport(capabilities: AdapterCapabilities, executable: string): CapabilityReport {
  return { ok: true, capabilities, executable, diagnostics: capabilities.limitations };
}

export function assertThinkingSupported(capabilities: AdapterCapabilities, thinking: ThinkingLevel): void {
  if (!capabilities.supportedThinking.includes(thinking)) {
    throw new HarnessConfigurationError(`${capabilities.harness} cannot safely map thinking level ${thinking}`);
  }
}

export function effectiveCapabilities(
  capabilities: AdapterCapabilities,
  policy: EffectiveHarnessCapabilities,
): AdapterCapabilities {
  if (policy.harness !== capabilities.harness) throw new HarnessConfigurationError("Harness capability mismatch");
  return capabilities;
}
