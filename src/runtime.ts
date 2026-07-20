import { randomUUID } from "node:crypto";
import { access, lstat, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  appendArtifactSection,
  renderArtifactHeader,
  renderCleanupSection,
  renderGenerationSection,
  resolveArtifactLocation,
  type ArtifactIdentity,
} from "./artifact.ts";
import {
  HerdrError,
  HerdrSubscriptionTransportError,
  type AgentInfo,
  type AgentStatus,
  type AgentStatusEvent,
  type AgentStatusSubscription,
  type HerdrClient,
} from "./herdr.ts";
import { buildPiLaunch, type ProfileName } from "./profiles.ts";
import {
  captureChildCursor,
  createChildSessionLocation,
  HERDR_STATE_CUSTOM_TYPE,
  observeChildSession,
  readChildResult,
  reconstructHerdrJournal,
  type ChildResult,
  type ChildSessionLocation,
  type ChildSessionObservation,
  type HerdrLifecycleState,
  type HerdrStateRecord,
  type JournalGeneration,
  type ReplayedHerdrRun,
} from "./session.ts";
import {
  cleanupWorkerWorktree,
  createWorkerWorktree,
  type GitStatus,
  type WorkerCleanup,
  type WorktreeFacts,
} from "./worktree.ts";

const READY = new Set<AgentStatus>(["idle", "done", "blocked"]);
const RESULT_ELIGIBLE = new Set<AgentStatus>(["idle", "done"]);
const TERMINAL = new Set<HerdrLifecycleState>(["retained", "closed"]);
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 300_000;
const DEFAULT_QUIET_PERIOD_MS = 30_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

interface ResultCandidate {
  observation: ChildSessionObservation & { result: ChildResult };
  fingerprint: string;
}

type StatusStreamOutcome =
  | { kind: "event"; next: IteratorResult<AgentStatusEvent> }
  | { kind: "stream-error"; error: unknown };

class CleanSubscriptionEof extends Error {
  constructor() {
    super("Herdr subscription ended cleanly");
    this.name = "CleanSubscriptionEof";
  }
}

type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface Generation {
  number: number;
  input: string;
  baselineEntryId: string | null;
  resultEntryId?: string;
  delivery: "pending" | "ready" | "queued" | "delivered";
  blockingWaiter: boolean;
  returned?: boolean;
  artifactParentPersisted?: true;
  artifactResultPersisted?: true;
  error?: string;
}

export interface Run {
  id: string;
  parentSessionId: string;
  parentInstanceId: string;
  profile: ProfileName;
  childSessionId: string;
  childSessionDir: string;
  childSessionPath?: string;
  childCwd: string;
  artifactPath: string;
  terminalId: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  generation?: Generation;
  latestResult?: ChildResult;
  worktree?: WorktreeFacts;
  lifecycle: "starting" | "live" | "stopping" | "retained" | "closed";
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
  warning?: string;
  resultContent?: string;
  retained?: readonly string[];
  childStopped?: true;
  archivePending?: true;
  error?: string;
}

interface GenerationOutcome {
  result?: ChildResult;
  error?: Error;
}

interface RunRecord extends Run {
  location: ChildSessionLocation;
  monitorController?: AbortController;
  monitor?: Promise<void>;
  monitorGeneration?: number;
  completion?: Promise<GenerationOutcome>;
  complete?: (outcome: GenerationOutcome) => void;
  cleanup?: Promise<StopResult>;
  archiveActionSent?: boolean;
  archiveRecovered?: boolean;
}

export interface ParentSessionBinding {
  parentSessionId: string;
  parentSessionFile?: string;
  parentEntryId: string | null;
}

export interface ParentRequest extends ParentSessionBinding {
  parentInstanceId: string;
}

interface BoundParent extends ParentSessionBinding {
  parentInstanceId: string;
  parentProcessId: number;
}

export interface LifecycleDiagnostic {
  runId: string;
  outcome: "closed" | "retained" | "live_owner" | "identity_mismatch" | "cleaned";
  message: string;
  retained?: readonly string[];
}

export interface ResultDetails {
  parentSessionId: string;
  runId: string;
  artifactPath: string;
  profile: ProfileName;
  generation: number;
  childSessionId: string;
  childEntryId: string;
  worktree?: WorktreeFacts;
}

export interface ResultDelivery {
  customType: "herdr-subagent-result";
  content: string;
  display: true;
  details: ResultDetails;
}

export interface RuntimeEnvironment {
  workspaceId: string;
  agentDir?: string;
}

export interface RuntimeOptions {
  idFactory?: () => string;
  instanceIdFactory?: () => string;
  parentProcessId?: number;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  quietPeriodMs?: number;
  reconnectDelaysMs?: readonly number[];
  monitorDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
  observeChildSession?: typeof observeChildSession;
  cleanupTimeoutMs?: number;
  gitStatus?: GitStatus;
  appendState?: (customType: typeof HERDR_STATE_CUSTOM_TYPE, record: HerdrStateRecord) => void;
  appendArtifact?: typeof appendArtifactSection;
  deliverResult?: (message: ResultDelivery) => void;
  deliverAction?: (message: ActionDelivery) => void;
  onRunsChanged?: () => void;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface GenerationRequest extends Partial<ParentRequest> {
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ActionDelivery {
  customType: "herdr-subagent-action";
  content: string;
  display: true;
  details: { parentSessionId: string; runId: string; artifactPath: string; reason: string };
}

export interface StopResult {
  run: Run;
  retained: readonly string[];
  workerCleanup?: WorkerCleanup;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function workerWarning(run: Pick<Run, "worktree" | "parentSessionId">): string | undefined {
  if (!run.worktree) return undefined;
  return [
    `Worker checkout: ${run.worktree.path}`,
    `Generated branch: ${run.worktree.branch}`,
    `Parent owner: ${run.parentSessionId}`,
    "Safe cleanup warning: the branch is always retained; a dirty or uncheckable worktree is also retained for manual handling.",
  ].join("\n");
}

export function formatSubagentResult(run: Run, result: ChildResult): string {
  const generation = run.generation?.number ?? 0;
  const warning = workerWarning(run);
  return [
    `<subagent_result run_id="${run.id}" profile="${run.profile}" generation="${generation}" child_entry_id="${result.childEntryId}" lifecycle="${run.lifecycle}">`,
    result.text,
    `Durable recovery artifact (read after compaction): ${run.artifactPath}`,
    ...(warning ? [warning] : ["Reader reminder: the child remains available for follow-ups; stop it when no longer needed."]),
    "</subagent_result>",
  ].join("\n");
}

function cloneRun(run: RunRecord): Run {
  const {
    location: _location,
    monitorController: _monitorController,
    monitor: _monitor,
    monitorGeneration: _monitorGeneration,
    completion: _completion,
    complete: _complete,
    cleanup: _cleanup,
    archiveActionSent: _archiveActionSent,
    archiveRecovered: _archiveRecovered,
    ...publicRun
  } = run;
  return {
    ...publicRun,
    ...(run.generation ? { generation: { ...run.generation } } : {}),
    ...(run.latestResult ? { latestResult: { ...run.latestResult } } : {}),
    ...(run.worktree ? { worktree: { ...run.worktree } } : {}),
    ...(run.retained ? { retained: [...run.retained] } : {}),
  };
}

function validateWait(request: GenerationRequest): number {
  if (request.timeoutMs !== undefined && request.wait !== true) {
    throw new Error("timeoutMs is valid only with wait:true");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_WAIT_MS}`);
  }
  return timeoutMs;
}

function matchesChildSession(
  agent: AgentInfo,
  childSessionId: string,
  childSessionDir: string,
  childSessionPath?: string,
): boolean {
  if (agent.agent !== "pi" || agent.agentSession?.agent !== "pi") return false;
  if (agent.agentSession.kind === "id") return agent.agentSession.value === childSessionId;
  const candidate = resolve(agent.agentSession.value);
  if (childSessionPath && candidate === resolve(childSessionPath)) return true;
  if (dirname(candidate) !== resolve(childSessionDir)) return false;
  const suffix = `_${childSessionId}.jsonl`;
  const filename = basename(candidate);
  if (!filename.endsWith(suffix)) return false;
  const timestamp = filename.slice(0, -suffix.length);
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(timestamp);
}

export class SubagentRuntime {
  readonly runs = new Map<string, RunRecord>();
  readonly instanceId: string;
  readonly parentProcessId: number;
  readonly #idFactory: () => string;
  readonly #readinessTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #quietPeriodMs: number;
  readonly #reconnectDelaysMs: readonly number[];
  readonly #monitorDelay: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #observeChildSession: typeof observeChildSession;
  readonly #cleanupTimeoutMs: number;
  readonly #gitStatus?: GitStatus;
  readonly #appendState?: RuntimeOptions["appendState"];
  readonly #appendArtifactSection: typeof appendArtifactSection;
  readonly #deliverResult?: (message: ResultDelivery) => void;
  readonly #deliverAction?: (message: ActionDelivery) => void;
  readonly #agentDir: string;
  readonly #onRunsChanged?: () => void;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #now: () => number;
  #parent?: BoundParent;
  #workerStarting = false;
  #deliverySinceSettlement = false;
  #diagnostics: LifecycleDiagnostic[] = [];

  constructor(
    readonly client: HerdrClient,
    readonly environment: RuntimeEnvironment,
    options: RuntimeOptions = {},
  ) {
    if (!environment.workspaceId) throw new Error("HERDR_WORKSPACE_ID is required");
    this.#idFactory = options.idFactory ?? (() => `run-${randomUUID()}`);
    this.instanceId = (options.instanceIdFactory ?? randomUUID)();
    this.parentProcessId = options.parentProcessId ?? process.pid;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.#reconnectDelaysMs = [...(options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS)];
    this.#monitorDelay = options.monitorDelay ?? delay;
    this.#observeChildSession = options.observeChildSession ?? observeChildSession;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    this.#gitStatus = options.gitStatus;
    this.#appendState = options.appendState;
    this.#appendArtifactSection = options.appendArtifact ?? appendArtifactSection;
    this.#deliverResult = options.deliverResult;
    this.#deliverAction = options.deliverAction;
    this.#agentDir = environment.agentDir ?? getAgentDir();
    this.#onRunsChanged = options.onRunsChanged;
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.#now = options.now ?? Date.now;
  }

  async bindParent(
    binding: ParentSessionBinding,
    branch: readonly SessionEntry[],
    reason: "startup" | "reload" | "new" | "resume" | "fork",
  ): Promise<readonly LifecycleDiagnostic[]> {
    this.#parent = {
      ...binding,
      parentInstanceId: this.instanceId,
      parentProcessId: this.parentProcessId,
    };
    this.#diagnostics = [];
    if (!binding.parentSessionFile) return this.#diagnostics;

    const replayed = reconstructHerdrJournal(branch, binding.parentSessionId, binding.parentSessionFile);
    if (reason === "reload") {
      for (const { latest } of replayed.runs.values()) {
        if (!TERMINAL.has(latest.state)) continue;
        this.#diagnostics.push({
          runId: latest.runId,
          outcome: latest.state as "closed" | "retained",
          message: `Prior reload cleanup ${latest.state} run ${latest.runId}`,
          ...(latest.retained ? { retained: [...latest.retained] } : {}),
        });
      }
      return [...this.#diagnostics];
    }

    if (replayed.invalidEntries > 0) {
      this.#diagnostics.push({
        runId: "<unknown>",
        outcome: "identity_mismatch",
        message: `${replayed.invalidEntries} malformed active-branch ${HERDR_STATE_CUSTOM_TYPE} record(s) were left untouched`,
      });
    }
    const cleanupSignal = AbortSignal.timeout(this.#cleanupTimeoutMs);
    for (const replay of replayed.runs.values()) {
      const record = replay.latest;
      if (record.parentInstanceId === this.instanceId) continue;
      if (record.state === "retained" && record.archivePending === true) {
        if (this.#isProcessAlive(record.parentProcessId)) {
          this.#diagnostics.push({
            runId: record.runId,
            outcome: "live_owner",
            message: `Run ${record.runId} belongs to live parent process ${record.parentProcessId}; left untouched`,
          });
          continue;
        }
        const mismatch = await this.#residueMismatch(record, cleanupSignal);
        if (mismatch) {
          this.#diagnostics.push({
            runId: record.runId,
            outcome: "identity_mismatch",
            message: `Run ${record.runId} archive recovery was not bound: ${mismatch}`,
          });
          continue;
        }
        const run = this.#replayedRun(replay);
        run.lifecycle = "retained";
        run.archivePending = true;
        this.runs.set(run.id, run);
        this.#diagnostics.push({
          runId: record.runId,
          outcome: "retained",
          message: `Run ${record.runId} retained for exact result archival recovery through subagent_stop`,
          ...(record.retained ? { retained: [...record.retained] } : {}),
        });
        continue;
      }
      if (record.state === "retained" && replay.childStopped && record.worktree) {
        if (this.#isProcessAlive(record.parentProcessId)) {
          this.#diagnostics.push({
            runId: record.runId,
            outcome: "live_owner",
            message: `Run ${record.runId} belongs to live parent process ${record.parentProcessId}; left untouched`,
          });
          continue;
        }
        const mismatch = await this.#stoppedWorkerResidueMismatch(record, cleanupSignal);
        if (mismatch) {
          this.#diagnostics.push({
            runId: record.runId,
            outcome: "identity_mismatch",
            message: `Run ${record.runId} cleanup-only reconciliation was not authorized: ${mismatch}`,
          });
          continue;
        }
        const run = this.#replayedRun(replay);
        run.lifecycle = "stopping";
        try {
          this.#record(run, "stopping");
        } catch (error) {
          this.#diagnostics.push({
            runId: record.runId,
            outcome: "retained",
            message: `Run ${record.runId} cleanup-only reconciliation was not started because its journal failed: ${errorMessage(error)}`,
          });
          continue;
        }
        const stopped = await this.#cleanupRun(run, cleanupSignal, false);
        if (stopped.run.lifecycle === "retained") this.runs.set(run.id, run);
        this.#diagnostics.push({
          runId: record.runId,
          outcome: stopped.run.lifecycle === "closed" ? "cleaned" : "retained",
          message: `Proven-stopped worker ${record.runId} cleanup ${stopped.run.lifecycle}`,
          ...(stopped.retained.length ? { retained: [...stopped.retained] } : {}),
        });
        continue;
      }
      if (TERMINAL.has(record.state)) {
        this.#diagnostics.push({
          runId: record.runId,
          outcome: record.state as "closed" | "retained",
          message: `Prior owner left run ${record.runId} ${record.state}`,
          ...(record.retained ? { retained: [...record.retained] } : {}),
        });
        continue;
      }
      if (this.#isProcessAlive(record.parentProcessId)) {
        this.#diagnostics.push({
          runId: record.runId,
          outcome: "live_owner",
          message: `Run ${record.runId} belongs to live parent process ${record.parentProcessId}; left untouched`,
        });
        continue;
      }

      const mismatch = await this.#residueMismatch(record, cleanupSignal);
      if (mismatch) {
        this.#diagnostics.push({
          runId: record.runId,
          outcome: "identity_mismatch",
          message: `Run ${record.runId} was not cleaned: ${mismatch}`,
        });
        continue;
      }

      const run = this.#replayedRun(replay);
      run.lifecycle = "stopping";
      try {
        this.#record(run, "stopping");
      } catch (error) {
        this.#diagnostics.push({
          runId: record.runId,
          outcome: "retained",
          message: `Run ${record.runId} cleanup was not started because its stopping record failed: ${errorMessage(error)}`,
        });
        continue;
      }
      const stopped = await this.#cleanupRun(run, cleanupSignal, false);
      this.#diagnostics.push({
        runId: record.runId,
        outcome: stopped.run.lifecycle === "closed" ? "cleaned" : "retained",
        message: `Dead-owner run ${record.runId} cleanup ${stopped.run.lifecycle}`,
        ...(stopped.retained.length ? { retained: [...stopped.retained] } : {}),
      });
    }
    return [...this.#diagnostics];
  }

  diagnostics(): readonly LifecycleDiagnostic[] {
    return this.#diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.retained ? { retained: [...diagnostic.retained] } : {}),
    }));
  }

  requestFor(binding: ParentSessionBinding): ParentRequest {
    const parent = this.#context({ ...binding, parentInstanceId: this.instanceId });
    return {
      parentSessionId: parent.parentSessionId,
      parentSessionFile: parent.parentSessionFile,
      parentEntryId: parent.parentEntryId,
      parentInstanceId: parent.parentInstanceId,
    };
  }

  list(request?: Partial<ParentRequest>): Run[] {
    const owner = this.#context(request);
    return [...this.runs.values()]
      .filter((run) => run.parentSessionId === owner.parentSessionId && run.parentInstanceId === owner.parentInstanceId)
      .map(cloneRun);
  }

  status(id: string, request?: Partial<ParentRequest>): Run {
    return cloneRun(this.#run(id, request));
  }

  hasOpenRuns(request?: Partial<ParentRequest>): boolean {
    const owner = this.#context(request);
    return [...this.runs.values()].some((run) =>
      run.parentSessionId === owner.parentSessionId
      && run.parentInstanceId === owner.parentInstanceId
      && run.lifecycle !== "closed"
      && run.lifecycle !== "retained");
  }

  async start(
    profile: ProfileName,
    task: string,
    cwd: string,
    request: GenerationRequest = {},
  ): Promise<Run> {
    if (!task.trim()) throw new Error("task must not be empty");
    const timeoutMs = validateWait(request);
    const parent = this.#context(request, true);
    const worker = profile === "worker";
    if (worker && (this.#workerStarting || [...this.runs.values()].some((run) => run.profile === "worker" && run.lifecycle !== "closed" && run.lifecycle !== "retained"))) {
      throw new Error("Only one worker may be active at a time");
    }
    if (worker) this.#workerStarting = true;

    const id = this.#idFactory();
    const artifactIdentity: ArtifactIdentity = {
      agentDir: this.#agentDir,
      parentSessionId: parent.parentSessionId,
      runId: id,
    };
    const artifactPath = resolveArtifactLocation(artifactIdentity).path;
    let tabId: string | undefined;
    let rootPaneId: string | undefined;
    let worktree: WorktreeFacts | undefined;
    let childSessionDir: string | undefined;
    let agent: AgentInfo | undefined;
    let run: RunRecord | undefined;
    let inputAttempted = false;

    try {
      let workspaceId: string;
      if (worker) {
        const topology = await createWorkerWorktree(
          this.client,
          this.environment.workspaceId,
          cwd,
          id,
          parent.parentSessionId,
          request.signal,
        );
        tabId = topology.tabId;
        rootPaneId = topology.rootPaneId;
        workspaceId = topology.worktree.workspaceId;
        worktree = topology.worktree;
      } else {
        const tab = await this.client.createTab({
          workspace_id: this.environment.workspaceId,
          label: `subagent:${parent.parentSessionId.slice(0, 8)}:${id}`,
          cwd,
          focus: false,
        }, request.signal);
        tabId = tab.tabId;
        rootPaneId = tab.rootPaneId;
        workspaceId = tab.workspaceId;
      }

      const childCwd = worktree?.path ?? cwd;
      const location = createChildSessionLocation(parent.parentSessionId, id, childCwd, this.environment.agentDir);
      childSessionDir = location.childSessionDir;
      const launch = buildPiLaunch(profile, id, location.childSessionDir, location.childSessionId, artifactPath);
      agent = await this.client.startAgent({
        name: launch.name,
        argv: launch.argv,
        workspace_id: workspaceId,
        tab_id: tabId,
        cwd: childCwd,
        env: launch.env,
        focus: false,
      }, request.signal);
      const now = this.#now();
      run = {
        id,
        parentSessionId: parent.parentSessionId,
        parentInstanceId: parent.parentInstanceId,
        profile,
        childSessionId: location.childSessionId,
        childSessionDir: location.childSessionDir,
        childCwd,
        artifactPath,
        terminalId: agent.terminalId,
        paneId: agent.paneId,
        tabId: agent.tabId,
        workspaceId: agent.workspaceId,
        location,
        lifecycle: "starting",
        status: agent.status,
        createdAt: now,
        updatedAt: now,
        ...(worktree ? { worktree } : {}),
      };
      run.warning = workerWarning(run);
      this.runs.set(id, run);
      this.#record(run, "starting");
      this.#notifyRunsChanged();

      const deadline = this.#now() + this.#readinessTimeoutMs;
      while (true) {
        const ready = await this.#getAgentBefore(run, deadline, this.#readinessTimeoutMs, "Pi readiness", request.signal);
        this.#updateRun(run, ready);
        if (matchesChildSession(ready, run.childSessionId, run.childSessionDir, run.childSessionPath) && READY.has(run.status)) break;
        await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - this.#now())), request.signal);
      }

      run.generation = {
        number: 1,
        input: task,
        baselineEntryId: null,
        delivery: "pending",
        blockingWaiter: request.wait === true,
      };
      run.lifecycle = "live";
      run.updatedAt = this.#now();
      this.#record(run, "live");
      await this.#appendArtifact(run,
        renderArtifactHeader({
          runId: run.id,
          profile: run.profile,
          ...(run.worktree ? { worker: {
            path: run.worktree.path,
            branch: run.worktree.branch,
            workspaceId: run.worktree.workspaceId,
          } } : {}),
        }) + renderGenerationSection({ generation: 1, speaker: "Parent", body: task }),
      );
      run.generation.artifactParentPersisted = true;
      this.#record(run, "generation_pending");
      this.#notifyRunsChanged();
      this.#prepareCompletion(run);
      inputAttempted = true;
      try {
        await this.client.sendInput(run.paneId, task, request.signal);
      } catch (error) {
        run.error = `Initial input acknowledgement failed and may have executed: ${errorMessage(error)}`;
        run.generation.error = run.error;
        run.generation.blockingWaiter = false;
        this.#startMonitor(run);
        throw new Error(`${run.error}; retained current run id=${run.id}`, { cause: error });
      }
      this.#startMonitor(run);
    } catch (error) {
      if (inputAttempted) throw error;
      let retained: readonly string[] = [];
      if (run) {
        run.lifecycle = "stopping";
        run.monitorController?.abort(new Error(`Startup failed: ${run.id}`));
        try {
          this.#record(run, "stopping");
          this.#notifyRunsChanged();
        } catch { /* preserve the original startup error */ }
        const signal = AbortSignal.timeout(this.#cleanupTimeoutMs);
        const stopped = await this.#cleanupRun(run, signal, true);
        retained = stopped.retained;
      } else {
        retained = await this.#cleanupStartup(agent, tabId, rootPaneId, worktree, childSessionDir);
      }
      throw new Error(`${errorMessage(error)}${retained.length ? `; retained ${retained.join(", ")}` : ""}`, { cause: error });
    } finally {
      if (worker) this.#workerStarting = false;
    }

    if (request.wait) await this.#waitForGeneration(run!, timeoutMs, request.signal);
    return cloneRun(run!);
  }

  async send(id: string, input: string, request: GenerationRequest = {}): Promise<Run> {
    if (!input.trim()) throw new Error("message must not be empty");
    const timeoutMs = validateWait(request);
    const run = this.#run(id, request);
    if (run.lifecycle !== "live") throw new Error(`Run is not live: ${id}`);
    if (run.generation && run.generation.delivery !== "delivered") {
      throw new Error(`Run ${id} already has generation ${run.generation.number} in ${run.generation.delivery} state`);
    }

    const cursor = await captureChildCursor(run.location);
    run.childSessionPath = cursor.childSessionPath;
    const generationNumber = (run.generation?.number ?? 0) + 1;
    await this.#appendArtifact(run,
      renderGenerationSection({ generation: generationNumber, speaker: "Parent", body: input }),
    );
    run.generation = {
      number: generationNumber,
      input,
      baselineEntryId: cursor.baselineEntryId,
      delivery: "pending",
      blockingWaiter: request.wait === true,
      artifactParentPersisted: true,
    };
    run.latestResult = undefined;
    run.resultContent = undefined;
    run.error = undefined;
    run.updatedAt = this.#now();
    this.#record(run, "generation_pending");
    this.#notifyRunsChanged();
    this.#prepareCompletion(run);
    try {
      await this.client.sendInput(run.paneId, input, request.signal);
    } catch (error) {
      run.error = `Follow-up input acknowledgement failed and may have executed: ${errorMessage(error)}`;
      run.generation.error = run.error;
      run.generation.blockingWaiter = false;
      this.#startMonitor(run);
      throw new Error(`${run.error}; retained current run id=${run.id}`, { cause: error });
    }
    this.#startMonitor(run);
    if (request.wait) await this.#waitForGeneration(run, timeoutMs, request.signal);
    return cloneRun(run);
  }

  async stop(id: string, request: Partial<ParentRequest> = {}): Promise<StopResult> {
    const run = this.#run(id, request);
    if (run.cleanup) return run.cleanup;
    if (run.lifecycle === "closed") {
      return { run: cloneRun(run), retained: [...(run.retained ?? [])] };
    }
    const signal = AbortSignal.timeout(this.#cleanupTimeoutMs);
    const attempt = this.#stopAttempt(run, signal);
    run.cleanup = attempt;
    void attempt.then(
      () => { if (run.lifecycle === "retained" && run.cleanup === attempt) run.cleanup = undefined; },
      () => { if (run.cleanup === attempt) run.cleanup = undefined; },
    );
    return attempt;
  }

  async #stopAttempt(run: RunRecord, signal: AbortSignal): Promise<StopResult> {
    if (run.archivePending && !await this.#recoverPendingArtifact(run)) {
      return { run: cloneRun(run), retained: [...(run.retained ?? [])] };
    }
    run.error = undefined;
    run.retained = undefined;
    try {
      this.#markStopping(run, `Run stopped: ${run.id}`);
    } catch (error) {
      run.lifecycle = "retained";
      run.error = `Stopping journal failed: ${errorMessage(error)}`;
      const retained: string[] = [];
      if (!retained.includes("journal=herdr-subagent-state")) retained.push("journal=herdr-subagent-state");
      run.retained = retained;
      run.updatedAt = this.#now();
      this.#notifyRunsChanged();
      return { run: cloneRun(run), retained };
    }
    return this.#cleanupRun(run, signal, false);
  }

  async settle(request: Partial<ParentRequest> = {}): Promise<readonly StopResult[]> {
    const owner = this.#context(request);
    const open = [...this.runs.values()].filter((run) =>
      run.parentSessionId === owner.parentSessionId
      && run.parentInstanceId === owner.parentInstanceId
      && run.lifecycle !== "closed"
      && run.lifecycle !== "retained");
    if (!open.length || !this.#deliverySinceSettlement) return [];
    if (open.some((run) => run.lifecycle !== "live" || !run.generation || run.generation.delivery !== "delivered")) return [];
    const results = await this.#cleanupMany(open, "Parent agent settled after result delivery");
    this.#deliverySinceSettlement = false;
    return results;
  }

  async shutdown(reason: ShutdownReason): Promise<readonly StopResult[]> {
    const parent = this.#parent;
    if (!parent) return [];
    const open = [...this.runs.values()].filter((run) =>
      run.parentSessionId === parent.parentSessionId
      && run.parentInstanceId === parent.parentInstanceId
      && run.lifecycle !== "closed"
      && run.lifecycle !== "retained");
    return this.#cleanupMany(open, `Parent session shutdown: ${reason}`);
  }

  confirmDelivery(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const custom = message as Record<string, unknown>;
    if (custom.role !== "custom" || custom.customType !== "herdr-subagent-result") return false;
    if (typeof custom.details !== "object" || custom.details === null) return false;
    const details = custom.details as Record<string, unknown>;
    if (typeof details.runId !== "string") return false;
    const run = this.runs.get(details.runId);
    const generation = run?.generation;
    if (!run || run.parentInstanceId !== this.instanceId || !generation || generation.delivery !== "queued") return false;
    if (
      details.parentSessionId !== run.parentSessionId
      || details.artifactPath !== run.artifactPath
      || details.profile !== run.profile
      || details.generation !== generation.number
      || details.childSessionId !== run.childSessionId
      || details.childEntryId !== generation.resultEntryId
    ) return false;
    generation.delivery = "delivered";
    run.updatedAt = this.#now();
    this.#record(run, "result_delivered");
    this.#notifyRunsChanged();
    this.#deliverySinceSettlement = true;
    return true;
  }

  #context(request?: Partial<ParentRequest>, requirePersisted = false): BoundParent {
    const parent = this.#parent;
    if (!parent) throw new Error("Parent session lifecycle is not bound");
    if (request?.parentSessionId !== undefined && request.parentSessionId !== parent.parentSessionId) {
      throw new Error("Current parent session does not own this runtime");
    }
    if (request && Object.hasOwn(request, "parentSessionFile") && request.parentSessionFile !== parent.parentSessionFile) {
      throw new Error("Current parent session file does not own this runtime");
    }
    if (request?.parentInstanceId !== undefined && request.parentInstanceId !== parent.parentInstanceId) {
      throw new Error("Current parent extension instance does not own this runtime");
    }
    if (request && Object.hasOwn(request, "parentEntryId")) parent.parentEntryId = request.parentEntryId ?? null;
    if (requirePersisted && !parent.parentSessionFile) {
      throw new Error("Cannot start a subagent from an ephemeral parent session; save or resume a persisted session first");
    }
    if (requirePersisted && !this.#appendState) throw new Error("Parent session journal callback is unavailable");
    return parent;
  }

  #run(id: string, request?: Partial<ParentRequest>): RunRecord {
    const owner = this.#context(request);
    const run = this.runs.get(id);
    if (!run || run.parentSessionId !== owner.parentSessionId || run.parentInstanceId !== owner.parentInstanceId) {
      throw new Error(`Unknown current-parent/current-instance run: ${id}`);
    }
    return run;
  }

  #generationRecord(generation?: Generation): JournalGeneration | undefined {
    if (!generation) return undefined;
    return {
      number: generation.number,
      baselineEntryId: generation.baselineEntryId,
      delivery: generation.delivery,
      ...(generation.resultEntryId ? { resultEntryId: generation.resultEntryId } : {}),
      ...(generation.returned ? { returned: true } : {}),
      ...(generation.artifactParentPersisted ? { artifactParentPersisted: true } : {}),
      ...(generation.artifactResultPersisted ? { artifactResultPersisted: true } : {}),
    };
  }

  #record(run: RunRecord, state: HerdrLifecycleState, workerCleanup?: WorkerCleanup): void {
    const parent = this.#parent;
    if (!parent?.parentSessionFile || !this.#appendState) throw new Error("Durable parent session journal is unavailable");
    const record: HerdrStateRecord = {
      state,
      at: this.#now(),
      parentSessionId: parent.parentSessionId,
      parentSessionFile: parent.parentSessionFile,
      parentEntryId: parent.parentEntryId,
      parentInstanceId: parent.parentInstanceId,
      parentProcessId: parent.parentProcessId,
      runId: run.id,
      childSessionId: run.childSessionId,
      childSessionDir: run.childSessionDir,
      ...(run.childSessionPath ? { childSessionPath: run.childSessionPath } : {}),
      childCwd: run.childCwd,
      artifactPath: run.artifactPath,
      terminalId: run.terminalId,
      paneId: run.paneId,
      tabId: run.tabId,
      workspaceId: run.workspaceId,
      profile: run.profile,
      status: run.status,
      ...(run.generation ? { generation: this.#generationRecord(run.generation) } : {}),
      ...(state === "result_ready" && run.latestResult ? { result: run.latestResult } : {}),
      ...(run.worktree ? { worktree: { ...run.worktree } } : {}),
      ...(run.retained ? { retained: [...run.retained] } : {}),
      ...(run.childStopped ? { childStopped: true } : {}),
      ...(run.archivePending ? { archivePending: true } : {}),
      ...(workerCleanup ? { workerCleanup } : {}),
      ...(run.error ? { error: run.error } : {}),
    };
    this.#appendState(HERDR_STATE_CUSTOM_TYPE, record);
  }

  async #appendArtifact(run: Pick<Run, "id" | "parentSessionId" | "artifactPath">, section: string): Promise<void> {
    try {
      await this.#appendArtifactSection({
        agentDir: this.#agentDir,
        parentSessionId: run.parentSessionId,
        runId: run.id,
      }, section);
    } catch (error) {
      throw new Error(`Artifact persistence failed for run ${run.id} at ${run.artifactPath}: ${errorMessage(error)}`, { cause: error });
    }
  }

  async #recoverPendingArtifact(run: RunRecord): Promise<boolean> {
    const generation = run.generation;
    if (!generation) return false;
    try {
      let result = run.latestResult;
      if (!result) {
        const recovered = await readChildResult(run.location, generation.baselineEntryId, "idle");
        if (!recovered) throw new Error("Preserved child result could not be read");
        run.childSessionPath = recovered.childSessionPath;
        result = { childEntryId: recovered.childEntryId, text: recovered.text, message: recovered.message };
        run.latestResult = result;
      }
      if (!generation.artifactResultPersisted) {
        await this.#appendArtifact(run,
          renderGenerationSection({ generation: generation.number, speaker: "Subagent", body: result.text }),
        );
        generation.artifactResultPersisted = true;
      }
      generation.resultEntryId = result.childEntryId;
      const alreadyReturned = generation.returned === true;
      if (!alreadyReturned) generation.delivery = "ready";
      generation.error = undefined;
      run.archivePending = undefined;
      run.error = undefined;
      run.retained = undefined;
      run.resultContent = formatSubagentResult(run, result);
      run.updatedAt = this.#now();
      this.#record(run, "result_ready");
      if (!alreadyReturned) {
        generation.delivery = "delivered";
        generation.returned = true;
      }
      run.archiveRecovered = true;
      this.#record(run, "result_delivered");
      this.#notifyRunsChanged();
      return true;
    } catch (error) {
      run.archivePending = true;
      run.lifecycle = "retained";
      run.error = `Result archive recovery failed: ${errorMessage(error)}`;
      generation.error = run.error;
      run.retained = this.#allResourceFacts(run);
      run.updatedAt = this.#now();
      try { this.#record(run, "retained"); } catch { /* tool result still exposes the exact failure */ }
      this.#notifyRunsChanged();
      return false;
    }
  }

  #notifyRunsChanged(): void {
    try { this.#onRunsChanged?.(); } catch { /* presentation invalidation must not affect runtime behavior */ }
  }

  #prepareCompletion(run: RunRecord): void {
    run.completion = new Promise((resolvePromise) => { run.complete = resolvePromise; });
  }

  #startMonitor(run: RunRecord): void {
    const generation = run.generation!;
    if (run.monitorGeneration === generation.number && run.monitor && !run.monitorController?.signal.aborted) return;
    run.monitorController?.abort(new Error(`Generation ${generation.number - 1} was replaced`));
    const controller = new AbortController();
    run.monitorController = controller;
    run.monitorGeneration = generation.number;
    run.monitor = this.#monitor(run, generation, controller);
  }

  #monitorIsCurrent(run: RunRecord, generation: Generation, controller: AbortController): boolean {
    return !controller.signal.aborted
      && run.lifecycle === "live"
      && run.generation === generation
      && run.monitorGeneration === generation.number
      && run.monitorController === controller;
  }

  #assertMonitorCurrent(run: RunRecord, generation: Generation, controller: AbortController): void {
    if (this.#monitorIsCurrent(run, generation, controller)) return;
    const reason = controller.signal.reason;
    throw reason instanceof Error ? reason : new Error(`Monitor is no longer current for run ${run.id}`);
  }

  #validateMonitorAgent(run: RunRecord, agent: AgentInfo): void {
    if (
      agent.terminalId !== run.terminalId
      || agent.paneId !== run.paneId
      || agent.tabId !== run.tabId
      || agent.workspaceId !== run.workspaceId
    ) throw new Error(`Herdr topology changed for run ${run.id}`);
    if (!matchesChildSession(agent, run.childSessionId, run.childSessionDir, run.childSessionPath)) {
      throw new Error(`Child session identity changed for run ${run.id}`);
    }
  }

  #applyMonitorFacts(
    run: RunRecord,
    agentStatus: AgentStatus,
    observation?: ChildSessionObservation,
  ): void {
    const statusChanged = run.status !== agentStatus;
    run.status = agentStatus;
    if (observation) run.childSessionPath = observation.childSessionPath;
    run.updatedAt = this.#now();
    if (statusChanged) this.#notifyRunsChanged();
  }

  #candidate(observation: ChildSessionObservation | undefined): ResultCandidate | undefined {
    if (!observation?.result) return undefined;
    return {
      observation: observation as ChildSessionObservation & { result: ChildResult },
      fingerprint: JSON.stringify([
        observation.childSessionPath,
        observation.activeLeafId,
        observation.latestCompactionId ?? null,
        observation.result.childEntryId,
        observation.result.text,
      ]),
    };
  }

  async #reconcileMonitor(
    run: RunRecord,
    generation: Generation,
    controller: AbortController,
  ): Promise<ResultCandidate | undefined> {
    const [agent, observation] = await Promise.all([
      this.client.getAgent(run.terminalId, controller.signal),
      this.#observeChildSession(run.location, generation.baselineEntryId),
    ]);
    this.#assertMonitorCurrent(run, generation, controller);
    this.#validateMonitorAgent(run, agent);
    this.#applyMonitorFacts(run, agent.status, observation);
    return RESULT_ELIGIBLE.has(agent.status) ? this.#candidate(observation) : undefined;
  }

  async #observeEligibleEvent(
    run: RunRecord,
    generation: Generation,
    controller: AbortController,
    event: AgentStatusEvent,
  ): Promise<ResultCandidate | undefined> {
    if (event.paneId !== run.paneId || event.workspaceId !== run.workspaceId) {
      throw new Error(`Herdr subscription topology changed for run ${run.id}`);
    }
    if (!RESULT_ELIGIBLE.has(event.status)) {
      this.#assertMonitorCurrent(run, generation, controller);
      this.#applyMonitorFacts(run, event.status);
      return undefined;
    }
    const observation = await this.#observeChildSession(run.location, generation.baselineEntryId);
    this.#assertMonitorCurrent(run, generation, controller);
    this.#applyMonitorFacts(run, event.status, observation);
    return this.#candidate(observation);
  }

  async #finalizeResult(
    run: RunRecord,
    generation: Generation,
    candidate: ResultCandidate,
    controller: AbortController,
  ): Promise<void> {
    this.#assertMonitorCurrent(run, generation, controller);
    const result = candidate.observation.result;
    run.childSessionPath = candidate.observation.childSessionPath;
    run.latestResult = { childEntryId: result.childEntryId, text: result.text, message: result.message };
    try {
      await this.#appendArtifact(run,
        renderGenerationSection({ generation: generation.number, speaker: "Subagent", body: result.text }),
      );
    } catch (error) {
      if (!this.#monitorIsCurrent(run, generation, controller)) return;
      controller.abort(error);
      run.archivePending = true;
      run.lifecycle = "retained";
      run.error = `Result archive required before delivery: ${errorMessage(error)}`;
      generation.error = run.error;
      run.retained = this.#allResourceFacts(run);
      run.updatedAt = this.#now();
      try { this.#record(run, "retained"); } catch { /* preserve the archive error */ }
      this.#notifyRunsChanged();
      if (!run.archiveActionSent) {
        run.archiveActionSent = true;
        try {
          this.#deliverAction?.({
            customType: "herdr-subagent-action",
            content: `Run ${run.id} result is preserved but not delivered because its artifact could not be written. Artifact: ${run.artifactPath}. Retry with subagent_stop({ id: "${run.id}" }).`,
            display: true,
            details: {
              parentSessionId: run.parentSessionId,
              runId: run.id,
              artifactPath: run.artifactPath,
              reason: run.error,
            },
          });
        } catch { /* an action notice must not weaken retention */ }
      }
      run.complete?.({ error: new Error(run.error) });
      return;
    }
    this.#assertMonitorCurrent(run, generation, controller);
    generation.artifactResultPersisted = true;
    run.resultContent = formatSubagentResult(run, run.latestResult);
    generation.resultEntryId = result.childEntryId;
    generation.error = undefined;
    generation.delivery = "ready";
    run.error = undefined;
    run.updatedAt = this.#now();
    this.#record(run, "result_ready");
    this.#notifyRunsChanged();
    if (generation.blockingWaiter) {
      generation.delivery = "delivered";
      generation.returned = true;
      this.#record(run, "result_delivered");
      this.#notifyRunsChanged();
      this.#deliverySinceSettlement = true;
      run.complete?.({ result: run.latestResult });
    } else {
      run.complete?.({ result: run.latestResult });
      this.#queueDelivery(run, generation, run.latestResult);
    }
    controller.abort(new Error(`Generation ${generation.number} finalized`));
  }

  async #monitor(run: RunRecord, generation: Generation, controller: AbortController): Promise<void> {
    let reconnectAttempt = 0;
    let subscription: AgentStatusSubscription | undefined;
    let quietController: AbortController | undefined;
    try {
      while (this.#monitorIsCurrent(run, generation, controller)) {
        try {
          subscription = await this.client.subscribeAgentStatus(run.paneId, run.workspaceId, controller.signal);
          const activeSubscription = subscription;
          this.#assertMonitorCurrent(run, generation, controller);
          let candidate = await this.#reconcileMonitor(run, generation, controller);
          let bufferedStreamOutcome: StatusStreamOutcome | undefined;
          const readNextEvent = (): Promise<StatusStreamOutcome> => activeSubscription.next().then(
            (next): StatusStreamOutcome => ({ kind: "event", next }),
            (error: unknown): StatusStreamOutcome => ({ kind: "stream-error", error }),
          ).then((outcome) => {
            bufferedStreamOutcome = outcome;
            return outcome;
          });
          let nextEvent = readNextEvent();
          while (this.#monitorIsCurrent(run, generation, controller)) {
            quietController?.abort(new Error("Quiet window replaced"));
            quietController = undefined;
            const quietOutcome = candidate
              ? (() => {
                  quietController = new AbortController();
                  const signal = AbortSignal.any([controller.signal, quietController.signal]);
                  return this.#monitorDelay(this.#quietPeriodMs, signal).then(
                    () => ({ kind: "quiet" as const }),
                    (error: unknown) => ({ kind: "quiet-error" as const, error, signal }),
                  );
                })()
              : undefined;
            const outcome = await (quietOutcome ? Promise.race([nextEvent, quietOutcome]) : nextEvent);
            this.#assertMonitorCurrent(run, generation, controller);

            if (outcome.kind === "stream-error") throw outcome.error;
            if (outcome.kind === "quiet-error") {
              if (outcome.signal.aborted) continue;
              throw outcome.error;
            }
            if (outcome.kind === "event") {
              bufferedStreamOutcome = undefined;
              if (outcome.next.done) throw new CleanSubscriptionEof();
              candidate = await this.#observeEligibleEvent(run, generation, controller, outcome.next.value);
              nextEvent = readNextEvent();
              continue;
            }

            const prior = candidate!;
            const confirmed = await this.#reconcileMonitor(run, generation, controller);
            await Promise.resolve();
            const duringReconciliation = bufferedStreamOutcome;
            if (duringReconciliation) {
              bufferedStreamOutcome = undefined;
              if (duringReconciliation.kind === "stream-error") throw duringReconciliation.error;
              if (duringReconciliation.next.done) throw new CleanSubscriptionEof();
              candidate = await this.#observeEligibleEvent(
                run,
                generation,
                controller,
                duringReconciliation.next.value,
              );
              nextEvent = readNextEvent();
              continue;
            }
            if (!confirmed) {
              candidate = undefined;
            } else if (confirmed.fingerprint === prior.fingerprint) {
              await this.#finalizeResult(run, generation, confirmed, controller);
              return;
            } else {
              candidate = confirmed;
            }
          }
        } catch (error) {
          quietController?.abort(new Error("Subscription cycle ended"));
          quietController = undefined;
          try { await subscription?.return?.(); } catch { /* retain the original stream outcome */ }
          subscription = undefined;
          if (!this.#monitorIsCurrent(run, generation, controller)) return;
          const recoverable = error instanceof CleanSubscriptionEof
            || error instanceof HerdrSubscriptionTransportError;
          if (!recoverable || reconnectAttempt >= this.#reconnectDelaysMs.length) throw error;
          const backoff = this.#reconnectDelaysMs[reconnectAttempt++]!;
          await this.#monitorDelay(backoff, controller.signal);
          this.#assertMonitorCurrent(run, generation, controller);
        }
      }
    } catch (error) {
      if (!this.#monitorIsCurrent(run, generation, controller)) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      controller.abort(failure);
      generation.error = failure.message;
      run.error = failure.message;
      run.lifecycle = "retained";
      if (run.latestResult && generation.artifactResultPersisted) run.archivePending = true;
      run.retained = this.#allResourceFacts(run);
      run.updatedAt = this.#now();
      try { this.#record(run, "retained"); } catch { /* expose the monitor error through status */ }
      this.#notifyRunsChanged();
      if (run.archivePending && !run.archiveActionSent) {
        run.archiveActionSent = true;
        try {
          this.#deliverAction?.({
            customType: "herdr-subagent-action",
            content: `Run ${run.id} result is archived but its delivery journal did not complete. Artifact: ${run.artifactPath}. Retry with subagent_stop({ id: "${run.id}" }).`,
            display: true,
            details: {
              parentSessionId: run.parentSessionId,
              runId: run.id,
              artifactPath: run.artifactPath,
              reason: run.error,
            },
          });
        } catch { /* an action notice must not weaken retention */ }
      }
      run.complete?.({ error: failure });
    } finally {
      quietController?.abort(new Error("Monitor ended"));
      try { await subscription?.return?.(); } catch { /* monitor state already records any material failure */ }
    }
  }

  #queueDelivery(run: RunRecord, generation: Generation, result: ChildResult): void {
    if (run.lifecycle !== "live" || run.generation !== generation || generation.delivery !== "ready") return;
    generation.delivery = "queued";
    run.updatedAt = this.#now();
    this.#record(run, "result_queued");
    this.#notifyRunsChanged();
    const details: ResultDetails = {
      parentSessionId: run.parentSessionId,
      runId: run.id,
      artifactPath: run.artifactPath,
      profile: run.profile,
      generation: generation.number,
      childSessionId: run.childSessionId,
      childEntryId: result.childEntryId,
      ...(run.worktree ? { worktree: { ...run.worktree } } : {}),
    };
    try {
      this.#deliverResult?.({
        customType: "herdr-subagent-result",
        content: run.resultContent ?? formatSubagentResult(run, result),
        display: true,
        details,
      });
    } catch (error) {
      run.error = `Result delivery could not be injected: ${errorMessage(error)}`;
    }
  }

  async #waitForGeneration(run: RunRecord, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const generation = run.generation!;
    const timeout = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let outcome: GenerationOutcome;
    try {
      outcome = await Promise.race([
        run.completion!,
        new Promise<GenerationOutcome>((_resolve, reject) => {
          const abort = () => reject(bounded.reason);
          if (bounded.aborted) abort();
          else bounded.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (error) {
      if (run.generation === generation && generation.delivery === "delivered" && run.latestResult) return;
      if (run.generation === generation && generation.delivery === "pending") generation.blockingWaiter = false;
      if (!signal?.aborted && timeout.aborted) {
        throw new Error(`Wait timed out after ${timeoutMs}ms; run id=${run.id} generation=${generation.number} remains pending`, { cause: error });
      }
      throw new Error(`Wait ended; run id=${run.id} generation=${generation.number} remains pending`, { cause: error });
    }
    if (outcome.error) throw outcome.error;
  }

  async #getAgentBefore(
    run: RunRecord,
    deadline: number,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<AgentInfo> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    const timeout = AbortSignal.timeout(remaining);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.client.getAgent(run.terminalId, bounded);
    } catch (error) {
      if (!signal?.aborted && timeout.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`, { cause: error });
      throw error;
    }
  }

  #updateRun(run: RunRecord, agent: AgentInfo): void {
    const statusChanged = run.status !== agent.status;
    run.terminalId = agent.terminalId;
    run.paneId = agent.paneId;
    run.tabId = agent.tabId;
    run.workspaceId = agent.workspaceId;
    run.status = agent.status;
    run.updatedAt = this.#now();
    if (statusChanged) this.#notifyRunsChanged();
  }

  #markStopping(run: RunRecord, reason: string): void {
    if (run.lifecycle === "stopping" || run.lifecycle === "closed") return;
    run.lifecycle = "stopping";
    run.updatedAt = this.#now();
    run.monitorController?.abort(new Error(reason));
    this.#record(run, "stopping");
    this.#notifyRunsChanged();
  }

  async #cleanupMany(runs: RunRecord[], reason: string): Promise<readonly StopResult[]> {
    for (const run of runs) run.monitorController?.abort(new Error(reason));

    const signal = AbortSignal.timeout(this.#cleanupTimeoutMs);
    const results: StopResult[] = [];
    for (const run of runs) {
      if (!run.cleanup) {
        const previousLifecycle = run.lifecycle;
        const previousUpdatedAt = run.updatedAt;
        const changedToStopping = run.lifecycle !== "stopping" && run.lifecycle !== "closed" && run.lifecycle !== "retained";
        if (changedToStopping) {
          run.lifecycle = "stopping";
          run.updatedAt = this.#now();
        }
        try {
          this.#record(run, "stopping");
          this.#notifyRunsChanged();
        } catch {
          if (changedToStopping) {
            run.lifecycle = previousLifecycle;
            run.updatedAt = previousUpdatedAt;
          }
        }
        run.cleanup = this.#cleanupRun(run, signal, false);
      }
      const attempt = run.cleanup;
      const result = await attempt;
      results.push(result);
      if (result.run.lifecycle === "retained" && run.cleanup === attempt) run.cleanup = undefined;
    }
    return results;
  }

  async #cleanupStartup(
    agent: AgentInfo | undefined,
    tabId: string | undefined,
    rootPaneId: string | undefined,
    worktree: WorktreeFacts | undefined,
    childSessionDir: string | undefined,
  ): Promise<string[]> {
    const retained: string[] = [];
    const signal = AbortSignal.timeout(this.#cleanupTimeoutMs);
    let childStopped = false;
    let retainedPane: string | undefined;
    if (agent) {
      try { await this.client.closePane(agent.paneId, signal); childStopped = true; }
      catch { retainedPane = `pane=${agent.paneId}`; }
    }
    if (worktree) {
      const cleanup = await cleanupWorkerWorktree(this.client, worktree, signal, this.#gitStatus);
      retained.push(`branch=${cleanup.branch}`);
      if (cleanup.removed) {
        childStopped = true;
        retainedPane = undefined;
      } else {
        retained.push(`worktree=${cleanup.path}`);
      }
    } else if (tabId) {
      try { await this.client.closeTab(tabId, signal); childStopped = true; retainedPane = undefined; }
      catch { retained.push(`tab=${tabId}`); }
    } else if (rootPaneId) {
      retained.push(`rootPane=${rootPaneId}`);
    }
    if (retainedPane) retained.unshift(retainedPane);
    if (childSessionDir && await pathExists(childSessionDir)) {
      if (childStopped) {
        try { await rm(childSessionDir, { recursive: true, force: true }); }
        catch { retained.push(`sessionDir=${childSessionDir}`); }
      } else {
        retained.push(`sessionDir=${childSessionDir}`);
      }
    }
    return retained;
  }

  async #cleanupRun(run: RunRecord, signal: AbortSignal, allowUnjournaledWorkerSessionRemoval: boolean): Promise<StopResult> {
    const retained: string[] = [];
    let partial = false;
    let mayFinalize = true;
    let workerCleanup: WorkerCleanup | undefined;

    if (!run.childStopped) {
      try {
        await this.client.closePane(run.paneId, signal);
        if (!this.#persistChildStopped(run)) mayFinalize = false;
      } catch { /* an enclosing tab/worktree cleanup may still prove the child stopped */ }
    }

    if (!mayFinalize) {
      partial = true;
      retained.push("journal=herdr-subagent-state");
      if (run.worktree) retained.push(`branch=${run.worktree.branch}`, `worktree=${run.worktree.path}`);
      else retained.push(`tab=${run.tabId}`);
    } else if (run.worktree) {
      workerCleanup = await cleanupWorkerWorktree(this.client, run.worktree, signal, this.#gitStatus);
      retained.push(`branch=${workerCleanup.branch}`);
      if (workerCleanup.removed) {
        if (!run.childStopped && !this.#persistChildStopped(run)) {
          partial = true;
          retained.push("journal=herdr-subagent-state");
        }
      } else {
        partial = true;
        if (!run.childStopped) retained.unshift(`pane=${run.paneId}`);
        retained.push(`worktree=${workerCleanup.path}`);
      }
    } else {
      try {
        await this.client.closeTab(run.tabId, signal);
        if (!run.childStopped && !this.#persistChildStopped(run)) {
          partial = true;
          retained.push("journal=herdr-subagent-state");
        }
      } catch {
        partial = true;
        if (!run.childStopped) retained.push(`pane=${run.paneId}`);
        retained.push(`tab=${run.tabId}`);
      }
    }

    const childSessionPresent = await pathExists(run.childSessionDir);
    const generationMayContainResult = run.generation?.artifactParentPersisted === true;
    const resultArchived = run.generation?.artifactResultPersisted === true;
    const sessionRemovalAuthorized = run.childStopped === true
      && (!generationMayContainResult || resultArchived || allowUnjournaledWorkerSessionRemoval);
    if (childSessionPresent && !sessionRemovalAuthorized) {
      partial = true;
      retained.push(`sessionDir=${run.childSessionDir}`);
    }

    let cleanupArtifactPersisted = true;
    if (run.generation?.artifactParentPersisted) {
      const state = partial
        ? "action required"
        : workerCleanup?.removed && workerCleanup.action === "removed"
          ? "removed"
          : "finalized";
      const reason = workerCleanup && !workerCleanup.removed
        ? workerCleanup.reason
        : partial
          ? run.error ?? "owned resource cleanup was incomplete"
          : undefined;
      try {
        await this.#appendArtifact(run, renderCleanupSection({
          state,
          ...(reason ? { reason } : {}),
          ...(retained.length ? { retained: [...retained] } : {}),
          ...(state === "action required" ? {
            next: `Preserve the work, make the checkout safe, then retry subagent_stop({ id: "${run.id}" }). Do not use raw Git-only removal.`,
          } : {}),
        }));
      } catch (error) {
        cleanupArtifactPersisted = false;
        partial = true;
        run.error = `Cleanup artifact failed: ${errorMessage(error)}`;
        retained.push(`artifact=${run.artifactPath}`);
      }
    }

    if (childSessionPresent) {
      if (cleanupArtifactPersisted && sessionRemovalAuthorized) {
        try { await rm(run.childSessionDir, { recursive: true, force: true }); }
        catch {
          partial = true;
          retained.push(`sessionDir=${run.childSessionDir}`);
          try {
            await this.#appendArtifact(run, renderCleanupSection({
              state: "action required",
              reason: "child session removal failed",
              retained: [`sessionDir=${run.childSessionDir}`],
              next: `Retry subagent_stop({ id: "${run.id}" }).`,
            }));
          } catch { /* the prior complete cleanup section remains valid */ }
        }
      } else if (!retained.includes(`sessionDir=${run.childSessionDir}`)) {
        partial = true;
        retained.push(`sessionDir=${run.childSessionDir}`);
      }
    }

    run.retained = retained;
    run.lifecycle = partial ? "retained" : "closed";
    run.updatedAt = this.#now();
    try {
      this.#record(run, run.lifecycle, workerCleanup);
    } catch (error) {
      run.lifecycle = "retained";
      run.error = `Cleanup journal failed: ${errorMessage(error)}`;
      if (!retained.includes("journal=herdr-subagent-state")) retained.push("journal=herdr-subagent-state");
      run.retained = retained;
    }
    const result: StopResult = {
      run: cloneRun(run),
      retained: [...retained],
      ...(workerCleanup ? { workerCleanup } : {}),
    };
    if (run.lifecycle === "closed" && !run.archiveRecovered) this.runs.delete(run.id);
    this.#notifyRunsChanged();
    return result;
  }

  #persistChildStopped(run: RunRecord): boolean {
    if (run.childStopped) return true;
    run.childStopped = true;
    run.updatedAt = this.#now();
    try {
      this.#record(run, "stopping");
      return true;
    } catch (error) {
      run.childStopped = undefined;
      run.error = `Child-stop milestone journal failed: ${errorMessage(error)}`;
      return false;
    }
  }

  #allResourceFacts(run: RunRecord): string[] {
    return [
      `pane=${run.paneId}`,
      ...(run.worktree ? [`worktree=${run.worktree.path}`, `branch=${run.worktree.branch}`] : [`tab=${run.tabId}`]),
      `sessionDir=${run.childSessionDir}`,
    ];
  }

  async #stoppedWorkerResidueMismatch(record: HerdrStateRecord, signal: AbortSignal): Promise<string | undefined> {
    const worktree = record.worktree;
    if (!worktree) return "worker facts are missing";
    if (!/^run-[A-Za-z0-9._-]+$/.test(record.runId) || record.childSessionId !== `herdr-${record.runId}`) {
      return "run and child session IDs are not deterministic";
    }
    const expectedLocation = createChildSessionLocation(record.parentSessionId, record.runId, record.childCwd, this.#agentDir);
    if (resolve(record.childSessionDir) !== resolve(expectedLocation.childSessionDir)) {
      return "child session directory is not the deterministic owned path";
    }
    const expectedArtifactPath = resolveArtifactLocation({
      agentDir: this.#agentDir,
      parentSessionId: record.parentSessionId,
      runId: record.runId,
    }).path;
    if (record.artifactPath && resolve(record.artifactPath) !== resolve(expectedArtifactPath)) {
      return "artifact path is not the deterministic owned path";
    }
    if (
      worktree.workspaceId !== record.workspaceId
      || resolve(worktree.path) !== resolve(record.childCwd)
      || worktree.branch !== `herdr-subagents/${record.runId}`
      || resolve(worktree.path).split(/[\\/]/).at(-2) !== ".herdr-subagents-worktrees"
      || resolve(worktree.path).split(/[\\/]/).at(-1) !== record.runId
    ) return "journaled worker workspace, path, or branch identity is not exact";

    let pathAbsent = false;
    try {
      const stats = await lstat(worktree.path);
      if (stats.isSymbolicLink()) return "worker checkout path is a symbolic link";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") pathAbsent = true;
      else return `worker checkout path could not be checked (${errorMessage(error)})`;
    }

    try {
      const workspace = await this.client.getWorkspace(worktree.workspaceId, signal);
      if (
        workspace.workspaceId !== worktree.workspaceId
        || workspace.worktree === null
        || workspace.worktree.isLinkedWorktree !== true
        || resolve(workspace.worktree.checkoutPath) !== resolve(worktree.path)
      ) return "current Herdr workspace does not exactly match the linked worker checkout";
    } catch (error) {
      if (error instanceof HerdrError && error.code === "workspace_not_found" && pathAbsent) return undefined;
      return `current Herdr workspace could not be proven (${errorMessage(error)})`;
    }
    return undefined;
  }

  async #residueMismatch(record: HerdrStateRecord, signal: AbortSignal): Promise<string | undefined> {
    if (!/^run-[A-Za-z0-9._-]+$/.test(record.runId) || record.childSessionId !== `herdr-${record.runId}`) {
      return "run and child session IDs are not deterministic";
    }
    const expectedLocation = createChildSessionLocation(
      record.parentSessionId,
      record.runId,
      record.childCwd,
      this.environment.agentDir,
    );
    if (resolve(record.childSessionDir) !== resolve(expectedLocation.childSessionDir)) {
      return "child session directory is not the deterministic owned path";
    }
    const expectedArtifactPath = resolveArtifactLocation({
      agentDir: this.#agentDir,
      parentSessionId: record.parentSessionId,
      runId: record.runId,
    }).path;
    if (record.artifactPath && resolve(record.artifactPath) !== resolve(expectedArtifactPath)) {
      return "artifact path is not the deterministic owned path";
    }
    let agent: AgentInfo;
    try {
      agent = await this.client.getAgent(record.terminalId, signal);
    } catch (error) {
      return `Herdr identity could not be checked (${errorMessage(error)})`;
    }
    if (
      agent.terminalId !== record.terminalId
      || agent.paneId !== record.paneId
      || agent.tabId !== record.tabId
      || agent.workspaceId !== record.workspaceId
    ) return "Herdr topology does not exactly match the journal";
    if (!matchesChildSession(agent, record.childSessionId, record.childSessionDir, record.childSessionPath)) {
      return "child Pi session identity does not exactly match the journal";
    }
    if (record.worktree && record.worktree.workspaceId !== record.workspaceId) {
      return "worker workspace identity does not exactly match the journal";
    }
    return undefined;
  }

  #replayedRun(replay: ReplayedHerdrRun): RunRecord {
    const record = replay.latest;
    const generation = record.generation ? {
      number: record.generation.number,
      input: "",
      baselineEntryId: record.generation.baselineEntryId,
      ...(record.generation.resultEntryId ? { resultEntryId: record.generation.resultEntryId } : {}),
      delivery: record.generation.delivery,
      blockingWaiter: false,
      ...(record.generation.returned ? { returned: true } : {}),
      ...(record.generation.artifactParentPersisted ? { artifactParentPersisted: true } : {}),
      ...(record.generation.artifactResultPersisted ? { artifactResultPersisted: true } : {}),
    } satisfies Generation : undefined;
    const latestResult = generation && replay.readyGenerations.has(generation.number) ? replay.latestResult : undefined;
    return {
      id: record.runId,
      parentSessionId: record.parentSessionId,
      parentInstanceId: this.instanceId,
      profile: record.profile,
      childSessionId: record.childSessionId,
      childSessionDir: record.childSessionDir,
      ...(record.childSessionPath ? { childSessionPath: record.childSessionPath } : {}),
      childCwd: record.childCwd,
      artifactPath: record.artifactPath ?? resolveArtifactLocation({
        agentDir: this.#agentDir,
        parentSessionId: record.parentSessionId,
        runId: record.runId,
      }).path,
      terminalId: record.terminalId,
      paneId: record.paneId,
      tabId: record.tabId,
      workspaceId: record.workspaceId,
      location: {
        childSessionId: record.childSessionId,
        childSessionDir: record.childSessionDir,
        childCwd: record.childCwd,
      },
      ...(generation ? { generation } : {}),
      ...(latestResult ? { latestResult } : {}),
      ...(record.worktree ? { worktree: { ...record.worktree } } : {}),
      lifecycle: "stopping",
      status: "unknown",
      createdAt: record.at,
      updatedAt: this.#now(),
      ...(replay.childStopped ? { childStopped: true } : {}),
      ...(record.archivePending ? { archivePending: true } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }
}
