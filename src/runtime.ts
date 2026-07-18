import { randomUUID } from "node:crypto";
import type { AgentInfo, AgentStatus, HerdrClient } from "./herdr.ts";
import { buildPiLaunch, type ProfileName } from "./profiles.ts";
import {
  cleanupWorkerWorktree,
  createWorkerWorktree,
  type GitStatus,
  type WorkerCleanup,
  type WorktreeFacts,
} from "./worktree.ts";

const READY = new Set<AgentStatus>(["idle", "done", "blocked"]);

export interface Run {
  id: string;
  profile: ProfileName;
  terminalId: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  status: AgentStatus;
  worktree?: WorktreeFacts;
}

export interface RuntimeEnvironment {
  workspaceId: string;
}

export interface RuntimeOptions {
  idFactory?: () => string;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  gitStatus?: GitStatus;
}

export interface StatusResult {
  run: Run;
  output: string;
  revision: number;
  truncated: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SubagentRuntime {
  readonly runs = new Map<string, Run>();
  readonly #idFactory: () => string;
  readonly #readinessTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #gitStatus?: GitStatus;
  #workerStarting = false;

  constructor(
    readonly client: HerdrClient,
    readonly environment: RuntimeEnvironment,
    options: RuntimeOptions = {},
  ) {
    if (!environment.workspaceId) throw new Error("HERDR_WORKSPACE_ID is required");
    this.#idFactory = options.idFactory ?? (() => `run-${randomUUID()}`);
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#gitStatus = options.gitStatus;
  }

  list(): Run[] {
    return [...this.runs.values()].map((run) => ({ ...run, ...(run.worktree ? { worktree: { ...run.worktree } } : {}) }));
  }

  async start(profile: ProfileName, task: string, cwd: string, signal?: AbortSignal): Promise<Run> {
    if (!task.trim()) throw new Error("task must not be empty");
    const worker = profile === "worker";
    if (worker && (this.#workerStarting || [...this.runs.values()].some((run) => run.profile === "worker"))) {
      throw new Error("Only one worker may be active at a time");
    }
    if (worker) this.#workerStarting = true;

    const id = this.#idFactory();
    const launch = buildPiLaunch(profile, id);
    let tabId: string | undefined;
    let workspaceId: string | undefined;
    let rootPaneId: string | undefined;
    let worktree: WorktreeFacts | undefined;
    let agent: AgentInfo | undefined;
    let inputAttempted = false;

    try {
      if (profile === "worker") {
        const topology = await createWorkerWorktree(this.client, this.environment.workspaceId, cwd, id, signal);
        tabId = topology.tabId;
        rootPaneId = topology.rootPaneId;
        workspaceId = topology.worktree.workspaceId;
        worktree = topology.worktree;
      } else {
        const tab = await this.client.createTab({
          workspace_id: this.environment.workspaceId,
          label: `subagent:${id}`,
          cwd,
          focus: false,
        }, signal);
        tabId = tab.tabId;
        rootPaneId = tab.rootPaneId;
        workspaceId = tab.workspaceId;
      }

      agent = await this.client.startAgent({
        name: launch.name,
        argv: launch.argv,
        workspace_id: workspaceId,
        tab_id: tabId,
        cwd: worktree?.path ?? cwd,
        env: launch.env,
        focus: false,
      }, signal);
      const now = Date.now();
      const run: Run = {
        id,
        profile,
        terminalId: agent.terminalId,
        paneId: agent.paneId,
        tabId: agent.tabId,
        workspaceId: agent.workspaceId,
        createdAt: now,
        updatedAt: now,
        status: agent.status,
        ...(worktree ? { worktree } : {}),
      };
      this.runs.set(id, run);

      const deadline = Date.now() + this.#readinessTimeoutMs;
      while (true) {
        const ready = await this.#getAgentBefore(run, deadline, this.#readinessTimeoutMs, "Pi readiness", signal);
        this.#updateRun(run, ready);
        if (ready.agent === "pi" && ready.sessionReady && READY.has(run.status)) break;
        await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      }
      inputAttempted = true;
      await this.client.sendInput(run.paneId, task, signal);
      return { ...run, ...(run.worktree ? { worktree: { ...run.worktree } } : {}) };
    } catch (error) {
      if (inputAttempted) throw error;
      if (agent) this.runs.delete(id);
      const retained: string[] = [];
      if (agent) {
        try { await this.client.closePane(agent.paneId, signal); }
        catch { retained.push(`pane=${agent.paneId}`); }
      }
      if (worktree) {
        const cleanup = await cleanupWorkerWorktree(this.client, worktree, signal, this.#gitStatus);
        if (!cleanup.removed) retained.push(`worktree=${cleanup.path}`, `branch=${cleanup.branch}`);
      } else if (tabId) {
        try { await this.client.closeTab(tabId, signal); }
        catch { retained.push(`tab=${tabId}`); }
      } else if (rootPaneId) {
        retained.push(`rootPane=${rootPaneId}`);
      }
      throw new Error(`${message(error)}${retained.length ? `; retained ${retained.join(", ")}` : ""}`, { cause: error });
    } finally {
      if (worker) this.#workerStarting = false;
    }
  }

  async status(id: string, wait = false, timeoutMs = 30_000, signal?: AbortSignal): Promise<StatusResult> {
    const run = this.#run(id);
    if (wait && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("timeoutMs must be a positive integer");
    const deadline = Date.now() + timeoutMs;
    do {
      const agent = wait
        ? await this.#getAgentBefore(run, deadline, timeoutMs, "Status wait", signal)
        : await this.client.getAgent(run.terminalId, signal);
      this.#updateRun(run, agent);
      if (!wait || READY.has(run.status)) break;
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    } while (true);

    const read = await this.client.readAgent(run.terminalId, signal);
    return {
      run: { ...run, ...(run.worktree ? { worktree: { ...run.worktree } } : {}) },
      output: read.text.slice(0, 50_000),
      revision: read.revision,
      truncated: read.truncated || read.text.length > 50_000,
    };
  }

  async send(id: string, text: string, signal?: AbortSignal): Promise<Run> {
    if (!text.trim()) throw new Error("message must not be empty");
    const run = this.#run(id);
    this.#updateRun(run, await this.client.getAgent(run.terminalId, signal));
    await this.client.sendInput(run.paneId, text, signal);
    return { ...run };
  }

  async interrupt(id: string, signal?: AbortSignal): Promise<Run> {
    const run = this.#run(id);
    this.#updateRun(run, await this.client.getAgent(run.terminalId, signal));
    await this.client.sendKeys(run.paneId, ["ctrl+c"], signal);
    return { ...run };
  }

  async stop(id: string, signal?: AbortSignal): Promise<{
    run: Run;
    retainedTab?: string;
    workerCleanup?: WorkerCleanup;
  }> {
    const run = this.#run(id);
    this.#updateRun(run, await this.client.getAgent(run.terminalId, signal));
    await this.client.closePane(run.paneId, signal);
    this.runs.delete(id);

    if (run.worktree) {
      const workerCleanup = await cleanupWorkerWorktree(this.client, run.worktree, signal, this.#gitStatus);
      return { run: { ...run, worktree: { ...run.worktree } }, workerCleanup };
    }
    try {
      await this.client.closeTab(run.tabId, signal);
      return { run: { ...run } };
    } catch {
      return { run: { ...run }, retainedTab: run.tabId };
    }
  }

  #run(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown current-instance run: ${id}`);
    return run;
  }

  async #getAgentBefore(
    run: Run,
    deadline: number,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<AgentInfo> {
    const remaining = deadline - Date.now();
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

  #updateRun(run: Run, agent: AgentInfo): void {
    run.terminalId = agent.terminalId;
    run.paneId = agent.paneId;
    run.tabId = agent.tabId;
    run.workspaceId = agent.workspaceId;
    run.status = agent.status;
    run.updatedAt = Date.now();
  }
}
