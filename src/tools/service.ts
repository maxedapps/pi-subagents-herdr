import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { purgeRuntimeRunArtifacts } from "../artifacts/purge.ts";
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
import { createDoctorReport, type DoctorReport } from "../doctor/report.ts";
import {
  boundRecentOutput,
  FocusOutcomeUncertainError,
  focusOwnedPaneFresh,
  readBoundedOutput,
  revalidateRecordedOwnershipFresh,
  type BoundedOutput,
  type OwnedRunTarget,
  type RuntimeOwnershipAuthorization,
} from "../runtime/control.ts";
import { createEphemeralRuntimeFiles, removeEphemeralRuntimeFiles, type EphemeralRuntimeFiles } from "../runtime/ephemeral.ts";
import { DelegationGroupManager, verifyIdleShell, type DelegationGroup } from "../runtime/groups.ts";
import { cleanupPartialStart } from "../runtime/reconcile.ts";
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
import {
  assertRuntimeFilesMatchMetadata,
  assertRuntimeMetadataMatchesJournal,
  readRuntimeRunMetadata,
  listRuntimeRunMetadata,
  type RuntimeRunMetadata,
} from "../runtime/metadata.ts";
import { PlacementStartExhaustedError, StartCleanupError, TurnSubmissionUncertainError, startSubagent } from "../runtime/start.ts";
import { closeDedicatedTabIfSafe, stopSubagent, type StopSubagentResult } from "../runtime/stop.ts";
import { waitForSubagent } from "../runtime/wait.ts";
import { toPublicResultView, type GenerationSummary, type PublicResultView, type ResultEnvelopeV1 } from "../results/contracts.ts";
import { ACTION_NOTICE_CUSTOM_TYPE, ACTION_NOTICE_SENTINEL, ActionNoticeService, deriveRunAttention, findPersistedActionNotice, formatActionNotice, toPublicRunAttention, type ActionKind, type RunAttention } from "../results/action-notices.ts";
import { ResultCoordinator } from "../results/coordinator.ts";
import { ResultDeliveryService } from "../results/delivery.ts";
import { boundUtf8HeadTail } from "../results/presentation.ts";
import { installResultServices, toCoordinatorView } from "../results/service-bridge.ts";
import { listResultEnvelopes, readResultEnvelope } from "../results/store.ts";
import type { WorktreeRecord } from "../worktrees/contracts.ts";
import { inspectWriterWorktree } from "../worktrees/inspection.ts";
import { WorktreeCleanupManager, type IntegrationVerificationRequest } from "../worktrees/cleanup.ts";
import { WorktreeManager, WorktreeRegistry } from "../worktrees/manager.ts";
import { identifyCheckout } from "../worktrees/writer-locks.ts";
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
const execFileAsync = promisify(execFile);
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
  journal: OwnershipJournalData;
  target?: OwnedRunTarget;
  group?: DelegationGroup;
  groupCreatedByRun?: boolean;
  artifacts?: RunArtifacts;
  ephemeral?: EphemeralRuntimeFiles;
  worktreeId?: string;
  lastOutput: BoundedOutput;
  nextGeneration: number;
  activeGeneration?: GenerationSummary;
  schemaVersion: 5;
  latestResult?: PublicResultView;
  attention?: RunAttention;
  failure?: string;
}

export interface SessionToolRuntime {
  start(context: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  /** Notify delivery that the parent agent run has settled (queue-drain boundary). */
  noteParentSettled?(): void;
  /** Reconcile parent-persisted custom messages after message_end returns. */
  reconcileResultPersistence?(): Promise<void>;
}

export interface ToolRuntimeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function statusCall(runId: string): string { return `subagent_status({ id: ${JSON.stringify(runId)} })`; }
function stopCall(runId: string): string { return `subagent_stop({ id: ${JSON.stringify(runId)} })`; }

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

function runtimeMetadata(run: ManagedRun, terminalId: string, nativeSession = run.journal.resources.nativeSession, worktree?: WorktreeRecord): RuntimeRunMetadata {
  if (!run.artifacts) throw new Error("Run artifacts must exist before runtime metadata is persisted");
  return {
    schemaVersion: 5,
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
    lifecycle: run.lifecycle,
    createdAt: run.createdAt,
    policy: {
      thinking: run.policy.thinking,
      cwd: run.policy.cwd,
      tools: run.policy.tools.map((tool) => tool.name),
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
          ...(run.ephemeral.resultExchangeDirectory === undefined ? {} : { resultExchangeDirectory: run.ephemeral.resultExchangeDirectory }),
        },
    generation: {
      nextGeneration: run.nextGeneration,
      ...(run.activeGeneration === undefined ? {} : { active: run.activeGeneration }),
      bridgeAvailable: run.policy.harness === "pi" && run.ephemeral?.resultExchangeDirectory !== undefined,
    },
    ...(run.attention === undefined ? {} : { attention: run.attention }),
    ...(worktree === undefined ? {} : { worktree }),
    ownershipJournal: run.journal,
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
  #coordinator: ResultCoordinator | undefined;
  #delivery: ResultDeliveryService | undefined;
  #notices: ActionNoticeService | undefined;
  #runtimeEpoch = randomUUID();
  #startupReconciling = false;
  readonly #uiListeners = new Set<() => void>();

  constructor(pi: ExtensionAPI, options: ToolRuntimeOptions = {}) {
    this.#pi = pi;
    this.#environment = options.environment ?? process.env;
  }

  createSessionRuntime(): SessionToolRuntime {
    return {
      start: (context) => this.startSession(context),
      stop: () => this.stopSession(),
      noteParentSettled: () => this.noteParentSettled(),
      reconcileResultPersistence: () => this.reconcileResultPersistence(),
    };
  }

  noteParentSettled(): void {
    this.#delivery?.noteParentSettled();
    this.#notices?.noteParentSettled();
    this.#coordinator?.wake();
  }

  async reconcileResultPersistence(): Promise<void> {
    await this.#delivery?.reconcilePersistence();
    await this.#notices?.reconcilePersistence();
  }


  async startSession(context: ExtensionContext): Promise<void> {
    await this.stopSession();
    this.#context = context;
    this.#runs.clear();
    this.#observational.clear();
    this.#startupIssue = undefined;
    this.#runtimeEpoch = randomUUID();
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
      this.#installResultServices();
      await this.#recoverLiveRuns();
      const unresolvedRecovery = await this.#adoptCrossSessionCleanupJournals();
      for (const record of this.#worktrees.list().filter((candidate) => candidate.state === "removed" && candidate.finalization?.branchFinalizedAt !== undefined && candidate.finalization.runtimeArtifactsPurgedAt === undefined)) {
        try {
          const roots = await resolveArtifactRoots({ checkout: record.sourceCheckoutPath, allowProgress: false });
          await purgeRuntimeRunArtifacts(roots, record.id);
          this.#worktrees.markRuntimeArtifactsPurged(record.id);
        } catch { /* Exact unresolved purge remains visible in worktree state/recovery notices. */ }
      }
      this.#startupReconciling = true;
      try {
        for (const run of [...this.#runs.values()].filter((candidate) => candidate.lifecycle === "stopped")) {
          try { await this.stop({ id: run.id }); }
          catch (error) {
            await this.#setAttention(run, { kind: "recovery_required", reason: `Startup finalization retry failed: ${error instanceof Error ? error.message : String(error)}`, nextActions: [`Inspect ${statusCall(run.id)}, then retry ${stopCall(run.id)}`] }).catch(() => undefined);
          }
        }
      } finally { this.#startupReconciling = false; }
      const startupAttention = [...this.#runs.values()].flatMap((run) => run.attention === undefined || run.attention.delivery.stage === "parent_persisted" ? [] : [{ runId: run.id, reason: run.attention.reason, noticeId: run.attention.noticeId }]);
      const consolidatedRecovery = [...unresolvedRecovery, ...startupAttention];
      if (consolidatedRecovery.length > 0) this.#sendRecoverySummary(consolidatedRecovery);
      this.#subscriptions = new HerdrSubscriptionManager({
        client,
        ownedPaneIds: () => [...this.#runs.values()].flatMap((run) => run.journal.resources.paneId ? [run.journal.resources.paneId] : []),
        onChange: () => {
          this.#notifyUi();
          this.#coordinator?.wake();
          void Promise.all([...this.#runs.keys()].map((id) => this.#refreshAttention(id))).then(() => this.#notices?.scheduleFlush()).catch(() => undefined);
        },
      });
      await this.#subscriptions.start();
      this.#coordinator?.start();
      this.#delivery?.scheduleFlush(0);
      this.#notices?.scheduleFlush(consolidatedRecovery.length > 0 ? 250 : 0);
    } catch (error) {
      this.#startupIssue = error instanceof Error ? error.message : String(error);

      this.#client = undefined;
      this.#preflight = undefined;
    }
  }

  #installResultServices(): void {
    const installed = installResultServices({
      pi: this.#pi,
      runtimeEpoch: this.#runtimeEpoch,
      getContext: () => this.#context,
      getCheckout: () => this.#context?.cwd,
      listManagedRuns: () => this.#runs.values(),
      getManagedRun: (runId) => this.#runs.get(runId),
      persistRunMetadata: async (runId) => {
        const run = this.#runs.get(runId);
        if (run) await this.#persistMetadata(run);
      },
      refreshAttention: (runId) => this.#refreshAttention(runId),
      onResultStageAdvanced: (envelope) => { void this.#onResultStageAdvanced(envelope); },
      notifyUi: () => this.#notifyUi(),
    });
    this.#coordinator = installed.coordinator;
    this.#delivery = installed.delivery;
    this.#notices = new ActionNoticeService({
      pi: this.#pi,
      runtimeEpoch: this.#runtimeEpoch,
      getContext: () => this.#context,
      listQueued: async () => [...this.#runs.values()].flatMap((run) => run.attention === undefined ? [] : [{
        runId: run.id,
        runNonce: run.runNonce,
        attention: run.attention,
        parentSessionId: run.journal.parent.sessionId,
        ...(run.journal.parent.sessionPath === undefined ? {} : { parentSessionPath: run.journal.parent.sessionPath }),
        ...(run.target?.terminalId ?? run.journal.resources.terminalId ? { terminalId: run.target?.terminalId ?? run.journal.resources.terminalId } : {}),
        ...(run.target?.nativeSession ?? run.journal.resources.nativeSession ? { nativeSession: run.target?.nativeSession ?? run.journal.resources.nativeSession } : {}),
      }]),
      updateAttention: async (runId, update) => {
        const run = this.#runs.get(runId);
        if (!run?.attention) return undefined;
        run.attention = update(run.attention);
        await this.#persistMetadata(run).catch(() => undefined);
        if (run.attention.delivery.stage === "parent_persisted") await this.#finalizeStoppedReadOnly(run).catch(() => undefined);
        this.#notifyUi();
        return run.attention;
      },
    });
  }

  #resultHost() {
    return {
      pi: this.#pi,
      runtimeEpoch: this.#runtimeEpoch,
      getContext: () => this.#context,
      getCheckout: () => this.#context?.cwd,
      listManagedRuns: () => this.#runs.values(),
      getManagedRun: (runId: string) => this.#runs.get(runId),
      persistRunMetadata: async (runId: string) => {
        const run = this.#runs.get(runId);
        if (run) await this.#persistMetadata(run);
      },
      refreshAttention: (runId: string) => this.#refreshAttention(runId),
      onResultStageAdvanced: (envelope: ResultEnvelopeV1) => { void this.#onResultStageAdvanced(envelope); },
      notifyUi: () => this.#notifyUi(),
    };
  }

  async #setAttention(run: ManagedRun, input: { readonly kind: ActionKind; readonly reason: string; readonly nextActions: readonly string[]; readonly facts?: Parameters<typeof deriveRunAttention>[2]["facts"] }, schedule = true): Promise<void> {
    const next = deriveRunAttention(run.id, run.attention, {
      kind: input.kind,
      reason: input.reason,
      nextActions: input.nextActions,
      ...(input.facts === undefined ? {} : { facts: input.facts }),
    });
    if (next === run.attention) return;
    run.attention = next;
    await this.#persistMetadata(run).catch(() => undefined);
    this.#notifyUi();
    if (schedule && !this.#startupReconciling) this.#notices?.scheduleFlush();
  }

  async #refreshAttention(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return;
    const worktree = run.worktreeId ? this.#worktrees?.get(run.worktreeId) : undefined;
    if (worktree?.state === "removed") {
      if (run.attention) { delete run.attention; await this.#persistMetadata(run).catch(() => undefined); this.#notifyUi(); }
      return;
    }
    if (run.attention?.kind === "cleanup_required" || run.attention?.kind === "recovery_required") return;
    if (run.lifecycle === "failed" && run.attention?.kind === "failed") return;
    if (run.lifecycle === "failed") {
      await this.#setAttention(run, {
        kind: "failed",
        reason: run.failure ?? "Subagent failed before a clean terminal handoff",
        nextActions: [`Inspect ${statusCall(run.id)}`, `Retry ${stopCall(run.id)}; safe no-change cleanup is automatic when provable`],
        facts: { ...(worktree === undefined ? {} : { checkoutPath: worktree.checkoutPath, branch: worktree.branch, base: worktree.base, workspaceId: worktree.workspaceId }), ...(run.target?.terminalId === undefined ? {} : { terminalId: run.target.terminalId }) },
      }, false);
      return;
    }
    if (run.herdrStatus === "blocked") {
      await this.#setAttention(run, {
        kind: "blocked",
        reason: "Subagent is blocked and requires parent inspection or same-assignment follow-up",
        nextActions: [`Inspect ${statusCall(run.id)}`, `Resolve the blocker, then use subagent_send for the same assignment or ${stopCall(run.id)}`],
        ...(run.target?.terminalId === undefined ? {} : { facts: { terminalId: run.target.terminalId } }),
      }, false);
      return;
    }
    if (worktree && run.latestResult) {
      try {
        const facts = await inspectWriterWorktree(worktree);
        const evidence = facts.noChanges
          ? `Call ${stopCall(run.id)}; no_changes cleanup can be derived automatically`
          : `Review and integrate ${facts.branch}, then call ${stopCall(run.id)}; containment/current-tree proof is derived automatically or supply existing integration evidence`;
        await this.#setAttention(run, {
          kind: "writer_review_required",
          reason: facts.noChanges ? "Writer completed with no checkout changes and awaits finalization" : "Writer result is available and its checkout awaits parent review/integration/finalization",
          nextActions: [`Inspect the delivered result and diff for ${run.id}`, evidence],
          facts,
        }, false);
      } catch (error) {
        await this.#setAttention(run, {
          kind: "recovery_required",
          reason: `Writer facts could not be revalidated: ${error instanceof Error ? error.message : String(error)}`,
          nextActions: [`Inspect ${worktree.checkoutPath} and ${statusCall(run.id)}; do not delete it while identity is uncertain`],
          facts: { checkoutPath: worktree.checkoutPath, branch: worktree.branch, base: worktree.base, workspaceId: worktree.workspaceId },
        }, false);
      }
    }
  }

  async #finalizeStoppedReadOnly(run: ManagedRun): Promise<void> {
    if (run.lifecycle !== "stopped" || run.worktreeId || !run.artifacts) return;
    const evidencePersisted = run.latestResult?.deliveryStage === "parent_persisted" || run.attention?.delivery.stage === "parent_persisted";
    if (!evidencePersisted) return;
    await this.#removeEphemeral(run).catch(() => undefined);
    const roots = run.artifacts.metadataRoots;
    const preservePaths = run.profile.artifacts === undefined
      ? []
      : Object.entries(run.artifacts.paths).filter(([kind]) => kind !== "metadata").map(([, path]) => path);
    await purgeRuntimeRunArtifacts(roots, run.id, preservePaths);
    delete run.assignment;
    delete run.artifacts;
    delete run.attention;
    this.#notifyUi();
  }

  async #onResultStageAdvanced(envelope: ResultEnvelopeV1): Promise<void> {
    const run = this.#runs.get(envelope.runId);
    if (!run) return;
    run.latestResult = toPublicResultView(envelope);
    await this.#refreshAttention(run.id);
    if (envelope.delivery.stage === "parent_persisted") {
      await this.#finalizeStoppedReadOnly(run).catch(() => undefined);
      this.#notices?.scheduleFlush();
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
    await this.#coordinator?.stop();
    this.#delivery?.stop();
    this.#notices?.stop();
    this.#coordinator = undefined;
    this.#delivery = undefined;
    this.#notices = undefined;
    await this.#subscriptions?.stop();
    this.#subscriptions = undefined;
    this.#client = undefined;
    this.#preflight = undefined;
    this.#groups = undefined;
    this.#worktreeManager = undefined;
    this.#worktreeCleanup = undefined;
    this.#context = undefined;
  }

  async #adoptCrossSessionCleanupJournals(): Promise<readonly { readonly runId: string; readonly reason: string }[]> {
    const context = this.#context!;
    const client = this.#client!;
    const currentParent = sessionIdentity(context);
    const leaf = context.sessionManager.getLeafId();
    if (!leaf) return [];
    const candidates = (await listRuntimeRunMetadata(context.cwd)).filter((metadata) => (metadata.lifecycle === "stopped" || metadata.lifecycle === "failed") && !this.#runs.has(metadata.runId) && !this.#worktrees?.get(metadata.runId));
    if (candidates.length === 0) return [];
    let sourceIdentity: Awaited<ReturnType<typeof identifyCheckout>>;
    try { sourceIdentity = await identifyCheckout(context.cwd); }
    catch (error) { return candidates.map((metadata) => ({ runId: metadata.runId, reason: `cleanup adoption requires a canonical Git checkout: ${error instanceof Error ? error.message : String(error)}` })); }
    const snapshot = await client.snapshot();
    const unresolved: Array<{ runId: string; reason: string }> = [];
    for (const metadata of candidates) {
      const prior = metadata.worktree;
      const priorJournal = metadata.ownershipJournal;
      if (!prior || !priorJournal) {
        unresolved.push({ runId: metadata.runId, reason: "runtime metadata lacks the exact worktree/ownership cleanup journal required for automatic adoption" });
        continue;
      }
      if (prior.state === "removed") continue;
      try {
        if (metadata.runId !== prior.id || metadata.runNonce !== prior.owner.runNonce || metadata.runId !== priorJournal.runId || metadata.runNonce !== priorJournal.runNonce) throw new Error("metadata/worktree/ownership run identity mismatch");
        if (prior.sourceCheckoutPath !== sourceIdentity.checkoutPath || prior.repositoryId !== sourceIdentity.repositoryId || prior.commonGitDir !== sourceIdentity.commonGitDir) throw new Error("source checkout identity mismatch");
        const childIdentity = await identifyCheckout(prior.checkoutPath);
        if (childIdentity.repositoryId !== prior.repositoryId || childIdentity.commonGitDir !== prior.commonGitDir || childIdentity.checkoutPath !== prior.checkoutPath) throw new Error("child checkout identity mismatch");
        const status = (await execFileAsync("git", ["-C", prior.checkoutPath, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 1_000_000 })).stdout.trim();
        if (status !== "") throw new Error("legacy checkout is dirty");
        if (snapshot.panes.some((pane) => pane.terminal_id === metadata.terminalId) || snapshot.agents.some((agent) => agent.terminal_id === metadata.terminalId || agent.workspace_id === prior.workspaceId)) throw new Error("legacy child/workspace still has a live or partial agent identity");
        const listed = await client.listWorktrees({ cwd: context.cwd });
        const candidate = listed.worktrees.find((worktree) => resolve(worktree.path) === prior.checkoutPath);
        if (!candidate || candidate.branch !== prior.branch || candidate.open_workspace_id !== prior.workspaceId || !candidate.is_linked_worktree || listed.source.repo_key !== prior.herdrRepositoryKey) throw new Error("Herdr worktree identity mismatch");
        const anchors = [prior.createdRoot, ...(prior.tab ? [prior.tab] : [])];
        const allowed = new Set(anchors.map((anchor) => anchor.rootTerminalId));
        const panes = snapshot.panes.filter((pane) => pane.workspace_id === prior.workspaceId);
        if (panes.some((pane) => !allowed.has(pane.terminal_id)) || panes.length !== anchors.length) throw new Error("legacy workspace contains unknown or missing panes");
        for (const anchor of anchors) {
          const pane = panes.find((item) => item.terminal_id === anchor.rootTerminalId && item.tab_id === anchor.tabId);
          if (!pane) throw new Error(`legacy anchor ${anchor.rootTerminalId} is absent or moved`);
          const idle = verifyIdleShell(await client.getPaneProcessInfo(pane.pane_id));
          if (!idle.idle) throw new Error(`legacy anchor ${anchor.rootTerminalId} is not idle: ${idle.reason}`);
        }
        const oldPaneId = priorJournal.resources.paneId;
        if (!oldPaneId || priorJournal.resources.terminalId !== metadata.terminalId) throw new Error("legacy ownership journal lacks exact child pane/terminal identity");
        const journalWriter = new ActiveBranchOwnershipJournal(this.#pi);
        let adopted = journalWriter.begin({ runId: metadata.runId, runNonce: metadata.runNonce, branchEntryId: leaf, sessionId: currentParent.sessionId, ...(currentParent.sessionPath === undefined ? {} : { sessionPath: currentParent.sessionPath }), intended: { workspaceId: prior.workspaceId, group: "default", worktreeRequested: true } });
        adopted = journalWriter.append(adopted, "cleanup_adopted", {
          tabId: prior.tab?.tabId ?? prior.createdRoot.tabId,
          rootPaneId: prior.tab?.rootPaneId ?? prior.createdRoot.rootPaneId,
          rootTerminalId: prior.tab?.rootTerminalId ?? prior.createdRoot.rootTerminalId,
          rootProcessBaseline: prior.tab?.rootProcessBaseline ?? prior.createdRoot.rootProcessBaseline ?? "legacy-cleanup-adoption",
          paneId: oldPaneId,
          terminalId: metadata.terminalId,
          ...(metadata.nativeSession === undefined ? {} : { nativeSession: metadata.nativeSession }),
          repositoryId: prior.repositoryId,
          commonGitDir: prior.commonGitDir,
          herdrRepositoryKey: prior.herdrRepositoryKey,
          ...(prior.sourceWorkspaceId === undefined ? {} : { worktreeSourceWorkspaceId: prior.sourceWorkspaceId }),
          worktreeWorkspaceId: prior.workspaceId,
          checkoutPath: prior.checkoutPath,
          worktreeBranch: prior.branch,
          worktreeBase: prior.base,
          worktreeInitialTabId: prior.createdRoot.tabId,
          worktreeInitialRootPaneId: prior.createdRoot.rootPaneId,
          worktreeInitialRootTerminalId: prior.createdRoot.rootTerminalId,
        });
        const reauthorized: WorktreeRecord = { ...prior, legacyOwner: prior.legacyOwner ?? prior.owner, owner: { runId: metadata.runId, runNonce: metadata.runNonce, parent: { sessionId: currentParent.sessionId, ...(currentParent.sessionPath === undefined ? {} : { sessionPath: currentParent.sessionPath }), branchEntryId: leaf } }, state: "retained", retentionReason: "Prior-session writer reauthorized for cleanup only after exact stopped provenance reconciliation", updatedAt: Date.now() };
        this.#worktrees!.register(reauthorized);
        await this.#recoverStoppedRun(adopted);
        const run = this.#runs.get(metadata.runId);
        if (run) await this.#setAttention(run, { kind: "recovery_required", reason: "Prior-session writer was reauthorized for cleanup only and awaits safe finalization", nextActions: [`Inspect ${reauthorized.checkoutPath}, then retry ${stopCall(run.id)}`], facts: { checkoutPath: reauthorized.checkoutPath, branch: reauthorized.branch, base: reauthorized.base, workspaceId: reauthorized.workspaceId } }, false);
      } catch (error) {
        unresolved.push({ runId: metadata.runId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return unresolved;
  }

  #sendRecoverySummary(items: readonly { readonly runId: string; readonly reason: string; readonly noticeId?: string }[]): void {
    const context = this.#context;
    if (!context || typeof this.#pi.sendMessage !== "function") return;
    const ordered = [...items].sort((left, right) => left.runId.localeCompare(right.runId));
    const noticeId = `act-recovery-${createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex").slice(0, 24)}`;
    const branch = currentBranch(context);
    if (findPersistedActionNotice(branch, noticeId)) return;
    const content = boundUtf8HeadTail([
      `${ACTION_NOTICE_SENTINEL} ${JSON.stringify({ noticeId, kind: "recovery_required", revision: 1, runs: ordered.map((item) => item.runId) })}`,
      "ACTION REQUIRED — startup recovery",
      ...ordered.flatMap((item) => [`run=${item.runId}`, ...(item.noticeId === undefined ? [] : [`noticeId=${item.noticeId}`]), `reason=${item.reason}`]),
      "next=Inspect the listed exact resources; use current-session cleanup only when full provenance can be supplied. No resource was deleted.",
    ].join("\n")).text;
    this.#pi.sendMessage({ customType: ACTION_NOTICE_CUSTOM_TYPE, content, display: true, details: { noticeId, runIds: ordered.map((item) => item.runId), kind: "recovery_required" } }, { deliverAs: "followUp", triggerTurn: true });
  }

  async #recoverStoppedRun(journal: OwnershipJournalData): Promise<boolean> {
    const context = this.#context!;
    const preflight = this.#preflight!;
    const terminalId = journal.resources.terminalId;
    if (!terminalId || (journal.phase !== "stopped" && journal.phase !== "cleanup_adopted")) return false;
    if (preflight.snapshot.panes.some((pane) => pane.terminal_id === terminalId) || preflight.snapshot.agents.some((agent) => agent.terminal_id === terminalId)) throw new Error("Stopped ownership journal still has a live/partial child identity");
    const metadata = await readRuntimeRunMetadata(context.cwd, journal.runId);
    if (!metadata) throw new Error("stopped cleanup metadata is missing");
    assertRuntimeMetadataMatchesJournal(metadata, journal);
    const harness = metadata.harness;
    const profile: AgentProfile = {
      name: metadata.profileName,
      description: "Recovered stopped run for cleanup-only finalization",
      body: "Cleanup-only recovery; no child process is adopted.",
      harness,
      permissions: metadata.policy.mutation ? "write" : "read-only",
      ...(Object.keys(metadata.artifacts).some((key) => key === "handoff" || key === "progress") ? { artifacts: { writer: metadata.artifactWriter } } : {}),
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
    const group = journal.resources.tabId && journal.resources.rootPaneId && journal.resources.rootTerminalId && journal.resources.rootProcessBaseline
      ? this.#groups!.restoreOwned({ workspaceId: journal.resources.worktreeWorkspaceId ?? journal.intended.workspaceId, group: journal.intended.group, tabId: journal.resources.tabId, rootPaneId: journal.resources.rootPaneId, rootTerminalId: journal.resources.rootTerminalId, rootProcessBaseline: journal.resources.rootProcessBaseline })
      : undefined;
    const target: OwnedRunTarget = {
      runId: journal.runId,
      runNonce: journal.runNonce,
      harness,
      terminalId,
      activeBranchOwned: true,
      authorization: this.#authorization(journal.runId, journal.runNonce),
      ...(journal.resources.nativeSession === undefined ? {} : { nativeSession: journal.resources.nativeSession }),
      ...(group === undefined ? {} : { group }),
    };
    const additionalRoots = this.#settings?.security.allowedRoots;
    const roots = await resolveArtifactRoots({ checkout: metadata.policy.cwd, allowProgress: metadata.artifacts.progress !== undefined, ...(additionalRoots === undefined ? {} : { trustedAdditionalRoots: additionalRoots }) });
    const metadataRoots = metadata.policy.cwd === context.cwd ? roots : await resolveArtifactRoots({ checkout: context.cwd, allowProgress: false, ...(additionalRoots === undefined ? {} : { trustedAdditionalRoots: additionalRoots }) });
    const envelopes = await listResultEnvelopes(context.cwd, journal.runId, metadataRoots).catch(() => []);
    const latest = envelopes.at(-1);
    this.#runs.set(journal.runId, {
      id: journal.runId,
      runNonce: journal.runNonce,
      profile,
      taskSynopsis: metadata.taskSynopsis,
      ...(metadata.assignment === undefined ? {} : { assignment: metadata.assignment }),
      createdAt: metadata.createdAt,
      updatedAt: Date.now(),
      lifecycle: "stopped",
      herdrStatus: "unknown",
      policy,
      parentBranchEntryId: journal.parent.branchEntryId,
      journal,
      target,
      ...(group === undefined ? {} : { group }),
      artifacts: { roots, metadataRoots, contracts: [], paths: metadata.artifacts },
      ...(this.#worktrees?.get(journal.runId) === undefined ? {} : { worktreeId: journal.runId }),
      lastOutput: metadata.output,
      nextGeneration: metadata.generation.nextGeneration,
      ...(metadata.generation.active === undefined ? {} : { activeGeneration: metadata.generation.active }),
      schemaVersion: 5,
      ...(latest === undefined ? {} : { latestResult: toPublicResultView(latest) }),
      ...(metadata.attention === undefined ? {} : { attention: metadata.attention }),
    });
    return true;
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
      if (recovered.state === "owned" && (journal.phase === "stopped" || journal.phase === "cleanup_adopted")) {
        try { await this.#recoverStoppedRun(journal); }
        catch (error) { observe(journal, "uncertain", `Stopped cleanup recovery refused: ${error instanceof Error ? error.message : String(error)}`); }
        continue;
      }
      if (recovered.state === "owned" && (journal.phase === "started" || journal.phase === "failed") && journal.resources.terminalId) {
        const pane = preflight.snapshot.panes.find((candidate) => candidate.terminal_id === journal.resources.terminalId);
        const agent = preflight.snapshot.agents.find((candidate) => candidate.terminal_id === journal.resources.terminalId);
        if (!pane && !agent && this.#worktrees?.get(journal.runId)) {
          try {
            const metadata = await readRuntimeRunMetadata(context.cwd, journal.runId);
            if (!metadata || metadata.runtime.ephemeralFiles !== "removed") throw new Error("legacy cleanup-only recovery requires removed ephemeral runtime state");
            assertRuntimeMetadataMatchesJournal(metadata, journal);
            const stopped = new ActiveBranchOwnershipJournal(this.#pi).append(journal, "stopped", {});
            await this.#recoverStoppedRun(stopped);
          } catch (error) { observe(journal, "uncertain", `Legacy stopped cleanup recovery refused: ${error instanceof Error ? error.message : String(error)}`); }
          continue;
        }
      }
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
            ...(metadata.runtime.resultExchangeDirectory === undefined ? {} : { resultExchangeDirectory: metadata.runtime.resultExchangeDirectory }),
          }
        : undefined;
      const generation = metadata.generation;
      let latestResult: PublicResultView | undefined;
      try {
        const envelopes = await listResultEnvelopes(context.cwd, journal.runId, metadataRoots);
        const last = envelopes.at(-1);
        if (last) latestResult = toPublicResultView(last);
      } catch { /* Result files are optional at recovery. */ }
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
        journal,
        target,
        ...(group === undefined ? {} : { group }),
        artifacts: { roots, metadataRoots, contracts: [], paths: metadata.artifacts as unknown as RunArtifactPaths },
        ...(ephemeral === undefined ? {} : { ephemeral }),
        ...(this.#worktrees?.get(journal.runId) === undefined ? {} : { worktreeId: journal.runId }),
        lastOutput: metadata.output,
        nextGeneration: generation.nextGeneration,
        ...(generation.active === undefined ? {} : { activeGeneration: generation.active }),
        schemaVersion: 5,
        ...(latestResult === undefined ? {} : { latestResult }),
        ...(metadata.attention === undefined ? {} : { attention: metadata.attention }),
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
    const values = { id, groupId: "default", profile: profile.name, harness } as const;
    if (profile.artifacts?.handoff !== undefined) resolveArtifactPath(profile.artifacts.handoff, values, roots);
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
    const durableCanonical = canonicalRunArtifactPaths(metadataRoots, { id, groupId: "default" });
    const values = { id, groupId: "default", profile: profile.name, harness } as const;
    const handoff = profile.artifacts?.handoff ? resolveArtifactPath(profile.artifacts.handoff, values, roots) : undefined;
    const progress = progressTemplate ? resolveArtifactPath(progressTemplate, values, roots) : undefined;
    if (handoff !== undefined) await ensureSafeArtifactDirectory(dirname(handoff), roots);
    if (progress !== undefined) await ensureSafeArtifactDirectory(dirname(progress), roots);
    await ensureSafeArtifactDirectory(dirname(durableCanonical.runMetadata), metadataRoots);
    const writer = profile.artifacts?.writer ?? "parent";
    const contracts: ArtifactContract[] = [
      ...(progress === undefined ? [] : [{ kind: "progress" as const, path: progress, writer, required: false }]),
      ...(handoff === undefined ? [] : [{ kind: "handoff" as const, path: handoff, writer, required: false }]),
    ];
    return {
      roots,
      metadataRoots,
      contracts,
      paths: {
        metadata: durableCanonical.runMetadata,
        ...(handoff === undefined ? {} : { handoff }),
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
      `${JSON.stringify(runtimeMetadata(run, terminalId, undefined, run.worktreeId === undefined ? undefined : this.#worktrees?.get(run.worktreeId)), null, 2)}\n`,
      run.artifacts.metadataRoots,
      { mode: 0o600, replace: true },
    );
  }

  async #resolvePolicy(input: StartToolInput, profile: AgentProfile, context: ExtensionContext, settings: HerdrSubagentsSettings): Promise<{ profile: AgentProfile; policy: EffectiveLaunchPolicy } | ToolUnavailableResult> {
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
    const childTools = resolution.policy.tools.map((tool) => tool.name);
    const soft = resolveSoftCapabilities(selectedProfile, {
      tools: childTools,
      reviewedExternalResearchTools: childTools.filter((name) => REVIEWED_RESEARCH_TOOLS.has(name)),
    });
    if (soft.research.state === "blocked") return unavailable(soft.diagnostics.map((item) => item.message).join("; "), "blocked");
    return { profile: selectedProfile, policy: resolution.policy };
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
    const { profile, policy: parentPolicy } = resolved;
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
      journal: journalState,
      lastOutput: EMPTY_OUTPUT,
      nextGeneration: 1,
      schemaVersion: 5,
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
        const handoffPath = profile.artifacts?.handoff === undefined
          ? undefined
          : precomputedWorktreeArtifactPath(requestedPath, profile.artifacts.handoff, values);
        const artifactWriter = profile.artifacts?.writer ?? "parent";
        const cleanupHandoffPath = handoffPath === undefined ? undefined : artifactWriter === "child" ? parentHandoffWrapperPath(handoffPath) : handoffPath;
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
            ...(cleanupHandoffPath === undefined ? [] : [{ kind: "handoff" as const, sourcePath: cleanupHandoffPath, writer: "parent" as const, required: false }]),
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
          managed.groupCreatedByRun = true;
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
        metadata: {
          runId,
          runNonce,
          profileName: profile.name,
          parentSessionId: parent.sessionId,
          ...(parent.sessionPath === undefined ? {} : { parentSessionPath: parent.sessionPath }),
          ...(managed.ephemeral.resultExchangeDirectory === undefined ? {} : { resultExchangeDirectory: managed.ephemeral.resultExchangeDirectory }),
        },
      });
      const authorization = this.#authorization(runId, runNonce);
      const started = await startSubagent({
        client: ready.client,
        prepared,
        placement: group,
        instructions,
        authorization,
        prepareSubmission: async (raw) => {
          if (!this.#coordinator) throw new Error("Result coordinator is not available");
          const preparedGen = await this.#coordinator.prepareGeneration({ runId, originalInput: raw });
          return preparedGen.wrappedInput;
        },
        recordStarted: async (agent) => {
          journalState = journal.append(journalState, "started", {
            paneId: agent.pane_id,
            terminalId: agent.terminal_id,
            ...(agent.agent_session ? { nativeSession: { kind: agent.agent_session.kind, value: agent.agent_session.value, source: agent.agent_session.source } } : {}),
          });
          managed.journal = journalState;
          await writeArtifactAtomic(artifacts.paths.metadata!, `${JSON.stringify(runtimeMetadata(managed, agent.terminal_id, undefined, worktree), null, 2)}\n`, artifacts.metadataRoots, { mode: 0o600, replace: true });
        },
        recordReady: async (agent) => {
          if (journalState.resources.nativeSession === undefined && agent.agent_session) {
            journalState = journal.append(journalState, "started", { nativeSession: { kind: agent.agent_session.kind, value: agent.agent_session.value, source: agent.agent_session.source } });
            managed.journal = journalState;
          }
          await writeArtifactAtomic(artifacts.paths.metadata!, `${JSON.stringify(runtimeMetadata(managed, agent.terminal_id, undefined, worktree), null, 2)}\n`, artifacts.metadataRoots, { mode: 0o600, replace: true });
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
      if (started.started) {
        await this.#coordinator?.recordSubmission(runId, "confirmed");
      } else {
        await this.#coordinator?.recordSubmission(runId, "blocked");
      }
      await this.#persistMetadata(managed);
      if (worktree && target.nativeSession) {
        worktree = ready.worktrees.bindWriter(worktree.id, { terminalId: target.terminalId, nativeSession: target.nativeSession });
        await this.#persistMetadata(managed);
      }
      this.#subscriptions?.ownershipChanged(); this.#notifyUi();
      this.#coordinator?.wake();
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
          permissions: policy.permissions,
          isolatedWorktree: policy.requireWorktree,
          broadeningReasons: policy.broadeningReasons,
        },
        output: started.output,
        ...(started.started ? {
          completion: {
            pending: true,
            delivery: "automatic",
            note: "Result will be captured and injected into this parent branch automatically when the child settles. Use subagent_status with the exact ID for live inspection, blockers, or recovery.",
          },
        } : { reason: started.reason }),
      };
    } catch (error) {
      managed.lifecycle = "failed";
      managed.herdrStatus = "unknown";
      managed.updatedAt = Date.now();
      managed.failure = error instanceof Error ? error.message : String(error);
      if (error instanceof PlacementStartExhaustedError) {
        try {
          if (journalState.phase !== "failed") {
            journalState = journal.append(journalState, "failed", {});
            managed.journal = journalState;
          }
        } catch { /* Preserve the last valid write-ahead state. */ }
        const failedGroup = managed.group;
        let cleanupDetail = worktree
          ? `writer workspace/worktree retained for ${stopCall(runId)}`
          : managed.groupCreatedByRun ? "new read-only group cleanup was not attempted" : "reused read-only group retained";
        if (!worktree && managed.groupCreatedByRun && failedGroup) {
          const cleanup = await cleanupPartialStart({ client: ready.client, groupManager: ready.groups, group: failedGroup, journal: managed.journal, groupCreatedThisAttempt: true, ...(signal === undefined ? {} : { signal }) });
          cleanupDetail = cleanup.retained.length > 0
            ? `new read-only group retained: ${cleanup.retained.join("; ")}`
            : `new read-only group cleanup closed tabs [${cleanup.closedTabIds.join(", ") || "none"}] and panes [${cleanup.closedPaneIds.join(", ") || "none"}]`;
        }
        managed.failure = `${error.message}; ${cleanupDetail}. No child identity was returned. Resolve with ${stopCall(runId)}`;
        const failedWorktree = managed.worktreeId === undefined ? undefined : ready.worktrees.get(managed.worktreeId);
        await this.#setAttention(managed, {
          kind: "failed",
          reason: managed.failure,
          nextActions: [`Inspect ${statusCall(runId)}`, `${stopCall(runId)} skips child process control and uses the existing exact cleanup path`],
          facts: failedWorktree === undefined
            ? { ...(failedGroup === undefined ? {} : { workspaceId: failedGroup.workspaceId, tabId: failedGroup.tabId }) }
            : { checkoutPath: failedWorktree.checkoutPath, branch: failedWorktree.branch, base: failedWorktree.base, workspaceId: failedWorktree.workspaceId, ...(failedWorktree.tab === undefined ? {} : { tabId: failedWorktree.tab.tabId }) },
        }).catch(() => undefined);
        await this.#removeEphemeral(managed).catch(() => undefined);
        this.#subscriptions?.ownershipChanged(); this.#notifyUi();
        return {
          ok: true,
          status: "blocked",
          run: await this.#summary(managed),
          effective: {
            harness: policy.harness,
            ...(policy.model === undefined ? {} : { model: policy.model }),
            thinking: policy.thinking,
            cwd: policy.cwd,
            tools: policy.tools.map((tool) => tool.name),
            permissions: policy.permissions,
            isolatedWorktree: policy.requireWorktree,
            broadeningReasons: policy.broadeningReasons,
          },
          output: EMPTY_OUTPUT,
          reason: managed.failure,
        };
      }
      // Input may have been attempted: never leave the generation stuck in "prepared".
      if (error instanceof TurnSubmissionUncertainError) {
        await this.#coordinator?.recordSubmission(runId, "uncertain").catch(() => undefined);
        managed.target = error.target;
      }
      const terminalRecorded = managed.journal.resources.terminalId !== undefined;
      const provenGone = error instanceof StartCleanupError && error.cleanup !== "retained";
      // Uncertain submission retains the child and ephemeral exchange for recovery capture.
      if (error instanceof TurnSubmissionUncertainError) {
        await this.#persistMetadata(managed).catch(() => undefined);
      } else if (!terminalRecorded || provenGone) {
        await this.#removeEphemeral(managed).catch(() => undefined);
        await this.#persistMetadata(managed).catch(() => undefined);
      }
      try {
        if (journalState.phase !== "failed") {
          journalState = journal.append(journalState, "failed", {});
          managed.journal = journalState;
        }
      } catch { /* Preserve the last valid write-ahead state. */ }
      const failedWorktree = managed.worktreeId === undefined ? undefined : ready.worktrees.get(managed.worktreeId);
      await this.#setAttention(managed, {
        kind: "failed",
        reason: managed.failure,
        nextActions: [`Inspect ${statusCall(managed.id)}`, `Retry ${stopCall(managed.id)}; safe no-change cleanup is automatic when provable`],
        ...(failedWorktree === undefined ? {} : { facts: { checkoutPath: failedWorktree.checkoutPath, branch: failedWorktree.branch, workspaceId: failedWorktree.workspaceId } }),
      }).catch(() => undefined);
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
    await this.#refreshAttention(run.id);
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
      ...(run.attention === undefined ? {} : { attention: toPublicRunAttention(run.attention) }),
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
    let result = run.latestResult;
    if (!result && this.#context) {
      try {
        const envelopes = await listResultEnvelopes(this.#context.cwd, run.id, run.artifacts?.metadataRoots);
        const last = envelopes.at(-1);
        if (last) {
          result = toPublicResultView(last);
          run.latestResult = result;
        }
      } catch { /* optional */ }
    }
    // Prefer deliveredText when assigned; otherwise surface a bounded raw capture for inspection.
    let capturedText = result?.deliveredText;
    if (capturedText === undefined && this.#context) {
      try {
        const envelopes = await listResultEnvelopes(this.#context.cwd, run.id, run.artifacts?.metadataRoots);
        const last = envelopes.at(-1);
        if (last) {
          if (!result) {
            result = toPublicResultView(last);
            run.latestResult = result;
          }
          capturedText = last.deliveredText ?? boundUtf8HeadTail(last.rawText).text;
        }
      } catch { /* optional */ }
    }
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
      ...(result === undefined ? {} : { result }),
      output,
      ...(result === undefined ? {} : { terminalDiagnostic: output }),
      artifacts: run.artifacts ? run.artifacts.paths : {},
      runtime: {
        ephemeralFiles: run.ephemeral === undefined ? "removed" : "retained",
        piSessionData: run.policy.harness !== "pi"
          ? "not-applicable"
          : run.ephemeral?.sessionDirectory === undefined ? "removed" : "retained",
      },
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(capturedText === undefined ? {} : { capturedResultText: capturedText }),
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
      run.herdrStatus = focused.after.agent_status; run.updatedAt = Date.now();
      this.#notifyUi();
      return { ok: true, attentionChanged: focused.before.agent.agent_status === "done" && focused.after.agent_status === "idle" };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof FocusOutcomeUncertainError
          ? error.message
          : `Focus refused before a confirmed mutation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async send(input: SendToolInput, signal?: AbortSignal): Promise<ActionToolResult> {
    const ready = this.#ready(); if ("ok" in ready) return ready;
    const run = this.#managed(input.id);
    try {
      if (!this.#coordinator) throw new Error("Result coordinator is not available");
      // End-to-end per-run lock: prepare → pane input → recordSubmission (no interleaving).
      return await this.#coordinator.runExclusive(run.id, async () => {
        const allowed = this.#coordinator!.canSubmitGeneration(toCoordinatorView(this.#resultHost(), run));
        if (!allowed.ok) throw new Error(allowed.reason);
        const prepared = await this.#coordinator!.prepareGenerationUnlocked({
          runId: run.id,
          originalInput: input.message,
        });
        const result = await sendToSubagent({
          client: ready.client,
          target: this.#ownedTarget(run),
          message: prepared.wrappedInput,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
        });
        run.herdrStatus = result.state; run.lastOutput = result.output; run.updatedAt = Date.now();
        if (result.delivery === "confirmed") await this.#coordinator!.recordSubmissionUnlocked(run.id, "confirmed");
        else if (result.delivery === "unconfirmed") await this.#coordinator!.recordSubmissionUnlocked(run.id, "unconfirmed");
        else await this.#coordinator!.recordSubmissionUnlocked(run.id, "uncertain");
        await this.#persistMetadata(run); this.#notifyUi();
        this.#coordinator!.wake();
        return {
          ok: true as const,
          action: "send" as const,
          run: await this.#summary(run),
          result: { ...result, generation: prepared.generation, requestNonce: prepared.requestNonce },
        };
      });
    } catch (error) { if (isUnavailableError(error)) return unavailable(error instanceof Error ? error.message : String(error)); throw error; }
  }

  async #captureHandoffText(run: ManagedRun): Promise<string> {
    // Prefer full raw capture over bounded model-visible deliveredText.
    if (this.#context && run.activeGeneration?.generation) {
      try {
        const envelope = await readResultEnvelope(this.#context.cwd, run.id, run.activeGeneration.generation, run.artifacts?.metadataRoots);
        if (envelope?.rawText !== undefined) return envelope.rawText;
      } catch { /* fall through */ }
    }
    if (this.#context) {
      try {
        const envelopes = await listResultEnvelopes(this.#context.cwd, run.id, run.artifacts?.metadataRoots);
        const last = envelopes.at(-1);
        if (last?.rawText !== undefined) return last.rawText;
      } catch { /* fall through */ }
    }
    if (run.latestResult?.deliveredText) return run.latestResult.deliveredText;
    return run.lastOutput.text;
  }

  async #captureHandoff(run: ManagedRun): Promise<string | undefined> {
    if (!run.artifacts?.paths.handoff || run.assignment === undefined) return undefined;
    const finalOutput = await this.#captureHandoffText(run);
    const materialized = await materializeHandoff({
      profile: run.profile,
      effectiveMutationCapable: run.policy.permissions.mutation,
      handoffPath: run.artifacts.paths.handoff,
      roots: run.artifacts.roots,
      finalOutput,
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

  async #revalidateWorktreeCleanupOwnership(ready: { readonly client: HerdrClient }, run: ManagedRun, record: WorktreeRecord, signal?: AbortSignal): Promise<void> {
    const context = this.#context;
    if (!context) throw new Error("Parent context is unavailable for cleanup authorization");
    const recovered = recoverActiveBranchOwnership(currentBranch(context)).get(run.id);
    const parent = sessionIdentity(context);
    if (!recovered || recovered.state !== "owned" || recovered.journal.runNonce !== run.runNonce
      || recovered.journal.parent.sessionId !== parent.sessionId
      || (recovered.journal.parent.sessionPath !== undefined && recovered.journal.parent.sessionPath !== parent.sessionPath)
      || record.owner.runId !== run.id || record.owner.runNonce !== run.runNonce) {
      throw new Error("Current active branch/session no longer authorizes this worktree cleanup");
    }
    if (run.target) {
      await revalidateRecordedOwnershipFresh(ready.client, run.target, signal);
      return;
    }
    const snapshot = await ready.client.snapshot(signal);
    if (snapshot.agents.some((agent) => agent.workspace_id === record.workspaceId)) throw new Error("Worktree workspace still contains a live agent");
  }

  async stop(input: StopToolInput, signal?: AbortSignal): Promise<ActionToolResult> {
    return this.#topology.run(async () => {
      const ready = this.#ready(); if ("ok" in ready) return ready;
      const run = this.#managed(input.id);
      const priorLifecycle = run.lifecycle;
      let provenStopped = priorLifecycle === "stopped";
      let result: StopSubagentResult;
      try {
        if (!provenStopped && priorLifecycle === "failed") {
          if (!run.target) provenStopped = true;
          else {
            const snapshot = await ready.client.snapshot(signal);
            const absent = !snapshot.panes.some((pane) => pane.terminal_id === run.target!.terminalId)
              && !snapshot.agents.some((agent) => agent.terminal_id === run.target!.terminalId);
            if (absent) {
              const authorized = await run.target.authorization.verify({
                runId: run.id,
                runNonce: run.runNonce,
                terminalId: run.target.terminalId,
                ...(run.target.nativeSession === undefined ? {} : { nativeSession: run.target.nativeSession }),
                snapshot,
              });
              provenStopped = authorized;
            }
          }
        }

        if (provenStopped) {
          let tabClosed = false;
          let reason = "Child process was already proven stopped; process control skipped";
          if (!run.worktreeId && run.target?.group) {
            const tab = await closeDedicatedTabIfSafe(ready.client, run.target, signal);
            tabClosed = tab.closed;
            reason += `. ${tab.reason}`;
            if (tab.closed && run.group && ready.groups.get(run.group.workspaceId, run.group.group)) ready.groups.forgetClosed(run.group);
          } else if (!run.worktreeId && !run.target && run.groupCreatedByRun && run.group && ready.groups.get(run.group.workspaceId, run.group.group)) {
            const partial = await cleanupPartialStart({ client: ready.client, groupManager: ready.groups, group: run.group, journal: run.journal, groupCreatedThisAttempt: true, ...(signal === undefined ? {} : { signal }) });
            tabClosed = partial.closedTabIds.includes(run.group.tabId);
            reason += partial.retained.length > 0
              ? `. Read-only group retained: ${partial.retained.join("; ")}`
              : `. Existing partial-start cleanup closed tabs [${partial.closedTabIds.join(", ") || "none"}] and panes [${partial.closedPaneIds.join(", ") || "none"}]`;
          }
          result = { stopped: true, forced: false, tabClosed, retained: false, reason, output: run.lastOutput };
        } else {
          run.lifecycle = "stopping";
          await this.#coordinator?.reconcileRun(run.id);
          result = await stopSubagent({
            client: ready.client,
            target: this.#ownedTarget(run),
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            ...(signal === undefined ? {} : { signal }),
          });
          if (result.output.text.trim().length > 0) run.lastOutput = result.output;
          provenStopped = result.stopped;
          if (result.tabClosed && !run.worktreeId && run.group) {
            const cached = ready.groups.get(run.group.workspaceId, run.group.group);
            if (cached) ready.groups.forgetClosed(run.group);
          }
        }

        let captureUncertain = false;
        if (result.stopped) {
          const barrier = await this.#coordinator?.captureBarrier(run.id);
          if (barrier?.envelope) run.latestResult = toPublicResultView(barrier.envelope);
          captureUncertain = barrier?.uncertain === true || barrier?.durable === false;
        }
        run.lifecycle = result.stopped ? "stopped" : "running";
        run.herdrStatus = result.stopped ? "unknown" : run.herdrStatus;
        if (result.stopped && run.journal.phase !== "stopped" && run.journal.resources.tabId && (run.journal.phase === "started" || run.journal.phase === "failed")) {
          run.journal = new ActiveBranchOwnershipJournal(this.#pi).append(run.journal, "stopped", {});
        }
        run.updatedAt = Date.now();

        if (result.stopped) {
          const explicitHandoff = await this.#captureHandoff(run);
          if (explicitHandoff && run.artifacts) run.artifacts.paths = { ...run.artifacts.paths, handoff: explicitHandoff };
          if (!captureUncertain) await this.#removeEphemeral(run).catch(() => undefined);
          await this.#persistMetadata(run);
        }

        await this.#delivery?.reconcilePersistence();
        await this.#notices?.reconcilePersistence();
        let cleanup: unknown;
        if (run.worktreeId) {
          let record = ready.worktrees.get(run.worktreeId);
          if (!record) throw new Error(`Worktree state for ${run.worktreeId} is unavailable`);
          if (input.parentReview) ready.worktrees.setParentReviewed(record.id, input.parentReview);
          const integration = this.#integration(input);
          await this.#revalidateWorktreeCleanupOwnership(ready, run, record, signal);
          const parentRoots = await resolveArtifactRoots({ checkout: record.sourceCheckoutPath, allowProgress: false });
          const recordCheckoutPath = record.checkoutPath;
          const sourceRoots = await resolveArtifactRoots({ checkout: recordCheckoutPath, allowProgress: record.artifactPaths.some((artifact) => isWithin(join(recordCheckoutPath, ".progress"), artifact.absolutePath)) });
          const resultEvidencePersisted = run.latestResult?.deliveryStage === "parent_persisted"
            || run.attention?.delivery.stage === "parent_persisted";
          const cleanupResult = await ready.worktreeCleanup.cleanup({
            id: record.id,
            cleanup: input.cleanup ?? "remove_if_safe",
            ownership: { runId: record.owner.runId, runNonce: record.owner.runNonce, parent: record.owner.parent, activeBranchState: "owned" },
            artifactCapture: { artifacts: record.artifactPaths.map((artifact) => ({ kind: artifact.kind, sourcePath: artifact.absolutePath, required: artifact.required })), sourceRoots, parentRoots, runId: record.id },
            parentRoots,
            resultEvidencePersisted,
            ...(integration === undefined ? {} : { integrationEvidence: integration }),
            revalidateOwnership: () => this.#revalidateWorktreeCleanupOwnership(ready, run, record!, signal),
            ...(signal === undefined ? {} : { signal }),
          });
          cleanup = cleanupResult;
          record = cleanupResult.record;
          if (cleanupResult.removed && !cleanupResult.retained && record.finalization?.branchFinalizedAt !== undefined) {
            try {
              await purgeRuntimeRunArtifacts(parentRoots, run.id);
              record = ready.worktrees.markRuntimeArtifactsPurged(record.id);
              delete run.assignment;
              delete run.artifacts;
              delete run.attention;
              cleanup = { ...cleanupResult, record, finalized: true, runtimeArtifactsPurged: true };
            } catch (error) {
              const reason = `Runtime artifact purge failed: ${error instanceof Error ? error.message : String(error)}`;
              record = ready.worktrees.recordFinalizationError(record.id, reason);
              cleanup = { ...cleanupResult, retained: true, reason, record, finalized: false };
              await this.#setAttention(run, { kind: "cleanup_required", reason, nextActions: [`Inspect the run-bound artifact directory for ${run.id}, then retry ${stopCall(run.id)}`], facts: { checkoutPath: record.sourceCheckoutPath, branch: record.branch, workspaceId: record.workspaceId } });
            }
          } else if (cleanupResult.retained) {
            await this.#setAttention(run, {
              kind: "cleanup_required",
              reason: cleanupResult.reason,
              nextActions: [`Inspect the delivered result and ${record.checkoutPath}`, `Resolve the stated blocker, then retry ${stopCall(run.id)}`],
              facts: { checkoutPath: record.checkoutPath, branch: record.branch, base: record.base, workspaceId: record.workspaceId, ...(record.tab === undefined ? {} : { tabId: record.tab.tabId }), ...(record.writer === undefined ? {} : { terminalId: record.writer.terminalId }) },
            });
          }
        } else {
          await this.#finalizeStoppedReadOnly(run).catch(async (error) => {
            await this.#setAttention(run, { kind: "cleanup_required", reason: `Read-only runtime artifact purge failed: ${error instanceof Error ? error.message : String(error)}`, nextActions: [`Inspect the run-bound artifacts for ${run.id}, then retry ${stopCall(run.id)}`] });
          });
          if (run.artifacts && run.attention === undefined) {
            await this.#setAttention(run, { kind: "delivery_uncertain", reason: "Parent result/failure evidence is not yet persisted; transient run artifacts remain", nextActions: [`Allow result/action delivery to persist, then retry ${stopCall(run.id)}`] });
          }
          if (input.cleanup === "remove_if_safe") cleanup = { removed: false, retained: false, reason: "Run has no writer worktree; owned group-tab cleanup is handled by process stop" };
        }
        this.#subscriptions?.ownershipChanged(); this.#notifyUi();
        return { ok: true, action: "stop", run: await this.#summary(run), result, ...(cleanup === undefined ? {} : { cleanup }) };
      } catch (error) {
        run.lifecycle = provenStopped ? "stopped" : priorLifecycle === "failed" ? "failed" : "running";
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
