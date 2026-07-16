import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureRuntimeGitExcludes } from "../artifacts/git-ignore.ts";
import { materializeHandoff, parentHandoffWrapperPath } from "../artifacts/handoff.ts";
import {
  canonicalRunArtifactPaths,
  expandArtifactTemplate,
  resolveArtifactPath,
  resolveArtifactRoots,
  type ArtifactRoots,
} from "../artifacts/paths.ts";
import { ensureSafeArtifactDirectory, writeArtifactAtomic } from "../artifacts/store.ts";
import { loadSettingsForContext, type HerdrSubagentsSettings } from "../config/settings.ts";
import type { ArtifactContract } from "../contracts/artifact.ts";
import type { EffectiveLaunchPolicy, Harness, LaunchPolicy, ThinkingLevel, ToolGrant } from "../contracts/harness.ts";
import type { AgentProfile } from "../contracts/profile.ts";
import type { HerdrStatus } from "../contracts/state.ts";
import type { SessionSnapshot } from "../herdr/protocol.ts";
import {
  createHerdrClientFromEnvironment,
  HerdrCompatibilityError,
  HerdrIdentityError,
  preflightOwningParent,
  type HerdrClient,
  type ParentPreflight,
} from "../herdr/client.ts";
import { HerdrTimeoutError, HerdrUnavailableError } from "../herdr/transport.ts";
import { HerdrSubscriptionManager } from "../herdr/subscriptions.ts";
import { assembleChildInstructions } from "../harnesses/prompt.ts";
import { prepareHarnessLaunch } from "../harnesses/index.ts";
import { resolveMonotonicOverrides } from "../policy/capabilities.ts";
import { discoverProfilesForContext } from "../profiles/discovery.ts";
import { resolveSoftCapabilities } from "../profiles/diagnostics.ts";
import { resolveProfileSkills, type ProfileSkillResolution } from "../profiles/skills.ts";
import { createDoctorReport, type DoctorReport } from "../doctor/report.ts";
import {
  boundRecentOutput,
  focusOwnedPaneFresh,
  readBoundedOutput,
  revalidateRecordedOwnershipFresh,
  type BoundedOutput,
  type OwnedRunTarget,
  type RuntimeOwnershipAuthorization,
} from "../runtime/control.ts";
import { createEphemeralRuntimeFiles, removeEphemeralRuntimeFiles, type EphemeralRuntimeFiles } from "../runtime/ephemeral.ts";
import { DelegationGroupManager, type DelegationGroup } from "../runtime/groups.ts";
import { interruptSubagent } from "../runtime/interrupt.ts";
import {
  ActiveBranchOwnershipJournal,
  parseOwnershipJournalData,
  recoverActiveBranchOwnership,
  reconcileOwnership,
  type OwnershipJournalData,
  type PiBranchEntry,
} from "../runtime/ownership.ts";
import { sendToSubagent } from "../runtime/send.ts";
import { assertRuntimeFilesMatchMetadata, assertRuntimeMetadataMatchesJournal, readRuntimeRunMetadata, type RuntimeRunMetadata } from "../runtime/metadata.ts";
import { StartCleanupError, startSubagent } from "../runtime/start.ts";
import { stopSubagent } from "../runtime/stop.ts";
import { waitForSubagent } from "../runtime/wait.ts";
import type { WorktreeRecord } from "../worktrees/contracts.ts";
import { WorktreeCleanupManager, type IntegrationVerificationRequest } from "../worktrees/cleanup.ts";
import { WorktreeManager, WorktreeRegistry } from "../worktrees/manager.ts";
import type { UiRunDetails } from "../ui/details.ts";
import type { DashboardScope } from "../ui/status.ts";
import type {
  ActionToolResult,
  GetToolResult,
  ListToolResult,
  RunSummary,
  StartToolResult,
  ToolUnavailableResult,
} from "./contracts.ts";
import type {
  GetToolInput,
  InterruptToolInput,
  ListToolInput,
  SendToolInput,
  StartToolInput,
  StopToolInput,
  WaitToolInput,
} from "./schemas.ts";

const TOOL_CATALOG: Readonly<Record<string, ToolGrant>> = Object.freeze({
  read: { name: "read", capabilities: ["read"] },
  grep: { name: "grep", capabilities: ["read"] },
  find: { name: "find", capabilities: ["read"] },
  ls: { name: "ls", capabilities: ["read"] },
  Read: { name: "Read", capabilities: ["read"] },
  Grep: { name: "Grep", capabilities: ["read"] },
  Glob: { name: "Glob", capabilities: ["read"] },
  bash: { name: "bash", capabilities: ["read", "mutation", "network"] },
  Bash: { name: "Bash", capabilities: ["read", "mutation", "network"] },
  edit: { name: "edit", capabilities: ["mutation"] },
  Edit: { name: "Edit", capabilities: ["mutation"] },
  write: { name: "write", capabilities: ["mutation"] },
  Write: { name: "Write", capabilities: ["mutation"] },
  web_search: { name: "web_search", capabilities: ["network"] },
  WebSearch: { name: "WebSearch", capabilities: ["network"] },
  fetch_content: { name: "fetch_content", capabilities: ["network"] },
  WebFetch: { name: "WebFetch", capabilities: ["network"] },
  get_search_content: { name: "get_search_content", capabilities: ["network"] },
});
const REVIEWED_RESEARCH_TOOLS = new Set(["web_search", "WebSearch", "fetch_content", "WebFetch", "get_search_content"]);
const EMPTY_OUTPUT = boundRecentOutput("", false, 0);

export class StartTopologyGate {
  #tail: Promise<void> = Promise.resolve();
  #idempotent = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#idempotent.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const result = (async () => {
      const previous = this.#tail;
      let release!: () => void;
      this.#tail = new Promise<void>((resolveTail) => { release = resolveTail; });
      await previous;
      try { return await operation(); } finally { release(); }
    })();
    this.#idempotent.set(key, result);
    if (this.#idempotent.size > 256) this.#idempotent.delete(this.#idempotent.keys().next().value!);
    return result;
  }
}

class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

type RunArtifactPaths = Readonly<Record<string, string>>;

interface RunArtifacts {
  readonly roots: ArtifactRoots;
  readonly metadataRoots: ArtifactRoots;
  readonly contracts: readonly ArtifactContract[];
  paths: RunArtifactPaths;
}

interface ObservationalRun {
  readonly summary: RunSummary;
  readonly reason: string;
}

interface ManagedRun {
  readonly id: string;
  readonly runNonce: string;
  readonly profile: AgentProfile;
  readonly taskSynopsis: string;
  assignment?: string;
  readonly createdAt: number;
  updatedAt: number;
  lifecycle: "starting" | "running" | "interrupting" | "stopping" | "stopped" | "failed" | "lost";
  herdrStatus: HerdrStatus;
  policy: EffectiveLaunchPolicy;
  readonly parentBranchEntryId: string;
  readonly reviewedSkills: ProfileSkillResolution;
  journal: OwnershipJournalData;
  target?: OwnedRunTarget;
  group?: DelegationGroup;
  artifacts?: RunArtifacts;
  ephemeral?: EphemeralRuntimeFiles;
  worktreeId?: string;
  lastOutput: BoundedOutput;
  failure?: string;
}

export interface SessionToolRuntime {
  start(context: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
}

export interface ToolRuntimeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function synopsis(task: string): string {
  const compact = task.trim().replace(/\s+/g, " ");
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function defaultThinking(harness: Harness): ThinkingLevel {
  return harness === "pi" ? "medium" : harness === "claude" ? "medium" : "medium";
}

function safeRunId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function unavailable(reason: string, status: "blocked" | "unavailable" = "unavailable"): ToolUnavailableResult {
  return { ok: false, status, reason };
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof HerdrUnavailableError || error instanceof HerdrTimeoutError || error instanceof HerdrCompatibilityError;
}

function sessionIdentity(context: ExtensionContext): { sessionId: string; sessionPath?: string } {
  const sessionId = context.sessionManager.getSessionId();
  const sessionPath = context.sessionManager.getSessionFile();
  return { sessionId, ...(sessionPath === undefined ? {} : { sessionPath }) };
}

function currentBranch(context: ExtensionContext): readonly PiBranchEntry[] {
  return context.sessionManager.getBranch() as readonly PiBranchEntry[];
}

function profileTools(pi: ExtensionAPI, profile: AgentProfile): readonly ToolGrant[] {
  const activeNames = new Set(pi.getAllTools().map((tool) => tool.name));
  const names = [...(profile.tools ?? [])];
  for (const preferred of profile.preferredTools ?? []) {
    if (activeNames.has(preferred) && TOOL_CATALOG[preferred] !== undefined && !names.includes(preferred)) names.push(preferred);
  }
  return names.map((name) => {
    const grant = TOOL_CATALOG[name];
    if (!grant) throw new Error(`Profile ${profile.name} requests unreviewed tool ${name}`);
    if (/subagent|delegate/i.test(name)) throw new Error(`Recursive orchestration tool is prohibited in children: ${name}`);
    return { name: grant.name, capabilities: [...grant.capabilities] };
  });
}

function profileRequiresWorktree(profile: AgentProfile, settings: HerdrSubagentsSettings, mutation: boolean): boolean {
  if (!mutation) return profile.worktree === "required";
  return settings.security.requireWriterWorktree
    || profile.worktree === "required"
    || profile.worktree === "required-for-concurrency";
}

function actualProfile(profile: AgentProfile, harness: Harness): AgentProfile {
  return profile.harness === harness ? profile : { ...profile, harness };
}

function precomputedWorktreeArtifactPath(checkout: string, template: string, values: { id: string; profile: string; harness: Harness }): string {
  const path = resolve(checkout, expandArtifactTemplate(template, { ...values, groupId: "default" }));
  const allowed = [join(checkout, ".subagents"), join(checkout, ".progress")];
  if (!allowed.some((root) => isWithin(root, path))) throw new Error(`Worktree artifact path escapes extension-owned roots: ${path}`);
  return path;
}

function limitOutputLines(output: BoundedOutput, lines: number): BoundedOutput {
  const split = output.text.split("\n");
  if (output.text.length === 0 || split.length <= lines) return output;
  const text = split.slice(-lines).join("\n");
  return {
    ...output,
    text,
    truncated: true,
    localTruncated: true,
    returnedBytes: Buffer.byteLength(text, "utf8"),
    returnedLines: lines,
  };
}

function runtimeMetadata(run: ManagedRun, terminalId: string, nativeSession = run.journal.resources.nativeSession): RuntimeRunMetadata {
  if (!run.artifacts) throw new Error("Run artifacts must exist before runtime metadata is persisted");
  return {
    schemaVersion: 3,
    runId: run.id,
    runNonce: run.runNonce,
    terminalId,
    ...(nativeSession === undefined ? {} : { nativeSession }),
    profileName: run.profile.name,
    profileSource: run.profile.source.path,
    harness: run.policy.harness,
    taskSynopsis: run.taskSynopsis,
    ...(run.assignment === undefined ? {} : { assignment: run.assignment }),
    artifactWriter: run.profile.artifacts?.writer ?? "parent",
    createdAt: run.createdAt,
    policy: {
      thinking: run.policy.thinking,
      cwd: run.policy.cwd,
      tools: run.policy.tools.map((tool) => tool.name),
      skills: run.reviewedSkills.resources.map((skill) => ({ name: skill.name, path: skill.path })),
      mutation: run.policy.permissions.mutation,
      network: run.policy.permissions.network,
      requireWorktree: run.policy.requireWorktree,
    },
    artifacts: run.artifacts.paths,
    output: run.lastOutput,
    runtime: run.ephemeral === undefined
      ? { ephemeralFiles: "removed" }
      : {
          ephemeralFiles: "retained",
          directory: run.ephemeral.directory,
          systemPrompt: run.ephemeral.systemPrompt,
          ...(run.ephemeral.sessionDirectory === undefined ? {} : { sessionDirectory: run.ephemeral.sessionDirectory }),
        },
  };
}

export class HerdrToolRuntimeController {
  readonly #pi: ExtensionAPI;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #topology = new SerialQueue();
  readonly #startGate = new StartTopologyGate();
  readonly #runs = new Map<string, ManagedRun>();
  readonly #observational = new Map<string, ObservationalRun>();
  #context: ExtensionContext | undefined;
  #settings: HerdrSubagentsSettings | undefined;
  #profiles = new Map<string, AgentProfile>();
  #client: HerdrClient | undefined;
  #preflight: ParentPreflight | undefined;
  #groups: DelegationGroupManager | undefined;
  #subscriptions: HerdrSubscriptionManager | undefined;
  #worktrees: WorktreeRegistry | undefined;
  #worktreeManager: WorktreeManager | undefined;
  #worktreeCleanup: WorktreeCleanupManager | undefined;
  #startupIssue: string | undefined;
  readonly #uiListeners = new Set<() => void>();

  constructor(pi: ExtensionAPI, options: ToolRuntimeOptions = {}) {
    this.#pi = pi;
    this.#environment = options.environment ?? process.env;
  }

  createSessionRuntime(): SessionToolRuntime {
    return { start: (context) => this.startSession(context), stop: () => this.stopSession() };
  }

  async startSession(context: ExtensionContext): Promise<void> {
    await this.stopSession();
    this.#context = context;
    this.#runs.clear();
    this.#observational.clear();
    this.#startupIssue = undefined;
    try {
      const loaded = await loadSettingsForContext(context);
      this.#settings = loaded.settings;
      const discovered = await discoverProfilesForContext(context, loaded.settings.profileDirectories);
      this.#profiles = new Map(discovered.profiles.map((profile) => [profile.name, profile]));
    } catch (error) {
      this.#startupIssue = error instanceof Error ? error.message : String(error);
      return;
    }
    try {
      const identity = sessionIdentity(context);
      const client = createHerdrClientFromEnvironment(this.#environment);
      const preflight = await preflightOwningParent(client, this.#environment, { id: identity.sessionId, ...(identity.sessionPath === undefined ? {} : { path: identity.sessionPath }) });
      this.#client = client;
      this.#preflight = preflight;
      this.#groups = new DelegationGroupManager(client);
      this.#worktrees = WorktreeRegistry.recover(currentBranch(context), this.#pi);
      this.#worktreeManager = new WorktreeManager(client, this.#groups, this.#worktrees);
      this.#worktreeCleanup = new WorktreeCleanupManager(client, this.#worktrees);
      await this.#recoverLiveRuns();
      this.#subscriptions = new HerdrSubscriptionManager({
        client,
        ownedPaneIds: () => [...this.#runs.values()].flatMap((run) => run.journal.resources.paneId ? [run.journal.resources.paneId] : []),
        onChange: () => this.#notifyUi(),
      });
      await this.#subscriptions.start();
    } catch (error) {
      this.#startupIssue = error instanceof Error ? error.message : String(error);
      this.#client = undefined;
      this.#preflight = undefined;
    }
  }

  subscribeUi(listener: () => void): () => void {
    this.#uiListeners.add(listener);
    return () => { this.#uiListeners.delete(listener); };
  }

  widgetVisibility(): HerdrSubagentsSettings["widget"]["visibility"] {
    return this.#settings?.widget.visibility ?? "auto";
  }

  #notifyUi(): void {
    for (const listener of this.#uiListeners) {
      try { listener(); } catch { /* UI observers cannot break lifecycle control. */ }
    }
  }

  async stopSession(): Promise<void> {
    await this.#subscriptions?.stop();
    this.#subscriptions = undefined;
    this.#client = undefined;
    this.#preflight = undefined;
    this.#groups = undefined;
    this.#worktreeManager = undefined;
    this.#worktreeCleanup = undefined;
    this.#context = undefined;
  }

  async #recoverLiveRuns(): Promise<void> {
    const context = this.#context!;
    const preflight = this.#preflight!;
    const active = recoverActiveBranchOwnership(currentBranch(context));
    const parent = sessionIdentity(context);
    const now = Date.now();
    const observe = (journal: OwnershipJournalData, ownership: "orphaned" | "uncertain", reason: string) => {
      const terminalId = journal.resources.terminalId;
      const agent = terminalId ? preflight.snapshot.agents.find((candidate) => candidate.terminal_id === terminalId) : undefined;
      const pane = terminalId ? preflight.snapshot.panes.find((candidate) => candidate.terminal_id === terminalId) : undefined;
      const harness = ["pi", "claude", "codex"].includes(String(agent?.agent)) ? agent!.agent as Harness : "pi";
      this.#observational.set(journal.runId, {
        reason,
        summary: {
          id: journal.runId,
          profile: "observational-recovery",
          harness,
          lifecycle: pane && agent ? "running" : journal.phase === "failed" ? "failed" : "lost",
          herdrStatus: agent?.agent_status ?? "unknown",
          ownership,
          live: pane !== undefined && agent !== undefined,
          elapsedMs: 0,
          taskSynopsis: reason,
          ...(terminalId === undefined ? {} : { terminalId }),
          ...(pane === undefined ? {} : { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id, focused: pane.focused }),
          ...(agent === undefined ? {} : { agentRevision: agent.revision }),
          ...(this.#worktrees?.getState(journal.runId) === undefined ? {} : { worktree: this.#worktrees!.getState(journal.runId)! }),
        },
      });
    };

    for (const recovered of active.values()) {
      const journal = recovered.journal;
      if (recovered.state !== "owned" || journal.phase !== "started" || !journal.resources.terminalId) {
        observe(journal, "uncertain", recovered.state === "uncertain" ? recovered.issues.join("; ") : `Active journal phase ${journal.phase} is not recoverable for control`);
        continue;
      }
      const agent = preflight.snapshot.agents.find((candidate) => candidate.terminal_id === journal.resources.terminalId);
      if (!agent || !["pi", "claude", "codex"].includes(String(agent.agent))) {
        observe(journal, "uncertain", "Active journal terminal/native harness is not live and exactly reconcilable; retain evidence");
        continue;
      }
      let metadata: RuntimeRunMetadata | undefined;
      try {
        metadata = await readRuntimeRunMetadata(context.cwd, journal.runId);
        if (!metadata) throw new Error("operational run metadata is missing");
        assertRuntimeMetadataMatchesJournal(metadata, journal);
        if (metadata.runtime.ephemeralFiles !== "retained" || metadata.assignment === undefined) {
          throw new Error("live recovery requires retained run-bound ephemeral files and the full delegated assignment");
        }
        await assertRuntimeFilesMatchMetadata(metadata);
      } catch (error) {
        observe(journal, "uncertain", `Recovery metadata cannot authorize control: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const reconciliation = reconcileOwnership({ runId: journal.runId, active, snapshot: preflight.snapshot, currentParent: parent, metadata });
      if (reconciliation.state !== "owned") {
        observe(journal, reconciliation.state, reconciliation.reason);
        continue;
      }
      const harness = metadata.harness;
      const profile: AgentProfile = {
        name: metadata.profileName,
        description: "Recovered from validated active-branch and operational metadata",
        body: "Continue only the already delegated task. Never delegate recursively.",
        harness,
        permissions: metadata.policy.mutation ? "write" : "read-only",
        artifacts: { writer: metadata.artifactWriter },
        source: { path: metadata.profileSource, scope: "bundled", namespace: "shared", priority: 0 },
      };
      const policy: EffectiveLaunchPolicy = {
        harness,
        allowedModels: [],
        thinking: metadata.policy.thinking,
        cwd: metadata.policy.cwd,
        trustedRoots: [metadata.policy.cwd],
        tools: metadata.policy.tools.map((name) => TOOL_CATALOG[name] ?? { name, capabilities: [] }),
        permissions: { mutation: metadata.policy.mutation, network: metadata.policy.network },
        requireWorktree: metadata.policy.requireWorktree,
        broadeningReasons: [],
      };
      const authorization = this.#authorization(journal.runId, journal.runNonce);
      const group = journal.resources.tabId && journal.resources.rootPaneId && journal.resources.rootTerminalId && journal.resources.rootProcessBaseline
        ? this.#groups!.restoreOwned({ workspaceId: journal.intended.workspaceId, group: journal.intended.group, tabId: journal.resources.tabId, rootPaneId: journal.resources.rootPaneId, rootTerminalId: journal.resources.rootTerminalId, rootProcessBaseline: journal.resources.rootProcessBaseline })
        : undefined;
      const target: OwnedRunTarget = {
        runId: journal.runId,
        runNonce: journal.runNonce,
        harness,
        terminalId: journal.resources.terminalId,
        activeBranchOwned: true,
        authorization,
        ...(journal.resources.nativeSession === undefined ? {} : { nativeSession: journal.resources.nativeSession }),
        ...(group === undefined ? {} : { group }),
      };
      const additionalRoots = this.#settings?.security.allowedRoots;
      const roots = await resolveArtifactRoots({ checkout: metadata.policy.cwd, allowProgress: metadata.artifacts.progress !== undefined, ...(additionalRoots === undefined ? {} : { trustedAdditionalRoots: additionalRoots }) });
      const metadataRoots = metadata.policy.cwd === context.cwd
        ? roots
        : await resolveArtifactRoots({ checkout: context.cwd, allowProgress: false, ...(additionalRoots === undefined ? {} : { trustedAdditionalRoots: additionalRoots }) });
      const ephemeral = metadata.runtime.ephemeralFiles === "retained"
        ? {
            directory: metadata.runtime.directory!,
            systemPrompt: metadata.runtime.systemPrompt!,
            ...(metadata.runtime.sessionDirectory === undefined ? {} : { sessionDirectory: metadata.runtime.sessionDirectory }),
          }
        : undefined;
      this.#runs.set(journal.runId, {
        id: journal.runId,
        runNonce: journal.runNonce,
        profile,
        taskSynopsis: metadata.taskSynopsis,
        ...(metadata.assignment === undefined ? {} : { assignment: metadata.assignment }),
        createdAt: metadata.createdAt,
        updatedAt: now,
        lifecycle: "running",
        herdrStatus: agent.agent_status,
        policy,
        parentBranchEntryId: journal.parent.branchEntryId,
        reviewedSkills: {
          resources: (metadata.policy.skills ?? []).map((skill) => ({ ...skill, required: true })),
          names: (metadata.policy.skills ?? []).map((skill) => skill.name),
          paths: (metadata.policy.skills ?? []).map((skill) => skill.path),
          diagnostics: [],
        },
        journal,
        target,
        ...(group === undefined ? {} : { group }),
        artifacts: { roots, metadataRoots, contracts: [], paths: metadata.artifacts as unknown as RunArtifactPaths },
        ...(ephemeral === undefined ? {} : { ephemeral }),
        ...(this.#worktrees?.get(journal.runId) === undefined ? {} : { worktreeId: journal.runId }),
        lastOutput: metadata.output,
      });
    }

    // Full-session entries are never a control source. They preserve abandoned
    // /tree branches and fork/new history as explicit observational records.
    const manager = context.sessionManager as ExtensionContext["sessionManager"] & { getEntries?: () => readonly PiBranchEntry[] };
    const allEntries = typeof manager.getEntries === "function" ? manager.getEntries() : currentBranch(context);
    for (const entry of allEntries) {
      if (entry.type !== "custom" || entry.customType !== "herdr-subagents.ownership.v1") continue;
      try {
        const journal = parseOwnershipJournalData(entry.data);
        if (!active.has(journal.runId) && !this.#observational.has(journal.runId)) observe(journal, "orphaned", "Ownership journal is outside the current active Pi branch; no adoption or control is permitted");
      } catch { /* Malformed inactive entries remain non-authoritative. */ }
    }
  }

  #ready(): { context: ExtensionContext; settings: HerdrSubagentsSettings; client: HerdrClient; preflight: ParentPreflight; groups: DelegationGroupManager; worktrees: WorktreeRegistry; worktreeManager: WorktreeManager; worktreeCleanup: WorktreeCleanupManager } | ToolUnavailableResult {
    if (!this.#context || !this.#settings) return unavailable(this.#startupIssue ?? "Subagent session runtime has not started");
    if (!this.#client || !this.#preflight || !this.#groups || !this.#worktrees || !this.#worktreeManager || !this.#worktreeCleanup) {
      return unavailable(this.#startupIssue ?? "Compatible Herdr and a verified owning parent pane are unavailable");
    }
    return { context: this.#context, settings: this.#settings, client: this.#client, preflight: this.#preflight, groups: this.#groups, worktrees: this.#worktrees, worktreeManager: this.#worktreeManager, worktreeCleanup: this.#worktreeCleanup };
  }

  #authorization(runId: string, runNonce: string): RuntimeOwnershipAuthorization {
    return {
      verify: ({ terminalId, nativeSession, snapshot }) => {
        const context = this.#context;
        if (!context) return false;
        const active = recoverActiveBranchOwnership(currentBranch(context));
        const currentParent = sessionIdentity(context);
        const recovered = active.get(runId);
        const pane = snapshot.panes.find((candidate) => candidate.terminal_id === terminalId);
        const agent = snapshot.agents.find((candidate) => candidate.terminal_id === terminalId);
        if (!pane && !agent && recovered?.state === "owned") {
          const journal = recovered.journal;
          return journal.runNonce === runNonce
            && journal.resources.terminalId === terminalId
            && journal.parent.sessionId === currentParent.sessionId
            && (journal.parent.sessionPath === undefined || journal.parent.sessionPath === currentParent.sessionPath)
            && (nativeSession === undefined || JSON.stringify(journal.resources.nativeSession) === JSON.stringify(nativeSession));
        }
        if (!pane || !agent) return false;
        const result = reconcileOwnership({
          runId,
          active,
          snapshot,
          currentParent,
          metadata: { runId, runNonce, terminalId, ...(nativeSession === undefined ? {} : { nativeSession }) },
        });
        return result.state === "owned";
      },
    };
  }

  async #validateArtifactPlan(checkout: string, profile: AgentProfile, id: string, harness: Harness): Promise<void> {
    const progressTemplate = profile.artifacts?.progress;
    const allowProgress = progressTemplate?.startsWith(".progress/") === true;
    const roots = await resolveArtifactRoots({ checkout, allowProgress, trustedAdditionalRoots: this.#settings!.security.allowedRoots });
    const protection = await ensureRuntimeGitExcludes({ checkout, requestProgress: allowProgress });
    if (protection.applicable && !protection.protected) {
      const diagnostics = protection.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
      throw new Error(`Runtime artifact Git-ignore protection is incomplete for ${protection.gitRoot ?? checkout}; no runtime artifact or topology was created. ${diagnostics || "Inspect the Git-local exclude configuration."}`);
    }
    const canonical = canonicalRunArtifactPaths(roots, { id, groupId: "default" });
    const values = { id, groupId: "default", profile: profile.name, harness } as const;
    if (profile.artifacts?.handoff !== undefined) resolveArtifactPath(profile.artifacts.handoff, values, roots);
    else void canonical.handoff;
    if (progressTemplate !== undefined) resolveArtifactPath(progressTemplate, values, roots);
  }

  async #artifacts(checkout: string, profile: AgentProfile, id: string, harness: Harness, durableCheckout = checkout): Promise<RunArtifacts> {
    const progressTemplate = profile.artifacts?.progress;
    const allowProgress = progressTemplate?.startsWith(".progress/") === true;
    const roots = await resolveArtifactRoots({ checkout, allowProgress, trustedAdditionalRoots: this.#settings!.security.allowedRoots });
    const metadataRoots = durableCheckout === checkout
      ? roots
      : await resolveArtifactRoots({ checkout: durableCheckout, allowProgress: false, trustedAdditionalRoots: this.#settings!.security.allowedRoots });
    const protections = await Promise.all([
      ensureRuntimeGitExcludes({ checkout, requestProgress: allowProgress }),
      ...(durableCheckout === checkout ? [] : [ensureRuntimeGitExcludes({ checkout: durableCheckout })]),
    ]);
    for (const protection of protections) {
      if (protection.applicable && !protection.protected) {
        const diagnostics = protection.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
        throw new Error(`Runtime artifact Git-ignore protection is incomplete for ${protection.gitRoot ?? checkout}; no runtime artifact was written. ${diagnostics || "Inspect the Git-local exclude configuration."}`);
      }
    }
    const canonical = canonicalRunArtifactPaths(roots, { id, groupId: "default" });
    const durableCanonical = canonicalRunArtifactPaths(metadataRoots, { id, groupId: "default" });
    const values = { id, groupId: "default", profile: profile.name, harness } as const;
    const handoff = profile.artifacts?.handoff ? resolveArtifactPath(profile.artifacts.handoff, values, roots) : canonical.handoff;
    const progress = progressTemplate ? resolveArtifactPath(progressTemplate, values, roots) : undefined;
    await ensureSafeArtifactDirectory(dirname(handoff), roots);
    if (progress !== undefined) await ensureSafeArtifactDirectory(dirname(progress), roots);
    await ensureSafeArtifactDirectory(dirname(durableCanonical.runMetadata), metadataRoots);
    const writer = profile.artifacts?.writer ?? "parent";
    const contracts: ArtifactContract[] = [
      ...(progress === undefined ? [] : [{ kind: "progress" as const, path: progress, writer, required: false }]),
      { kind: "handoff", path: handoff, writer, required: true },
    ];
    return {
      roots,
      metadataRoots,
      contracts,
      paths: {
        handoff,
        metadata: durableCanonical.runMetadata,
        ...(progress === undefined ? {} : { progress }),
      },
    };
  }

  async #createEphemeralRuntime(runId: string, harness: Harness): Promise<EphemeralRuntimeFiles> {
    const systemText = [
      "Subagent runtime boundary: perform only the delegated task; never delegate or invoke another agent.",
      "Do not broaden tools, permissions, network, cwd, writable roots, or worktree scope.",
      "If blocked, report the blocker and wait for the parent; never bypass provided lifecycle controls.",
    ].join("\n");
    return createEphemeralRuntimeFiles(runId, harness, systemText);
  }

  async #removeEphemeral(run: ManagedRun): Promise<void> {
    const ephemeral = run.ephemeral;
    if (ephemeral === undefined) return;
    await removeEphemeralRuntimeFiles(run.id, run.policy.harness, ephemeral);
    delete run.ephemeral;
  }

  async #persistMetadata(run: ManagedRun): Promise<void> {
    const terminalId = run.target?.terminalId ?? run.journal.resources.terminalId;
    if (!terminalId || !run.artifacts) return;
    await writeArtifactAtomic(
      run.artifacts.paths.metadata!,
      `${JSON.stringify(runtimeMetadata(run, terminalId), null, 2)}\n`,
      run.artifacts.metadataRoots,
      { mode: 0o600, replace: true },
    );
  }

  async #resolvePolicy(input: StartToolInput, profile: AgentProfile, context: ExtensionContext, settings: HerdrSubagentsSettings): Promise<{ profile: AgentProfile; policy: EffectiveLaunchPolicy; reviewedSkills: ProfileSkillResolution } | ToolUnavailableResult> {
    const harness = input.harness ?? profile.harness ?? settings.defaultHarness;
    const selectedProfile = actualProfile(profile, harness);
    const tools = profileTools(this.#pi, selectedProfile);
    const mutation = selectedProfile.permissions === "write";
    const baseline: LaunchPolicy = {
      harness,
      ...(selectedProfile.model === undefined ? {} : { model: selectedProfile.model }),
      allowedModels: selectedProfile.model === undefined ? [] : [selectedProfile.model],
      thinking: selectedProfile.thinking ?? defaultThinking(harness),
      cwd: context.cwd,
      trustedRoots: settings.security.allowedRoots,
      tools,
      permissions: { mutation, network: tools.some((tool) => tool.capabilities.includes("network")) },
      requireWorktree: profileRequiresWorktree(selectedProfile, settings, mutation),
    };
    const requireWorktree = input.worktree === "isolated" ? true : input.worktree === "shared" ? false : undefined;
    const overrides = {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(requireWorktree === undefined ? {} : { requireWorktree }),
    };
    let resolution = resolveMonotonicOverrides(baseline, overrides, {
      toolCatalog: TOOL_CATALOG,
      trustedBroadeningEnabled: settings.security.allowBroadeningOverrides,
      humanConfirmed: false,
    });
    if (!resolution.accepted && resolution.reasons.some((reason) => reason.includes("interactive human confirmation"))) {
      if (!settings.security.allowBroadeningOverrides) throw new Error(resolution.reasons.join("; "));
      if (!context.hasUI) return unavailable(`Launch broadening is blocked without interactive human confirmation: ${resolution.reasons.join("; ")}`, "blocked");
      const confirmed = await context.ui.confirm(
        "Broaden subagent launch policy?",
        `Requested changes: ${resolution.reasons.filter((reason) => !reason.includes("requires a trusted")).join("; ")}`,
      );
      if (!confirmed) return unavailable("Human confirmation was declined; no Herdr resource was created", "blocked");
      resolution = resolveMonotonicOverrides(baseline, overrides, {
        toolCatalog: TOOL_CATALOG,
        trustedBroadeningEnabled: true,
        humanConfirmed: true,
      });
    }
    if (!resolution.accepted) throw new Error(resolution.reasons.join("; "));
    if (mutation && !resolution.policy.requireWorktree) {
      throw new Error("Mutation-capable subagents require an isolated writer worktree");
    }
    if (!mutation && resolution.policy.requireWorktree) {
      throw new Error("Isolated worktrees are reserved for mutation-capable profiles; read-only children share the verified checkout");
    }
    const reviewedSkills = await resolveProfileSkills(selectedProfile, harness, {
      cwd: context.cwd,
      agentDir: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
      commands: this.#pi.getCommands(),
    });
    const childTools = resolution.policy.tools.map((tool) => tool.name);
    const soft = resolveSoftCapabilities(selectedProfile, {
      tools: childTools,
      skills: reviewedSkills.names,
      reviewedExternalResearchTools: childTools.filter((name) => REVIEWED_RESEARCH_TOOLS.has(name)),
    });
    if (soft.research.state === "blocked") return unavailable([...reviewedSkills.diagnostics, ...soft.diagnostics].map((item) => item.message).join("; "), "blocked");
    return { profile: selectedProfile, policy: resolution.policy, reviewedSkills };
  }

  start(toolCallId: string, input: StartToolInput, signal?: AbortSignal): Promise<StartToolResult> {
    return this.#startGate.run(toolCallId, () => this.#topology.run(() => this.#startLocked(input, signal)));
  }

  async #occupiedRunningSlots(client: HerdrClient, signal?: AbortSignal): Promise<number> {
    const active = [...this.#runs.values()].filter((run) => run.lifecycle === "starting" || run.lifecycle === "running" || run.lifecycle === "interrupting" || run.lifecycle === "stopping").length;
    const failedTerminals = new Set(
      [...this.#runs.values()]
        .filter((run) => run.lifecycle === "failed")
        .map((run) => run.target?.terminalId ?? run.journal.resources.terminalId)
        .filter((terminalId): terminalId is string => terminalId !== undefined),
    );
    if (failedTerminals.size === 0) return active;
    const snapshot = await client.snapshot(signal);
    let retainedFailed = 0;
    for (const terminalId of failedTerminals) {
      // A failed returned child remains capacity-occupying while either side of
      // its fresh topology identity exists. Only proven pane+agent absence frees it.
      if (snapshot.panes.some((pane) => pane.terminal_id === terminalId)
        || snapshot.agents.some((agent) => agent.terminal_id === terminalId)) retainedFailed += 1;
    }
    return active + retainedFailed;
  }

  async #startLocked(input: StartToolInput, signal?: AbortSignal): Promise<StartToolResult> {
    const ready = this.#ready();
    if ("ok" in ready) return ready;
    const occupiedSlots = await this.#occupiedRunningSlots(ready.client, signal);
    if (occupiedSlots >= ready.settings.concurrency.maxRunning) return unavailable(`Configured maxRunning=${ready.settings.concurrency.maxRunning} is reached`, "blocked");
    const discovered = this.#profiles.get(input.profile);
    if (!discovered) throw new Error(`Unknown or disabled subagent profile: ${input.profile}`);
    const resolved = await this.#resolvePolicy(input, discovered, ready.context, ready.settings);
    if ("ok" in resolved) return resolved;
    const { profile, policy: parentPolicy, reviewedSkills } = resolved;
    const runId = safeRunId();
    await this.#validateArtifactPlan(ready.context.cwd, profile, runId, parentPolicy.harness);
    const runNonce = randomUUID();
    const parent = sessionIdentity(ready.context);
    const branchEntryId = ready.context.sessionManager.getLeafId();
    if (!branchEntryId) throw new Error("A current parent Pi branch entry is required before creating subagent resources");
    const journal = new ActiveBranchOwnershipJournal(this.#pi);
    let journalState = journal.begin({
      runId,
      runNonce,
      branchEntryId,
      sessionId: parent.sessionId,
      ...(parent.sessionPath === undefined ? {} : { sessionPath: parent.sessionPath }),
      intended: { workspaceId: ready.preflight.pane.workspace_id, group: "default", worktreeRequested: parentPolicy.requireWorktree },
    });
    const createdAt = Date.now();
    const managed: ManagedRun = {
      id: runId,
      runNonce,
      profile,
      taskSynopsis: synopsis(input.task),
      assignment: input.task,
      createdAt,
      updatedAt: createdAt,
      lifecycle: "starting",
      herdrStatus: "unknown",
      policy: parentPolicy,
      parentBranchEntryId: branchEntryId,
      reviewedSkills,
      journal: journalState,
      lastOutput: EMPTY_OUTPUT,
    };
    this.#runs.set(runId, managed);

    let policy = parentPolicy;
    let group: DelegationGroup;
    let artifacts: RunArtifacts;
    let worktree: WorktreeRecord | undefined;
    try {
      // Mandatory adapter/executable/capability validation before topology creation.
      // Its private launch files are outside durable run storage and always removed.
      const validationRuntime = await this.#createEphemeralRuntime(`${runId}-validation`, policy.harness);
      try {
        await prepareHarnessLaunch({
          policy,
          profile,
          sessionId: randomUUID(),
          sessionName: `sub-${runId}`,
          ...(validationRuntime.sessionDirectory === undefined ? {} : { sessionDirectory: validationRuntime.sessionDirectory }),
          systemPromptPath: validationRuntime.systemPrompt,
          reviewedSkillPaths: reviewedSkills.paths,
          metadata: { runId, runNonce, profileName: profile.name, parentSessionId: parent.sessionId, ...(parent.sessionPath === undefined ? {} : { parentSessionPath: parent.sessionPath }) },
        });
      } finally {
        await removeEphemeralRuntimeFiles(`${runId}-validation`, policy.harness, validationRuntime);
      }

      if (policy.requireWorktree) {
        const container = join(dirname(ready.context.cwd), ".herdr-subagents-worktrees");
        await mkdir(container, { recursive: true });
        const requestedPath = join(container, runId);
        const values = { id: runId, profile: profile.name, harness: policy.harness } as const;
        const handoffPath = precomputedWorktreeArtifactPath(requestedPath, profile.artifacts?.handoff ?? ".subagents/runs/{id}/handoff.md", values);
        const artifactWriter = profile.artifacts?.writer ?? "parent";
        const cleanupHandoffPath = artifactWriter === "child" ? parentHandoffWrapperPath(handoffPath) : handoffPath;
        const progressPath = profile.artifacts?.progress === undefined
          ? undefined
          : precomputedWorktreeArtifactPath(requestedPath, profile.artifacts.progress, values);
        worktree = await ready.worktreeManager.createForWriter({
          id: runId,
          owner: { runId, runNonce, parent: { sessionId: parent.sessionId, ...(parent.sessionPath === undefined ? {} : { sessionPath: parent.sessionPath }), branchEntryId } },
          source: { workspace_id: ready.preflight.pane.workspace_id },
          group: "default",
          path: requestedPath,
          artifacts: [
            { kind: "handoff", sourcePath: cleanupHandoffPath, writer: "parent", required: true },
            ...(progressPath === undefined ? [] : [{ kind: "progress" as const, sourcePath: progressPath, writer: artifactWriter, required: false }]),
          ],
          ...(signal === undefined ? {} : { signal }),
          onWorktreeCreated: (record) => {
            journalState = journal.append(journalState, "worktree_created", {
              repositoryId: record.repositoryId,
              commonGitDir: record.commonGitDir,
              herdrRepositoryKey: record.herdrRepositoryKey,
              ...(record.sourceWorkspaceId === undefined ? {} : { worktreeSourceWorkspaceId: record.sourceWorkspaceId }),
              worktreeWorkspaceId: record.workspaceId,
              checkoutPath: record.checkoutPath,
              worktreeBranch: record.branch,
              worktreeBase: record.base,
              worktreeInitialTabId: record.createdRoot.tabId,
              worktreeInitialRootPaneId: record.createdRoot.rootPaneId,
              worktreeInitialRootTerminalId: record.createdRoot.rootTerminalId,
            });
            managed.journal = journalState;
          },
          onGroupReady: (record) => {
            if (!record.tab) throw new Error("Writer worktree group identity is missing");
            journalState = journal.append(journalState, "created", {
              tabId: record.tab.tabId,
              rootPaneId: record.tab.rootPaneId,
              rootTerminalId: record.tab.rootTerminalId,
              rootProcessBaseline: record.tab.rootProcessBaseline,
            });
            managed.journal = journalState;
          },
        });
        if (!worktree.tab) throw new Error("Writer worktree did not produce a dedicated delegation tab");
        group = { key: `${worktree.workspaceId}\0default`, workspaceId: worktree.workspaceId, group: "default", tabId: worktree.tab.tabId, rootPaneId: worktree.tab.rootPaneId, rootTerminalId: worktree.tab.rootTerminalId, rootProcessBaseline: worktree.tab.rootProcessBaseline };
        policy = { ...policy, cwd: worktree.checkoutPath, trustedRoots: [worktree.checkoutPath] };
        managed.worktreeId = worktree.id;
      } else {
        group = await ready.groups.ensure(ready.preflight.pane.workspace_id, "default", signal, (created) => {
          journalState = journal.append(journalState, "created", { tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id });
          managed.journal = journalState;
        });
        journalState = journal.append(journalState, "created", journalState.phase === "intent"
          ? { tabId: group.tabId, rootPaneId: group.rootPaneId, rootTerminalId: group.rootTerminalId, rootProcessBaseline: group.rootProcessBaseline }
          : { rootProcessBaseline: group.rootProcessBaseline });
        managed.journal = journalState;
      }
      managed.group = group;
      artifacts = await this.#artifacts(policy.cwd, profile, runId, policy.harness, ready.context.cwd);
      managed.artifacts = artifacts;
      const instructions = assembleChildInstructions({ profile, task: input.task, artifacts: artifacts.contracts, cwd: policy.cwd, runId, parentSessionId: parent.sessionId });
      managed.ephemeral = await this.#createEphemeralRuntime(runId, policy.harness);
      const prepared = await prepareHarnessLaunch({
        policy,
        profile,
        sessionId: randomUUID(),
        sessionName: `sub-${runId}`,
        ...(managed.ephemeral.sessionDirectory === undefined ? {} : { sessionDirectory: managed.ephemeral.sessionDirectory }),
        systemPromptPath: managed.ephemeral.systemPrompt,
        reviewedSkillPaths: reviewedSkills.paths,
        metadata: { runId, runNonce, profileName: profile.name, parentSessionId: parent.sessionId, ...(parent.sessionPath === undefined ? {} : { parentSessionPath: parent.sessionPath }) },
      });
      const authorization = this.#authorization(runId, runNonce);
      const started = await startSubagent({
        client: ready.client,
        prepared,
        workspaceId: group.workspaceId,
        tabId: group.tabId,
        instructions,
        authorization,
        recordStarted: async (agent) => {
          journalState = journal.append(journalState, "started", {
            paneId: agent.pane_id,
            terminalId: agent.terminal_id,
            ...(agent.agent_session ? { nativeSession: { kind: agent.agent_session.kind, value: agent.agent_session.value, source: agent.agent_session.source } } : {}),
          });
          managed.journal = journalState;
          await writeArtifactAtomic(artifacts.paths.metadata!, `${JSON.stringify(runtimeMetadata(managed, agent.terminal_id), null, 2)}\n`, artifacts.metadataRoots, { mode: 0o600, replace: true });
        },
        recordReady: async (agent) => {
          if (journalState.resources.nativeSession === undefined && agent.agent_session) {
            journalState = journal.append(journalState, "started", { nativeSession: { kind: agent.agent_session.kind, value: agent.agent_session.value, source: agent.agent_session.source } });
            managed.journal = journalState;
          }
          await writeArtifactAtomic(artifacts.paths.metadata!, `${JSON.stringify(runtimeMetadata(managed, agent.terminal_id), null, 2)}\n`, artifacts.metadataRoots, { mode: 0o600, replace: true });
        },
        ...(profile.timeout === undefined ? {} : { startupTimeoutMs: profile.timeout }),
        ...(signal === undefined ? {} : { signal }),
      });
      // Writer worktree cleanup verifies both the worktree's creation anchor
      // and the dedicated group anchor before removing the whole workspace.
      // Keep that group tab intact on pane stop; non-worktree groups may close
      // their verified anchor-only tab immediately.
      const target: OwnedRunTarget = worktree ? { ...started.target } : { ...started.target, group };
      managed.target = target;
      managed.lifecycle = "running";
      managed.herdrStatus = started.agent.agent_status;
      managed.updatedAt = Date.now();
      managed.lastOutput = started.output;
      managed.policy = policy;
      await this.#persistMetadata(managed);
      if (worktree && target.nativeSession) ready.worktrees.bindWriter(worktree.id, { terminalId: target.terminalId, nativeSession: target.nativeSession });
      this.#subscriptions?.ownershipChanged(); this.#notifyUi();
      return {
        ok: true,
        status: started.started ? "started" : "blocked",
        run: await this.#summary(managed),
        effective: {
          harness: policy.harness,
          ...(policy.model === undefined ? {} : { model: policy.model }),
          thinking: policy.thinking,
          cwd: policy.cwd,
          tools: policy.tools.map((tool) => tool.name),
          skills: reviewedSkills.names,
          skillDiagnostics: reviewedSkills.diagnostics.map((item) => item.message),
          permissions: policy.permissions,
          isolatedWorktree: policy.requireWorktree,
          broadeningReasons: policy.broadeningReasons,
        },
        output: started.output,
        ...(started.started ? {} : { reason: started.reason }),
      };
    } catch (error) {
      managed.lifecycle = "failed";
      managed.herdrStatus = "unknown";
      managed.updatedAt = Date.now();
      managed.failure = error instanceof Error ? error.message : String(error);
      const terminalRecorded = managed.journal.resources.terminalId !== undefined;
      const provenGone = error instanceof StartCleanupError && error.cleanup !== "retained";
      if (!terminalRecorded || provenGone) {
        await this.#removeEphemeral(managed).catch(() => undefined);
        await this.#persistMetadata(managed).catch(() => undefined);
      }
      try {
        if (journalState.phase !== "failed") {
          journalState = journal.append(journalState, "failed", {});
          managed.journal = journalState;
        }
      } catch { /* Preserve the last valid write-ahead state. */ }
      if (isUnavailableError(error)) return unavailable(managed.failure);
      throw error;
    }
  }

  async #ownership(run: ManagedRun, snapshot = this.#preflight?.snapshot): Promise<RunSummary["ownership"]> {
    if (run.lifecycle === "stopped") return "current_session";
    if (!snapshot || !this.#context) return "uncertain";
    const active = recoverActiveBranchOwnership(currentBranch(this.#context));
    const metadata = run.target ? { runId: run.id, runNonce: run.runNonce, terminalId: run.target.terminalId, ...(run.target.nativeSession === undefined ? {} : { nativeSession: run.target.nativeSession }) } : undefined;
    const result = reconcileOwnership({ runId: run.id, active, snapshot, currentParent: sessionIdentity(this.#context), ...(metadata === undefined ? {} : { metadata }) });
    if (result.state === "owned") return "current_session";
    if (result.state === "orphaned" && result.reason.includes("different parent Pi session")) return "other_session";
    return result.state;
  }

  async #summary(run: ManagedRun, snapshot?: Awaited<ReturnType<HerdrClient["snapshot"]>>): Promise<RunSummary> {
    const current = snapshot ?? (this.#client ? await this.#client.snapshot() : undefined);
    const pane = run.target && current ? current.panes.find((candidate) => candidate.terminal_id === run.target!.terminalId) : undefined;
    const agent = run.target && current ? current.agents.find((candidate) => candidate.terminal_id === run.target!.terminalId) : undefined;
    if (agent) { run.herdrStatus = agent.agent_status; run.updatedAt = Date.now(); }
    const ownership = await this.#ownership(run, current);
    const worktree = run.worktreeId ? this.#worktrees?.getState(run.worktreeId) : undefined;
    return {
      id: run.id,
      profile: run.profile.name,
      harness: run.policy.harness,
      lifecycle: ownership === "orphaned" && run.lifecycle === "running" ? "lost" : run.lifecycle,
      herdrStatus: agent?.agent_status ?? run.herdrStatus,
      ownership,
      live: pane !== undefined && agent !== undefined,
      elapsedMs: Math.max(0, Date.now() - run.createdAt),
      taskSynopsis: run.taskSynopsis,
      ...(run.target === undefined ? {} : { terminalId: run.target.terminalId }),
      ...(pane === undefined ? {} : { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id, focused: pane.focused }),
      ...(agent === undefined ? {} : {
        agentRevision: agent.revision,
        ...(typeof agent.custom_status === "string" && agent.custom_status.length > 0 ? { customStatus: agent.custom_status } : {}),
      }),
      ...(worktree === undefined ? {} : { worktree }),
    };
  }

  async list(input: ListToolInput): Promise<ListToolResult> {
    const scope = input.scope ?? "current_session";
    const context = this.#context;
    if (!context) return unavailable(this.#startupIssue ?? "Subagent session runtime has not started");
    let snapshot: SessionSnapshot | undefined;
    try { snapshot = this.#client ? await this.#client.snapshot() : undefined; }
    catch (error) { if (!isUnavailableError(error)) throw error; }
    const summaries = await Promise.all([...this.#runs.values()].map((run) => this.#summary(run, snapshot)));
    let runs = scope === "current_session" ? summaries.filter((run) => run.ownership === "current_session") : summaries;
    if (scope === "all_owned" || scope === "global") runs = [...runs, ...[...this.#observational.values()].map((item) => item.summary)];
    if (scope === "project") runs = runs.filter((run) => {
      const managed = this.#runs.get(run.id);
      return managed ? isWithin(resolve(context.cwd), resolve(managed.policy.cwd)) : false;
    });
    if (scope === "global" && snapshot) {
      const known = new Set(runs.map((run) => run.terminalId).filter(Boolean));
      for (const agent of snapshot.agents) {
        if (known.has(agent.terminal_id)) continue;
        runs.push({
          id: `global:${agent.terminal_id}`,
          profile: "observational",
          harness: ["pi", "claude", "codex"].includes(String(agent.agent)) ? agent.agent as Harness : "pi",
          lifecycle: "running",
          herdrStatus: agent.agent_status,
          ownership: "observational",
          live: true,
          elapsedMs: 0,
          taskSynopsis: "Global backend agent; not owned by this extension session",
          agentRevision: agent.revision,
          ...(typeof agent.custom_status === "string" && agent.custom_status.length > 0 ? { customStatus: agent.custom_status } : {}),
          focused: agent.focused,
          terminalId: agent.terminal_id,
          paneId: agent.pane_id,
          tabId: agent.tab_id,
          workspaceId: agent.workspace_id,
        });
      }
    }
    runs.sort((left, right) => left.id.localeCompare(right.id));
    const counts: Record<string, number> = {};
    for (const run of runs) {
      const key = run.lifecycle === "running" ? run.herdrStatus : run.lifecycle;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return { ok: true, scope, runs, counts };
  }

  async inspectUi(scope: DashboardScope, id: string): Promise<UiRunDetails> {
    const listed = await this.list({ scope });
    if (!listed.ok) throw new Error(listed.reason);
    const summary = listed.runs.find((candidate) => candidate.id === id);
    if (!summary) throw new Error(`Run ${id} is no longer visible in ${scope} scope`);
    let output: BoundedOutput | undefined;
    if (summary.terminalId && summary.live && this.#client) {
      const snapshot = await this.#client.snapshot();
      const pane = snapshot.panes.find((candidate) => candidate.terminal_id === summary.terminalId);
      const agent = snapshot.agents.find((candidate) => candidate.terminal_id === summary.terminalId);
      if (pane && agent && pane.pane_id === agent.pane_id && pane.tab_id === agent.tab_id && pane.workspace_id === agent.workspace_id) {
        const read = await this.#client.readAgent(summary.terminalId, { source: "recent_unwrapped", lines: 12, strip_ansi: true, format: "text" });
        output = boundRecentOutput(read.text, read.truncated, read.revision);
      }
    }
    const managed = this.#runs.get(id);
    if (!output && managed) output = managed.lastOutput;
    return {
      run: { ...summary, ...(output === undefined ? {} : { outputRevision: output.revision }), changedOutput: false },
      ...(output === undefined ? {} : { output }),
      ...(managed?.artifacts === undefined ? {} : { artifacts: managed.artifacts.paths }),
    };
  }

  async listUi(input: ListToolInput): Promise<ListToolResult> {
    const listed = await this.list(input);
    if (!listed.ok || !this.#client) return listed;
    const runs = await Promise.all(listed.runs.map(async (summary): Promise<RunSummary> => {
      if (!summary.live || !summary.terminalId) return summary;
      try {
        const read = await this.#client!.readAgent(summary.terminalId, { source: "recent_unwrapped", lines: 1, strip_ansi: true, format: "text" });
        return { ...summary, outputRevision: read.revision };
      } catch (error) {
        if (!isUnavailableError(error)) throw error;
        return summary;
      }
    }));
    return { ...listed, runs };
  }

  async doctor(): Promise<DoctorReport> {
    const context = this.#context;
    if (!context) throw new Error("Subagent session runtime has not started");
    const runtimeEvidence = [...this.#runs.values()].flatMap((run) => run.target ? [{
      runId: run.id,
      runNonce: run.runNonce,
      terminalId: run.target.terminalId,
      ...(run.target.nativeSession === undefined ? {} : { nativeSession: run.target.nativeSession }),
    }] : []);
    return createDoctorReport({
      context,
      environment: this.#environment,
      activeTools: this.#pi.getAllTools().map((tool) => tool.name),
      runtimeEvidence,
      worktrees: this.#worktrees?.listStates() ?? [],
      ...(this.#client === undefined ? {} : { client: this.#client }),
      ...(this.#startupIssue === undefined ? {} : { startupIssue: this.#startupIssue }),
    });
  }

  #managed(id: string): ManagedRun {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Unknown subagent run: ${id}`);
    return run;
  }

  #ownedTarget(run: ManagedRun): OwnedRunTarget {
    if (!run.target) throw new Error(`Run ${run.id} has no identity-verified live terminal`);
    return run.target;
  }

  async get(input: GetToolInput, signal?: AbortSignal): Promise<GetToolResult> {
    const run = this.#managed(input.id);
    let output = run.lastOutput;
    if (run.target && run.lifecycle !== "stopped") {
      try { output = await readBoundedOutput(this.#client!, this.#ownedTarget(run), signal); }
      catch (error) { if (isUnavailableError(error)) return unavailable(error instanceof Error ? error.message : String(error)); throw error; }
      run.lastOutput = output;
    }
    output = limitOutputLines(output, input.lines ?? 160);
    const summary = await this.#summary(run);
    const parent = sessionIdentity(this.#context!);
    return {
      ok: true,
      run: summary,
      effectiveProfile: {
        source: run.profile.source.path,
        description: run.profile.description,
        harness: run.policy.harness,
        ...(run.policy.model === undefined ? {} : { model: run.policy.model }),
        thinking: run.policy.thinking,
        cwd: run.policy.cwd,
        tools: run.policy.tools.map((tool) => tool.name),
        skills: run.reviewedSkills.names,
      },
      ownership: {
        runNonce: run.runNonce,
        parentSessionId: parent.sessionId,
        ...(parent.sessionPath === undefined ? {} : { parentSessionPath: parent.sessionPath }),
        branchEntryId: run.parentBranchEntryId,
        ...(run.target === undefined ? {} : { terminalId: run.target.terminalId }),
        ...(run.target?.nativeSession === undefined ? {} : { nativeSession: run.target.nativeSession }),
      },
      topology: { ...(summary.workspaceId === undefined ? {} : { workspaceId: summary.workspaceId }), ...(summary.tabId === undefined ? {} : { tabId: summary.tabId }), ...(summary.paneId === undefined ? {} : { paneId: summary.paneId }) },
      output,
      artifacts: run.artifacts ? run.artifacts.paths : {},
      runtime: {
        ephemeralFiles: run.ephemeral === undefined ? "removed" : "retained",
        piSessionData: run.policy.harness !== "pi"
          ? "not-applicable"
          : run.ephemeral?.sessionDirectory === undefined ? "removed" : "retained",
      },
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  async focusUi(id: string, signal?: AbortSignal): Promise<{ ok: boolean; reason?: string; attentionChanged?: boolean }> {
    const ready = this.#ready();
    if ("ok" in ready) return { ok: false, reason: ready.reason };
    let run: ManagedRun;
    try { run = this.#managed(id); }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    try {
      const target = this.#ownedTarget(run);
      // Mutation boundary: terminal/native identity and active Pi branch are
      // resolved from a fresh snapshot immediately before terminal-preferred focus.
      const focused = await focusOwnedPaneFresh(ready.client, target, signal);
      if (focused.after) { run.herdrStatus = focused.after.agent_status; run.updatedAt = Date.now(); }
      this.#notifyUi();
      return { ok: true, attentionChanged: focused.before.agent.agent_status === "done" && focused.after?.agent_status === "idle" };
    } catch (error) {
      return { ok: false, reason: `Focus failed without changing ownership: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async send(input: SendToolInput, signal?: AbortSignal): Promise<ActionToolResult> {
    const ready = this.#ready(); if ("ok" in ready) return ready;
    const run = this.#managed(input.id);
    try {
      const result = await sendToSubagent({ client: ready.client, target: this.#ownedTarget(run), message: input.message, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), ...(signal === undefined ? {} : { signal }) });
      run.herdrStatus = result.state; run.lastOutput = result.output; run.updatedAt = Date.now();
      await this.#persistMetadata(run); this.#notifyUi();
      return { ok: true, action: "send", run: await this.#summary(run), result };
    } catch (error) { if (isUnavailableError(error)) return unavailable(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async #captureHandoff(run: ManagedRun): Promise<string | undefined> {
    if (!run.artifacts || run.assignment === undefined) return undefined;
    const materialized = await materializeHandoff({
      profile: run.profile,
      effectiveMutationCapable: run.policy.permissions.mutation,
      handoffPath: run.artifacts.paths.handoff!,
      roots: run.artifacts.roots,
      finalOutput: run.lastOutput.text,
      assignment: run.assignment,
    });
    return materialized.path;
  }

  async wait(input: WaitToolInput, signal?: AbortSignal): Promise<ActionToolResult> {
    const ready = this.#ready(); if ("ok" in ready) return ready;
    const run = this.#managed(input.id);
    try {
      const result = await waitForSubagent({ client: ready.client, target: this.#ownedTarget(run), states: input.states ?? ["done", "idle", "blocked"], timeoutMs: input.timeoutMs ?? run.profile.timeout ?? 900_000, ...(signal === undefined ? {} : { signal }) });
      run.herdrStatus = result.state; run.lastOutput = result.output; run.updatedAt = Date.now();
      await this.#persistMetadata(run);
      this.#notifyUi();
      return { ok: true, action: "wait", run: await this.#summary(run), result };
    } catch (error) { if (isUnavailableError(error)) return unavailable(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async interrupt(input: InterruptToolInput, signal?: AbortSignal): Promise<ActionToolResult> {
    const ready = this.#ready(); if ("ok" in ready) return ready;
    const run = this.#managed(input.id); run.lifecycle = "interrupting";
    try {
      const result = await interruptSubagent({ client: ready.client, target: this.#ownedTarget(run), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), ...(signal === undefined ? {} : { signal }) });
      run.lifecycle = "running"; run.herdrStatus = result.state; run.lastOutput = result.output; run.updatedAt = Date.now();
      await this.#persistMetadata(run); this.#notifyUi();
      return { ok: true, action: "interrupt", run: await this.#summary(run), result };
    } catch (error) { run.lifecycle = "running"; if (isUnavailableError(error)) return unavailable(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async stop(input: StopToolInput, signal?: AbortSignal): Promise<ActionToolResult> {
    return this.#topology.run(async () => {
      const ready = this.#ready(); if ("ok" in ready) return ready;
      const run = this.#managed(input.id); run.lifecycle = "stopping";
      let provenStopped = false;
      try {
        const result = await stopSubagent({ client: ready.client, target: this.#ownedTarget(run), ...(input.mode === undefined ? {} : { mode: input.mode }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), ...(signal === undefined ? {} : { signal }) });
        if (result.output.text.trim().length > 0) run.lastOutput = result.output;
        provenStopped = result.stopped;
        if (result.tabClosed && !run.worktreeId && run.group) {
          const cached = ready.groups.get(run.group.workspaceId, run.group.group);
          if (cached) ready.groups.forgetClosed(run.group);
        }
        run.lifecycle = result.stopped ? "stopped" : "running";
        run.herdrStatus = result.stopped ? "unknown" : run.herdrStatus;
        run.updatedAt = Date.now();
        const finalHandoffPath = result.stopped ? await this.#captureHandoff(run) : undefined;
        if (result.stopped && finalHandoffPath !== undefined) {
          // Keep the assignment and original child path retryable until both the
          // ephemeral deletion revalidation and final metadata rewrite succeed.
          await this.#removeEphemeral(run);
          const assignment = run.assignment!;
          const priorPaths = run.artifacts!.paths;
          run.artifacts!.paths = { ...priorPaths, handoff: finalHandoffPath };
          delete run.assignment;
          try {
            await this.#persistMetadata(run);
          } catch (error) {
            run.assignment = assignment;
            run.artifacts!.paths = priorPaths;
            throw error;
          }
        } else if (result.stopped) {
          await this.#persistMetadata(run);
        }
        let cleanup: unknown;
        if (run.worktreeId) {
          const record = ready.worktrees.get(run.worktreeId);
          if (!record) throw new Error(`Worktree state for ${run.worktreeId} is unavailable`);
          if (input.cleanup === "remove_if_safe" && input.parentReview) ready.worktrees.setParentReviewed(record.id, input.parentReview);
          const integration = this.#integration(input);
          // Cleanup is a separate destructive boundary. Re-read the active branch
          // and live terminal identity immediately before handing authority to the
          // worktree cleanup manager (the child may already have exited).
          await revalidateRecordedOwnershipFresh(ready.client, this.#ownedTarget(run), signal);
          const parentRoots = await resolveArtifactRoots({ checkout: record.sourceCheckoutPath, allowProgress: false });
          const sourceRoots = await resolveArtifactRoots({ checkout: record.checkoutPath, allowProgress: record.artifactPaths.some((artifact) => isWithin(join(record.checkoutPath, ".progress"), artifact.absolutePath)) });
          const cleanupResult = await ready.worktreeCleanup.cleanup({
            id: record.id,
            cleanup: input.cleanup ?? "retain",
            ownership: { runId: record.owner.runId, runNonce: record.owner.runNonce, parent: record.owner.parent, activeBranchState: "owned" },
            artifactCapture: { artifacts: record.artifactPaths.map((artifact) => ({ kind: artifact.kind, sourcePath: artifact.absolutePath, required: artifact.required })), sourceRoots, parentRoots, runId: record.id },
            parentRoots,
            ...(integration === undefined ? {} : { integrationEvidence: integration }),
            revalidateOwnership: () => revalidateRecordedOwnershipFresh(ready.client, this.#ownedTarget(run), signal).then(() => undefined),
            ...(signal === undefined ? {} : { signal }),
          });
          cleanup = cleanupResult;
          if (cleanupResult.removed && run.artifacts) {
            const handoff = cleanupResult.record.capturedArtifacts.find((artifact) => artifact.kind === "handoff")?.absolutePath;
            const progress = cleanupResult.record.capturedArtifacts.find((artifact) => artifact.kind === "progress")?.absolutePath;
            if (handoff !== undefined) {
              run.artifacts.paths = {
                handoff,
                metadata: run.artifacts.paths.metadata!,
                ...(progress === undefined ? {} : { progress }),
              };
              await this.#persistMetadata(run);
            }
          }
        } else if (input.cleanup === "remove_if_safe") {
          cleanup = { removed: false, retained: true, reason: "Run has no writer worktree; pane stop never deletes checkout artifacts" };
        }
        this.#subscriptions?.ownershipChanged(); this.#notifyUi();
        return { ok: true, action: "stop", run: await this.#summary(run), result, ...(cleanup === undefined ? {} : { cleanup }) };
      } catch (error) {
        run.lifecycle = provenStopped ? "stopped" : "running";
        if (isUnavailableError(error)) return unavailable(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }

  #integration(input: StopToolInput): IntegrationVerificationRequest | undefined {
    const value = input.integration;
    if (!value) return undefined;
    if (value.kind === "no_changes") {
      if (value.parentCheckoutPath !== undefined || value.parentRef !== undefined) throw new Error("no_changes integration evidence does not accept parentCheckoutPath/parentRef");
      return { kind: "no_changes" };
    }
    if (!value.parentCheckoutPath) throw new Error(`${value.kind} integration evidence requires parentCheckoutPath`);
    return { kind: value.kind, parentCheckoutPath: value.parentCheckoutPath, ...(value.parentRef === undefined ? {} : { parentRef: value.parentRef }) };
  }
}
