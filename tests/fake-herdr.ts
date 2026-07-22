import type {
  AgentInfo,
  AgentSessionReference,
  AgentStatus,
  AgentStatusEvent,
  AgentStatusSubscription,
  CreatedTab,
  CreatedWorktree,
  HerdrClient,
  JsonRecord,
  WorkspaceInfo,
  WorktreeSourceInfo,
} from "../src/herdr.ts";
import { HerdrError } from "../src/herdr.ts";

export interface Call {
  method: string;
  input?: unknown;
  signal?: AbortSignal;
}

export class ControllableAgentStatusStream implements AgentStatusSubscription {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly signal?: AbortSignal;
  readonly ready: Promise<AgentStatusSubscription>;
  acknowledged = false;
  aborted = false;
  closed = false;
  closeCount = 0;
  emittedStatuses: AgentStatus[] = [];

  readonly #queued: AgentStatusEvent[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<AgentStatusEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  readonly #resolveReady: (subscription: AgentStatusSubscription) => void;
  readonly #rejectReady: (error: unknown) => void;
  #terminalError: unknown;

  constructor(paneId: string, workspaceId: string, signal?: AbortSignal) {
    this.paneId = paneId;
    this.workspaceId = workspaceId;
    this.signal = signal;
    let resolveReady!: (subscription: AgentStatusSubscription) => void;
    let rejectReady!: (error: unknown) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#resolveReady = resolveReady;
    this.#rejectReady = rejectReady;
    if (signal?.aborted) this.#abort();
    else signal?.addEventListener("abort", this.#abort, { once: true });
  }

  acknowledge(): void {
    if (this.closed) throw new Error("Cannot acknowledge a closed status stream");
    if (this.acknowledged) return;
    this.acknowledged = true;
    this.#resolveReady(this);
  }

  emit(status: AgentStatus): void {
    if (!this.acknowledged || this.closed) throw new Error("Status stream is not open");
    const event = { paneId: this.paneId, workspaceId: this.workspaceId, status };
    this.emittedStatuses.push(status);
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.#queued.push(event);
  }

  end(): void {
    this.#finish();
  }

  fail(error = new Error("status stream failed")): void {
    this.#finish(error);
  }

  next(): Promise<IteratorResult<AgentStatusEvent>> {
    const event = this.#queued.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.closed) {
      return this.#terminalError === undefined
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.reject(this.#terminalError);
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  async return(): Promise<IteratorResult<AgentStatusEvent>> {
    this.#queued.length = 0;
    this.#finish();
    return { value: undefined, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<AgentStatusEvent>> {
    const rejection = error ?? new Error("status stream consumer failed");
    this.#queued.length = 0;
    this.#finish(rejection);
    throw rejection;
  }

  [Symbol.asyncIterator](): AgentStatusSubscription {
    return this;
  }

  readonly #abort = (): void => {
    this.aborted = true;
    this.#queued.length = 0;
    this.#finish(this.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
  };

  #finish(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCount++;
    this.#terminalError = error;
    this.signal?.removeEventListener("abort", this.#abort);
    if (!this.acknowledged) this.#rejectReady(error ?? new Error("Status stream ended before acknowledgement"));
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(error);
    }
  }
}

export class FakeHerdr implements HerdrClient {
  calls: Call[] = [];
  statusSubscriptions: ControllableAgentStatusStream[] = [];
  autoAcknowledgeSubscriptions = true;
  startStatus: AgentStatus = "working";
  statuses: AgentStatus[] = ["idle"];
  agentNames: Array<string | undefined> = [];
  sessionValues: Array<string | undefined> = [];
  paneIds: string[] = [];
  agentSessionForStart?: (input: JsonRecord, sessionId: string) => AgentSessionReference;
  failStartAgent = false;
  failClosePane: boolean | Error = false;
  failCloseTab: boolean | Error = false;
  failRemoveWorktree = false;
  failGetWorkspace?: Error;
  failCloseWorkspace = false;
  failSendInput = false;
  hangGetAgent = false;
  onSendInput?: (paneId: string, text: string) => void | Promise<void>;
  agent?: AgentInfo;
  workspace: WorkspaceInfo = {
    workspaceId: "w-worker",
    worktree: {
      checkoutPath: "/repo/.herdr-subagents-worktrees/run-worker",
      isLinkedWorktree: true,
    },
  };
  worktreeSource: WorktreeSourceInfo = {
    repoKey: "repo-key",
    repoRoot: process.cwd(),
    sourceCheckoutPath: process.cwd(),
  };

  async createTab(input: JsonRecord, signal?: AbortSignal): Promise<CreatedTab> {
    this.calls.push({ method: "tab.create", input, signal });
    return { workspaceId: String(input.workspace_id), tabId: "w-parent:t-reader", rootPaneId: "w-parent:p-root" };
  }

  async startAgent(input: JsonRecord, signal?: AbortSignal): Promise<AgentInfo> {
    this.calls.push({ method: "agent.start", input, signal });
    if (this.failStartAgent) throw new Error("agent start failed");
    const argv = input.argv as string[];
    const sessionId = argv[argv.indexOf("--session-id") + 1]!;
    this.agent = {
      agent: "pi",
      agentSession: this.agentSessionForStart?.(input, sessionId) ?? { agent: "pi", kind: "id", value: sessionId },
      terminalId: "term-child",
      workspaceId: String(input.workspace_id),
      tabId: String(input.tab_id),
      paneId: this.paneIds.shift() ?? `${String(input.workspace_id)}:p-child`,
      status: this.startStatus,
    };
    return this.copyAgent();
  }

  async getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
    this.calls.push({ method: "agent.get", input: target, signal });
    if (this.hangGetAgent) {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (!this.agent) throw new Error("agent missing");
    const next = this.statuses.shift();
    if (next) this.agent.status = next;
    if (this.agentNames.length > 0) {
      const name = this.agentNames.shift();
      if (name === undefined) delete this.agent.agent;
      else this.agent.agent = name;
    }
    if (this.sessionValues.length > 0) {
      const value = this.sessionValues.shift();
      if (value === undefined) delete this.agent.agentSession;
      else this.agent.agentSession = { agent: "pi", kind: "id", value };
    }
    return this.copyAgent();
  }

  async subscribeAgentStatus(
    paneId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<AgentStatusSubscription> {
    this.calls.push({ method: "events.subscribe", input: { paneId, workspaceId }, signal });
    const stream = new ControllableAgentStatusStream(paneId, workspaceId, signal);
    this.statusSubscriptions.push(stream);
    if (this.autoAcknowledgeSubscriptions) queueMicrotask(() => {
      if (!stream.closed) stream.acknowledge();
    });
    return await stream.ready;
  }

  async sendInput(paneId: string, text: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "pane.send_input", input: { paneId, text }, signal });
    await this.onSendInput?.(paneId, text);
    if (this.failSendInput) throw new Error("send input failed");
  }

  async closePane(paneId: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "pane.close", input: paneId, signal });
    if (this.failClosePane) {
      throw this.failClosePane === true ? new Error("pane close failed") : this.failClosePane;
    }
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "tab.close", input: tabId, signal });
    if (this.failCloseTab) {
      throw this.failCloseTab === true ? new Error("tab close failed") : this.failCloseTab;
    }
  }

  async getWorktreeSource(input: JsonRecord, signal?: AbortSignal): Promise<WorktreeSourceInfo> {
    this.calls.push({ method: "worktree.list", input, signal });
    return { ...this.worktreeSource };
  }

  async createWorktree(input: JsonRecord, signal?: AbortSignal): Promise<CreatedWorktree> {
    this.calls.push({ method: "worktree.create", input, signal });
    return {
      workspaceId: "w-worker",
      tabId: "w-worker:t1",
      rootPaneId: "w-worker:p1",
      path: String(input.path),
      branch: String(input.branch),
    };
  }

  async removeWorktree(workspaceId: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "worktree.remove", input: { workspaceId, force: false }, signal });
    if (this.failRemoveWorktree) throw new Error("remove failed");
  }

  async getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
    this.calls.push({ method: "workspace.get", input: { workspaceId }, signal });
    if (this.failGetWorkspace) throw this.failGetWorkspace;
    return {
      ...this.workspace,
      worktree: this.workspace.worktree ? { ...this.workspace.worktree } : null,
    };
  }

  async closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "workspace.close", input: { workspaceId }, signal });
    if (this.failCloseWorkspace) throw new Error("workspace close failed");
  }

  private copyAgent(): AgentInfo {
    if (!this.agent) throw new Error("agent missing");
    return {
      ...this.agent,
      ...(this.agent.agentSession ? { agentSession: { ...this.agent.agentSession } } : {}),
    };
  }
}
