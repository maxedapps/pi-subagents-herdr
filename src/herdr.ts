import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type JsonRecord = Record<string, unknown>;

export interface AgentSessionReference {
  agent: string;
  kind: "id" | "path";
  value: string;
}

export interface AgentInfo {
  agent?: string;
  agentSession?: AgentSessionReference;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  status: AgentStatus;
}

export interface CreatedTab {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
}

export interface CreatedWorktree {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
  path: string;
  branch: string;
}

export interface WorkspaceWorktreeInfo {
  checkoutPath: string;
  isLinkedWorktree: boolean;
}

export interface WorkspaceInfo {
  workspaceId: string;
  worktree: WorkspaceWorktreeInfo | null;
}

export interface HerdrClient {
  createTab(input: JsonRecord, signal?: AbortSignal): Promise<CreatedTab>;
  startAgent(input: JsonRecord, signal?: AbortSignal): Promise<AgentInfo>;
  getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo>;
  sendInput(paneId: string, text: string, signal?: AbortSignal): Promise<void>;
  closePane(paneId: string, signal?: AbortSignal): Promise<void>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<void>;
  createWorktree(input: JsonRecord, signal?: AbortSignal): Promise<CreatedWorktree>;
  removeWorktree(workspaceId: string, signal?: AbortSignal): Promise<void>;
  getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceInfo>;
  closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void>;
}

export class HerdrError extends Error {
  readonly code?: string;

  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.name = "HerdrError";
    this.code = options?.code;
  }
}

export class HerdrTimeoutError extends HerdrError {
  constructor(phase: "connect" | "response", timeoutMs: number) {
    super(`Herdr ${phase} timed out after ${timeoutMs}ms`);
    this.name = "HerdrTimeoutError";
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HerdrError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HerdrError(`${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HerdrError(`${label} must be a boolean`);
  return value;
}

function status(value: unknown, label: string): AgentStatus {
  if (!(["idle", "working", "blocked", "done", "unknown"] as const).includes(value as AgentStatus)) {
    throw new HerdrError(`${label} is not a valid agent status`);
  }
  return value as AgentStatus;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function decodeAgentSession(value: unknown): AgentSessionReference | undefined {
  if (value === undefined || value === null) return undefined;
  const session = record(value, "agent.agent_session");
  const kind = string(session.kind, "agent.agent_session.kind");
  if (kind !== "id" && kind !== "path") throw new HerdrError("agent.agent_session.kind must be id or path");
  return {
    agent: string(session.agent, "agent.agent_session.agent"),
    kind,
    value: string(session.value, "agent.agent_session.value"),
  };
}

export function decodeAgent(value: unknown): AgentInfo {
  const agent = record(value, "agent");
  if (agent.agent !== undefined && agent.agent !== null && typeof agent.agent !== "string") {
    throw new HerdrError("agent.agent must be a string when present");
  }
  const agentSession = decodeAgentSession(agent.agent_session);
  return {
    ...(typeof agent.agent === "string" ? { agent: agent.agent } : {}),
    ...(agentSession ? { agentSession } : {}),
    terminalId: string(agent.terminal_id, "agent.terminal_id"),
    workspaceId: string(agent.workspace_id, "agent.workspace_id"),
    tabId: string(agent.tab_id, "agent.tab_id"),
    paneId: string(agent.pane_id, "agent.pane_id"),
    status: status(agent.agent_status, "agent.agent_status"),
  };
}

export interface SocketHerdrOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  idFactory?: () => string;
}

export class SocketHerdrClient implements HerdrClient {
  readonly socketPath: string;
  readonly connectTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly #idFactory: () => string;

  constructor(options: SocketHerdrOptions) {
    if (!options.socketPath) throw new HerdrError("HERDR_SOCKET_PATH is required");
    this.socketPath = options.socketPath;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000;
    this.#idFactory = options.idFactory ?? (() => `pi-herdr-${randomUUID()}`);
  }

  async createTab(input: JsonRecord, signal?: AbortSignal): Promise<CreatedTab> {
    const result = await this.#request("tab.create", input, "tab_created", signal);
    const tab = record(result.tab, "tab.create.tab");
    const pane = record(result.root_pane, "tab.create.root_pane");
    return {
      workspaceId: string(tab.workspace_id, "tab.workspace_id"),
      tabId: string(tab.tab_id, "tab.tab_id"),
      rootPaneId: string(pane.pane_id, "root_pane.pane_id"),
    };
  }

  async startAgent(input: JsonRecord, signal?: AbortSignal): Promise<AgentInfo> {
    return decodeAgent((await this.#request("agent.start", input, "agent_started", signal)).agent);
  }

  async getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo> {
    return decodeAgent((await this.#request("agent.get", { target }, "agent_info", signal)).agent);
  }

  async sendInput(paneId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.#request("pane.send_input", { pane_id: paneId, text, keys: ["return"] }, "ok", signal);
  }

  async closePane(paneId: string, signal?: AbortSignal): Promise<void> {
    await this.#request("pane.close", { pane_id: paneId }, "ok", signal);
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    await this.#request("tab.close", { tab_id: tabId }, "ok", signal);
  }

  async createWorktree(input: JsonRecord, signal?: AbortSignal): Promise<CreatedWorktree> {
    const result = await this.#request("worktree.create", input, "worktree_created", signal);
    const workspace = record(result.workspace, "worktree.create.workspace");
    const tab = record(result.tab, "worktree.create.tab");
    const pane = record(result.root_pane, "worktree.create.root_pane");
    const worktree = record(result.worktree, "worktree.create.worktree");
    return {
      workspaceId: string(workspace.workspace_id, "workspace.workspace_id"),
      tabId: string(tab.tab_id, "tab.tab_id"),
      rootPaneId: string(pane.pane_id, "root_pane.pane_id"),
      path: string(worktree.path, "worktree.path"),
      branch: string(worktree.branch, "worktree.branch"),
    };
  }

  async removeWorktree(workspaceId: string, signal?: AbortSignal): Promise<void> {
    await this.#request("worktree.remove", { workspace_id: workspaceId, force: false }, "worktree_removed", signal);
  }

  async getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
    const result = await this.#request("workspace.get", { workspace_id: workspaceId }, "workspace_info", signal);
    const workspace = record(result.workspace, "workspace.get.workspace");
    const worktreeValue = workspace.worktree;
    let worktree: WorkspaceWorktreeInfo | null;
    if (worktreeValue === null) {
      worktree = null;
    } else {
      const decoded = record(worktreeValue, "workspace.worktree");
      worktree = {
        checkoutPath: string(decoded.checkout_path, "workspace.worktree.checkout_path"),
        isLinkedWorktree: boolean(decoded.is_linked_worktree, "workspace.worktree.is_linked_worktree"),
      };
    }
    return {
      workspaceId: string(workspace.workspace_id, "workspace.workspace_id"),
      worktree,
    };
  }

  async closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
    await this.#request("workspace.close", { workspace_id: workspaceId }, "ok", signal);
  }

  async #request(method: string, params: JsonRecord, expectedType: string, signal?: AbortSignal): Promise<JsonRecord> {
    if (signal?.aborted) throw abortError(signal);
    const id = this.#idFactory();
    const socket = await this.#connect(signal);
    return new Promise<JsonRecord>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => finish(new HerdrTimeoutError("response", this.responseTimeoutMs)), this.responseTimeoutMs);
      const onAbort = () => finish(abortError(signal!));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        socket.destroy();
      };
      const finish = (error?: unknown, result?: JsonRecord) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve(result!);
        else reject(error);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          const envelope = record(JSON.parse(line) as unknown, "Herdr response");
          if (string(envelope.id, "response.id") !== id) throw new HerdrError("Herdr response ID mismatch");
          const hasResult = Object.hasOwn(envelope, "result");
          const hasError = Object.hasOwn(envelope, "error");
          if (hasResult === hasError) throw new HerdrError("Herdr response must contain exactly one result or error");
          if (hasError) {
            const error = record(envelope.error, "response.error");
            const code = string(error.code, "error.code");
            throw new HerdrError(`Herdr ${code}: ${string(error.message, "error.message")}`, { code });
          }
          const response = record(envelope.result, "response.result");
          if (string(response.type, "result.type") !== expectedType) {
            throw new HerdrError(`Expected Herdr result ${expectedType}, received ${String(response.type)}`);
          }
          finish(undefined, response);
        } catch (error) {
          finish(error instanceof SyntaxError ? new HerdrError("Herdr returned malformed JSON", { cause: error }) : error);
        }
      });
      socket.once("error", (error) => finish(new HerdrError("Herdr socket request failed", { cause: error })));
      socket.once("end", () => finish(new HerdrError(buffer ? "Herdr response was truncated" : "Herdr disconnected before responding")));
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  #connect(signal?: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      const timer = setTimeout(() => finish(new HerdrTimeoutError("connect", this.connectTimeoutMs)), this.connectTimeoutMs);
      const onAbort = () => finish(abortError(signal!));
      const onError = (error: Error) => finish(new HerdrError(`Unable to connect to Herdr at ${this.socketPath}`, { cause: error }));
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeListener("error", onError);
        if (error === undefined) resolve(socket);
        else {
          socket.destroy();
          reject(error);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", onError);
      socket.once("connect", () => finish());
    });
  }
}
