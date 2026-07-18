import type {
  AgentInfo,
  AgentSessionReference,
  AgentStatus,
  CreatedTab,
  CreatedWorktree,
  HerdrClient,
  JsonRecord,
} from "../src/herdr.ts";

export interface Call {
  method: string;
  input?: unknown;
  signal?: AbortSignal;
}

export class FakeHerdr implements HerdrClient {
  calls: Call[] = [];
  startStatus: AgentStatus = "working";
  statuses: AgentStatus[] = ["idle"];
  agentNames: Array<string | undefined> = [];
  sessionValues: Array<string | undefined> = [];
  agentSessionForStart?: (input: JsonRecord, sessionId: string) => AgentSessionReference;
  failStartAgent = false;
  failClosePane = false;
  failCloseTab = false;
  failRemoveWorktree = false;
  failSendInput = false;
  hangGetAgent = false;
  onSendInput?: (paneId: string, text: string) => void | Promise<void>;
  agent?: AgentInfo;

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
      paneId: `${String(input.workspace_id)}:p-child`,
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

  async sendInput(paneId: string, text: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "pane.send_input", input: { paneId, text }, signal });
    await this.onSendInput?.(paneId, text);
    if (this.failSendInput) throw new Error("send input failed");
  }

  async closePane(paneId: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "pane.close", input: paneId, signal });
    if (this.failClosePane) throw new Error("pane close failed");
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "tab.close", input: tabId, signal });
    if (this.failCloseTab) throw new Error("tab close failed");
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

  private copyAgent(): AgentInfo {
    if (!this.agent) throw new Error("agent missing");
    return {
      ...this.agent,
      ...(this.agent.agentSession ? { agentSession: { ...this.agent.agentSession } } : {}),
    };
  }
}
