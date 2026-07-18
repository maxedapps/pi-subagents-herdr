import type {
  AgentInfo,
  AgentRead,
  AgentStatus,
  CreatedTab,
  CreatedWorktree,
  HerdrClient,
  JsonRecord,
} from "../src/herdr.ts";

export interface Call {
  method: string;
  input?: unknown;
}

export class FakeHerdr implements HerdrClient {
  calls: Call[] = [];
  startStatus: AgentStatus = "working";
  statuses: AgentStatus[] = ["idle"];
  agentNames: Array<string | undefined> = [];
  sessionStates: boolean[] = [];
  read: AgentRead = { text: "terminal output", revision: 1, truncated: false };
  failClosePane = false;
  failCloseTab = false;
  failRemoveWorktree = false;
  hangGetAgent = false;
  agent?: AgentInfo;

  async ping(): Promise<{ version: string; protocol: number }> {
    this.calls.push({ method: "ping" });
    return { version: "0.7.4", protocol: 1 };
  }

  async createTab(input: JsonRecord): Promise<CreatedTab> {
    this.calls.push({ method: "tab.create", input });
    return { workspaceId: String(input.workspace_id), tabId: "w-parent:t-reader", rootPaneId: "w-parent:p-root" };
  }

  async startAgent(input: JsonRecord): Promise<AgentInfo> {
    this.calls.push({ method: "agent.start", input });
    this.agent = {
      agent: "pi",
      sessionReady: true,
      terminalId: "term-child",
      workspaceId: String(input.workspace_id),
      tabId: String(input.tab_id),
      paneId: `${String(input.workspace_id)}:p-child`,
      status: this.startStatus,
    };
    return { ...this.agent };
  }

  async getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
    this.calls.push({ method: "agent.get", input: target });
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
    if (this.sessionStates.length > 0) this.agent.sessionReady = this.sessionStates.shift()!;
    return { ...this.agent };
  }

  async readAgent(target: string): Promise<AgentRead> {
    this.calls.push({ method: "agent.read", input: target });
    return { ...this.read };
  }

  async sendInput(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "pane.send_input", input: { paneId, text } });
  }

  async sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
    this.calls.push({ method: "pane.send_keys", input: { paneId, keys } });
  }

  async closePane(paneId: string): Promise<void> {
    this.calls.push({ method: "pane.close", input: paneId });
    if (this.failClosePane) throw new Error("pane close failed");
  }

  async closeTab(tabId: string): Promise<void> {
    this.calls.push({ method: "tab.close", input: tabId });
    if (this.failCloseTab) throw new Error("tab close failed");
  }

  async createWorktree(input: JsonRecord): Promise<CreatedWorktree> {
    this.calls.push({ method: "worktree.create", input });
    return {
      workspaceId: "w-worker",
      tabId: "w-worker:t1",
      rootPaneId: "w-worker:p1",
      path: String(input.path),
      branch: String(input.branch),
    };
  }

  async removeWorktree(workspaceId: string): Promise<void> {
    this.calls.push({ method: "worktree.remove", input: { workspaceId, force: false } });
    if (this.failRemoveWorktree) throw new Error("remove failed");
  }
}
