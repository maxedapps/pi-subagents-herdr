import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, type HerdrSubagentsSettings, type LoadedSettings } from "../config/settings.ts";
import { HARNESSES, type Harness } from "../contracts/harness.ts";
import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import type { AgentProfile } from "../contracts/profile.ts";
import { HERDR_PROTOCOL_VERSION, MINIMUM_HERDR_VERSION } from "../contracts/protocol.ts";
import type { SessionSnapshot } from "../herdr/protocol.ts";
import { createHerdrClientFromEnvironment, preflightOwningParent, type HerdrClient, type ParentIdentityEnvironment } from "../herdr/client.ts";
import { resolveArtifactPath, resolveArtifactRoots } from "../artifacts/paths.ts";
import { resolveExecutable } from "../harnesses/base.ts";
import { ADAPTER_CAPABILITIES } from "../harnesses/capabilities.ts";
import { getPackageRoot } from "../package-paths.ts";
import { discoverProfiles, type ProfileDiscoveryResult } from "../profiles/discovery.ts";
import { resolveSoftCapabilities } from "../profiles/diagnostics.ts";
import { recoverActiveBranchOwnership, reconcileOwnership, type OperationalMetadata, type PiBranchEntry } from "../runtime/ownership.ts";
import type { WorktreeStateView } from "../worktrees/contracts.ts";

const execFileAsync = promisify(execFile);
const RESEARCH_TOOLS = new Set(["web_search", "WebSearch", "fetch_content", "WebFetch", "get_search_content"]);

export type DoctorStatus = "pass" | "warning" | "fail" | "info";
export interface DoctorCheck {
  readonly id: string;
  readonly category: "package" | "pi" | "herdr" | "harness" | "integration" | "profiles" | "capabilities" | "git" | "artifacts" | "recovery" | "worktrees";
  readonly status: DoctorStatus;
  readonly message: string;
  readonly details?: readonly string[];
}
export interface DoctorRunEvidence extends OperationalMetadata {
  readonly runId: string;
  readonly runNonce: string;
  readonly terminalId: string;
  readonly nativeSession?: NativeSessionIdentity;
}
export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly package: { readonly name: string; readonly version: string; readonly private: true; readonly root: string };
  readonly summary: { readonly pass: number; readonly warning: number; readonly fail: number; readonly info: number; readonly healthy: boolean };
  readonly checks: readonly DoctorCheck[];
  readonly observational: readonly { readonly terminalId: string; readonly agent: string; readonly status: string; readonly reason: string }[];
  readonly retentionGuidance: string;
  readonly destructiveActions: readonly [];
}

export interface DoctorCommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export interface DoctorProbe {
  exec(command: string, args: readonly string[], cwd: string): Promise<DoctorCommandResult>;
}
export interface DoctorContext {
  readonly cwd: string;
  readonly isProjectTrusted: () => boolean;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getBranch">;
}
export interface DoctorOptions {
  readonly context: DoctorContext;
  readonly environment?: ParentIdentityEnvironment & Readonly<Record<string, string | undefined>>;
  readonly agentDir?: string;
  readonly activeTools?: readonly string[];
  readonly runtimeEvidence?: readonly DoctorRunEvidence[];
  readonly worktrees?: readonly WorktreeStateView[];
  readonly client?: HerdrClient;
  readonly startupIssue?: string;
  readonly now?: () => Date;
  readonly probe?: DoctorProbe;
}

const defaultProbe: DoctorProbe = {
  async exec(command, args, cwd) {
    try {
      const result = await execFileAsync(command, [...args], { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 256_000 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
    }
  },
};

function check(id: string, category: DoctorCheck["category"], status: DoctorStatus, message: string, details?: readonly string[]): DoctorCheck {
  return { id, category, status, message, ...(details === undefined || details.length === 0 ? {} : { details }) };
}
function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}
async function packageMetadata(): Promise<{ name: string; version: string; private: true; root: string }> {
  const root = getPackageRoot();
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown; private?: unknown; license?: unknown };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || manifest.private !== true) throw new Error("Package manifest lacks a private name/version contract");
  if (manifest.license !== undefined) throw new Error("Legal hold requires package.json to omit a license until the user chooses one");
  return { name: manifest.name, version: manifest.version, private: true, root };
}
async function commandVersion(probe: DoctorProbe, cwd: string, command: string, args: readonly string[]): Promise<string | undefined> {
  const result = await probe.exec(command, args, cwd);
  if (result.code !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}
async function inspectGit(probe: DoctorProbe, cwd: string, requestProgress: boolean): Promise<DoctorCheck[]> {
  const root = await probe.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], cwd);
  if (root.code !== 0) return [check("git.checkout", "git", "info", "Checkout is not Git-backed; local exclude protection is not applicable")];
  const gitRoot = await realpath(root.stdout.trim()).catch(() => resolve(root.stdout.trim()));
  const checks: DoctorCheck[] = [];
  if (gitRoot !== await realpath(cwd).catch(() => resolve(cwd))) checks.push(check("git.root", "git", "warning", `Current cwd is below Git root ${gitRoot}; launches require the checkout root for anchored excludes`));
  const ignored = await probe.exec("git", ["-C", gitRoot, "check-ignore", "--no-index", "-q", "--", ".subagents/.doctor-probe"], gitRoot);
  checks.push(check("git.subagents-ignore", "git", ignored.code === 0 ? "pass" : "warning", ignored.code === 0 ? "/.subagents/ is ignored without modifying tracked .gitignore" : "/.subagents/ is not currently ignored; the first artifact launch will attempt a Git-local info/exclude entry"));
  if (requestProgress) {
    const progressIgnored = await probe.exec("git", ["-C", gitRoot, "check-ignore", "--no-index", "-q", "--", ".progress/.doctor-probe"], gitRoot);
    const untracked = progressIgnored.code === 0
      ? { code: 0, stdout: "", stderr: "" }
      : await probe.exec("git", ["-C", gitRoot, "ls-files", "--others", "--exclude-standard", "--", ".progress"], gitRoot);
    const untrackedPaths = untracked.stdout.trim().split(/\r?\n/).filter(Boolean);
    checks.push(check(
      "git.progress-ignore",
      "git",
      progressIgnored.code === 0 ? "pass" : "warning",
      progressIgnored.code === 0
        ? "/.progress/ protection is active for profiles that request progress artifacts"
        : untrackedPaths.length > 0
          ? "Requested /.progress/ protection is incomplete and pre-existing untracked content requires explicit review; production start will fail before artifact/topology writes"
          : "/.progress/ is not currently ignored; the first requesting launch will attempt a Git-local info/exclude entry before writing artifacts",
      untrackedPaths,
    ));
  }
  const tracked = await probe.exec("git", ["-C", gitRoot, "ls-files", "--", ".subagents", ".progress"], gitRoot);
  const paths = tracked.stdout.trim().split(/\r?\n/).filter(Boolean);
  checks.push(check("git.runtime-tracked", "git", paths.length === 0 ? "pass" : "warning", paths.length === 0 ? "No runtime artifact path is already tracked" : "Tracked runtime files cannot be hidden by local excludes", paths));
  return checks;
}
function integrationChecks(output: string, strictness: HerdrSubagentsSettings["integrations"]["strictness"]): DoctorCheck[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  return HARNESSES.map((name) => {
    const line = lines.find((candidate) => candidate.startsWith(`${name}:`));
    if (!line) return check(`integration.${name}`, "integration", strictness === "strict" ? "fail" : "warning", `${name} integration status was not reported`);
    const current = /:\s+current\s+\(v\d+\)/.test(line);
    return check(`integration.${name}`, "integration", current ? "pass" : strictness === "strict" ? "fail" : "warning", line);
  });
}
async function artifactChecks(cwd: string, settings: HerdrSubagentsSettings, profiles: readonly AgentProfile[]): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let roots;
  try {
    roots = await resolveArtifactRoots({ checkout: cwd, allowProgress: true, trustedAdditionalRoots: settings.security.allowedRoots });
    checks.push(check("artifacts.roots", "artifacts", "pass", "Artifact roots canonicalize beneath explicit checkout/trusted roots", [roots.subagents, roots.progress!, ...roots.additional]));
  } catch (error) {
    return [check("artifacts.roots", "artifacts", "fail", error instanceof Error ? error.message : String(error))];
  }
  for (const profile of profiles) {
    for (const [kind, template] of Object.entries(profile.artifacts ?? {})) {
      if (kind === "writer" || typeof template !== "string") continue;
      try {
        resolveArtifactPath(template, { id: "doctor-run", groupId: "doctor-group", profile: profile.name, harness: profile.harness ?? settings.defaultHarness }, roots);
      } catch (error) {
        checks.push(check(`artifacts.profile.${profile.name}.${kind}`, "artifacts", "fail", error instanceof Error ? error.message : String(error)));
      }
    }
  }
  if (!checks.some((item) => item.id.startsWith("artifacts.profile."))) checks.push(check("artifacts.templates", "artifacts", "pass", "All enabled profile artifact templates pass containment and placeholder validation"));
  return checks;
}
function profileChecks(discovery: ProfileDiscoveryResult, activeTools: readonly string[]): DoctorCheck[] {
  const details = discovery.winners.map((profile) => `${profile.name}${profile.disabled ? " (disabled)" : ""}: ${profile.source.path}`);
  const checks = [check("profiles.discovery", "profiles", "pass", `${discovery.profiles.length} enabled profile(s) discovered with deterministic precedence`, details)];
  for (const shadow of discovery.shadows) checks.push(check(`profiles.shadow.${shadow.name}.${shadow.shadowed.priority}`, "profiles", "info", `${shadow.winner.path} ${shadow.disabledByWinner ? "disables" : "shadows"} ${shadow.shadowed.path}`));
  for (const diagnostic of discovery.diagnostics) checks.push(check(`profiles.${diagnostic.code}.${checks.length}`, "profiles", diagnostic.severity === "error" ? "fail" : diagnostic.severity === "warning" ? "warning" : "info", diagnostic.message, diagnostic.path ? [diagnostic.path] : undefined));
  const researcher = discovery.winners.find((profile) => profile.name === "researcher");
  if (researcher) {
    const exposed = activeTools.filter((name) => RESEARCH_TOOLS.has(name));
    const soft = resolveSoftCapabilities(researcher, { tools: activeTools, reviewedExternalResearchTools: exposed });
    checks.push(check("capabilities.research", "capabilities", soft.research.available ? "pass" : "warning", soft.research.available ? `Researcher has reviewed optional external capability: ${soft.tools.filter((name) => RESEARCH_TOOLS.has(name)).join(", ")}` : "Researcher external-source capability is currently unavailable; research starts will block rather than claim memory-only research", soft.diagnostics.map((item) => item.message)));
  }
  return checks;
}
function recoveryChecks(branch: readonly PiBranchEntry[], snapshot: SessionSnapshot, context: DoctorContext, evidence: readonly DoctorRunEvidence[]) {
  const active = recoverActiveBranchOwnership(branch);
  const sessionPath = context.sessionManager.getSessionFile();
  const currentParent = { sessionId: context.sessionManager.getSessionId(), ...(sessionPath === undefined ? {} : { sessionPath }) };
  const checks: DoctorCheck[] = [];
  const ownedTerminals = new Set<string>();
  for (const [runId, recovered] of active) {
    const metadata = evidence.find((item) => item.runId === runId);
    if (!metadata) {
      checks.push(check(`recovery.${runId}`, "recovery", "warning", "Active-branch journal has no validated operational run metadata; retain as observational evidence only"));
      continue;
    }
    const result = reconcileOwnership({ runId, active, snapshot, currentParent, metadata });
    checks.push(check(`recovery.${runId}`, "recovery", result.state === "owned" ? "pass" : "warning", `${result.state}: ${result.reason}`));
    if (result.state === "owned") ownedTerminals.add(metadata.terminalId);
    void recovered;
  }
  if (active.size === 0) checks.push(check("recovery.none", "recovery", "info", "No active-branch ownership journals are present"));
  return { checks, ownedTerminals };
}

/** Build a read-only report. It never appends Pi entries, writes files/settings/Git excludes, adopts panes, focuses, or closes resources. */
export async function createDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const probe = options.probe ?? defaultProbe;
  const environment = options.environment ?? process.env;
  const checks: DoctorCheck[] = [];
  let metadata: Awaited<ReturnType<typeof packageMetadata>>;
  try { metadata = await packageMetadata(); checks.push(check("package.metadata", "package", "pass", `${metadata.name}@${metadata.version} is private and under legal hold`)); }
  catch (error) { metadata = { name: "pi-subagents-herdr", version: "unknown", private: true, root: getPackageRoot() }; checks.push(check("package.metadata", "package", "fail", error instanceof Error ? error.message : String(error))); }

  const piVersion = await commandVersion(probe, options.context.cwd, "pi", ["--version"]);
  checks.push(check("pi.version", "pi", piVersion ? "pass" : "fail", piVersion ? `Pi ${piVersion}` : "Pi executable/version is unavailable"));
  if (options.startupIssue) checks.push(check("pi.runtime-start", "pi", "warning", `Session runtime startup diagnostic: ${options.startupIssue}`));

  let loaded: LoadedSettings | undefined;
  let discovery: ProfileDiscoveryResult | undefined;
  let progressRequested = false;
  try {
    loaded = await loadSettings({ agentDir: options.agentDir ?? getAgentDir(), projectConfigRoot: join(options.context.cwd, CONFIG_DIR_NAME), projectTrusted: options.context.isProjectTrusted(), workspaceRoot: options.context.cwd });
    checks.push(check("pi.settings", "pi", "pass", `Settings validated; loaded scopes: ${loaded.loaded.join(", ") || "defaults"}`, [loaded.locations.user, ...(loaded.locations.project ? [loaded.locations.project] : []), ...loaded.diagnostics.map((item) => item.message)]));
    discovery = await discoverProfiles({ agentDir: options.agentDir ?? getAgentDir(), projectConfigRoot: join(options.context.cwd, CONFIG_DIR_NAME), projectTrusted: options.context.isProjectTrusted(), bundledDirectory: join(metadata.root, "agents"), additionalUserDirectories: loaded.settings.profileDirectories.user, additionalProjectDirectories: loaded.settings.profileDirectories.project });
    progressRequested = discovery.profiles.some((profile) => profile.artifacts?.progress?.startsWith(".progress/") === true);
    checks.push(...profileChecks(discovery, options.activeTools ?? []));
    checks.push(...await artifactChecks(options.context.cwd, loaded.settings, discovery.profiles));
  } catch (error) {
    checks.push(check("profiles-or-settings", "profiles", "fail", error instanceof Error ? error.message : String(error)));
  }

  for (const harness of HARNESSES) {
    try {
      const executable = await resolveExecutable(ADAPTER_CAPABILITIES[harness].executable, undefined, environment.PATH);
      const version = await commandVersion(probe, options.context.cwd, executable, ["--version"]);
      checks.push(check(`harness.${harness}`, "harness", "pass", `${harness}: ${version ?? executable}`, [executable, ...ADAPTER_CAPABILITIES[harness].limitations]));
    } catch (error) { checks.push(check(`harness.${harness}`, "harness", harness === (loaded?.settings.defaultHarness ?? "pi") ? "fail" : "warning", error instanceof Error ? error.message : String(error))); }
  }

  const integration = await probe.exec("herdr", ["integration", "status"], options.context.cwd);
  checks.push(...integration.code === 0 ? integrationChecks(integration.stdout, loaded?.settings.integrations.strictness ?? "strict") : [check("integration.status", "integration", "warning", `Unable to inspect Herdr integrations: ${integration.stderr.trim() || "command failed"}`)]);
  checks.push(...await inspectGit(probe, options.context.cwd, progressRequested));

  let snapshot: SessionSnapshot | undefined;
  let parentTerminalId: string | undefined;
  try {
    const client = options.client ?? createHerdrClientFromEnvironment(environment);
    const sessionPath = options.context.sessionManager.getSessionFile();
    const identity = { id: options.context.sessionManager.getSessionId(), ...(sessionPath === undefined ? {} : { path: sessionPath }) };
    const preflight = await preflightOwningParent(client, environment, identity);
    snapshot = preflight.snapshot;
    parentTerminalId = preflight.pane.terminal_id;
    checks.push(check("herdr.compatibility", "herdr", "pass", `Herdr ${snapshot.version}/protocol ${snapshot.protocol}; required >=${MINIMUM_HERDR_VERSION}/protocol ${HERDR_PROTOCOL_VERSION}`));
    checks.push(check("herdr.parent-identity", "herdr", "pass", `Parent pane/native Pi identity validated at ${preflight.pane.workspace_id}/${preflight.pane.tab_id}/${preflight.pane.pane_id}`, [preflight.pane.terminal_id, `${preflight.nativeSession.kind}:${preflight.nativeSession.value}`]));
  } catch (error) {
    checks.push(check("herdr.preflight", "herdr", "fail", error instanceof Error ? error.message : String(error)));
  }

  const observational: Array<{ terminalId: string; agent: string; status: string; reason: string }> = [];
  if (snapshot) {
    const recovery = recoveryChecks(options.context.sessionManager.getBranch() as readonly PiBranchEntry[], snapshot, options.context, options.runtimeEvidence ?? []);
    checks.push(...recovery.checks);
    for (const agent of snapshot.agents) if (agent.terminal_id !== parentTerminalId && !recovery.ownedTerminals.has(agent.terminal_id)) observational.push({ terminalId: agent.terminal_id, agent: String(agent.agent ?? "unknown"), status: agent.agent_status, reason: "Live Herdr agent is not proven owned by this active Pi branch; observation only, no adoption or cleanup authority" });
    checks.push(check("recovery.observational", "recovery", observational.length === 0 ? "pass" : "info", observational.length === 0 ? "No additional live Herdr agents require observational retention" : `${observational.length} unowned/orphan/global live agent(s) retained observationally`, observational.map((item) => `${item.terminalId} ${item.agent} ${item.status}`)));
  }

  const worktrees = options.worktrees ?? [];
  checks.push(check("worktrees.state", "worktrees", worktrees.some((item) => item.state === "dirty" || item.state === "retained" || item.removalRefusal) ? "warning" : "pass", worktrees.length === 0 ? "No active-branch worktree records" : `${worktrees.length} active-branch worktree record(s) inspected read-only`, worktrees.map((item) => `${item.id}: ${item.state} ${item.checkoutPath}${item.retentionReason ? ` — ${item.retentionReason}` : ""}`)));

  const summary = { pass: 0, warning: 0, fail: 0, info: 0, healthy: false };
  for (const item of checks) summary[item.status] += 1;
  summary.healthy = summary.fail === 0;
  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    package: metadata,
    summary,
    checks,
    observational,
    retentionGuidance: "Uncertain, orphaned, other-session, and global agents/worktrees are observational only. Retain their panes, checkouts, branches, and artifacts; this package does not adopt or destructively clean them.",
    destructiveActions: [],
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<DoctorStatus, string> = { pass: "✓", warning: "!", fail: "✗", info: "·" };
  const lines = [`${report.package.name}@${report.package.version} doctor — ${report.summary.fail} fail, ${report.summary.warning} warning, ${report.summary.pass} pass`];
  for (const item of report.checks) {
    lines.push(`${icon[item.status]} [${item.category}] ${item.message}`);
    for (const detail of item.details ?? []) lines.push(`    ${detail}`);
  }
  lines.push("", report.retentionGuidance, "Doctor is read-only: no adoption, focus, input, stop, cleanup, settings write, artifact write, or Git exclude mutation was performed.");
  return lines.join("\n");
}
