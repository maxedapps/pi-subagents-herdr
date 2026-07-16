import { HERDR_PROTOCOL_VERSION, MINIMUM_HERDR_VERSION } from "../contracts/protocol.ts";
import {
  decodeAgent, decodeEvent, decodeLayout, decodePane,
  decodeProcessInfo, decodeRead, decodeSnapshot, decodeTab, decodeWorkspace, expectResult, toWireRecord,
  type AgentInfo, type AgentStartInput, type EventMatch, type HerdrEvent,
  type PaneInfo, type PaneLayout, type PaneProcessInfo, type PingResult, type ReadInput, type ReadResult,
  type SessionSnapshot, type Subscription, type TabCreateInput, type TabInfo, type UsedHerdrResultType, type WorkspaceInfo,
  type WorktreeCreateInput, type WorktreeCreatedResult, type WorktreeInfo, type WorktreeOpenInput,
  type WorktreeOpenedResult, type WorktreeRemovedResult, type WorktreeSelector, type WorktreeSourceInfo,
} from "./protocol.ts";
import { HerdrNdjsonTransport, type HerdrSubscriptionStream, type RequestOptions } from "./transport.ts";

export interface HerdrRequestClient {
  ping(signal?: AbortSignal): Promise<{ version: string; protocol: number }>;
  snapshot(signal?: AbortSignal): Promise<SessionSnapshot>;
  currentPane(callerPaneId: string, signal?: AbortSignal): Promise<PaneInfo>;
  createTab(input: TabCreateInput, signal?: AbortSignal): Promise<{ tab: TabInfo; rootPane: PaneInfo }>;
  getTab(tabId: string, signal?: AbortSignal): Promise<TabInfo>;
  listTabs(workspaceId?: string, signal?: AbortSignal): Promise<readonly TabInfo[]>;
  getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceInfo>;
  listWorkspaces(signal?: AbortSignal): Promise<readonly WorkspaceInfo[]>;
  getPane(paneId: string, signal?: AbortSignal): Promise<PaneInfo>;
  listPanes(workspaceId?: string, signal?: AbortSignal): Promise<readonly PaneInfo[]>;
  getPaneLayout(paneId: string, signal?: AbortSignal): Promise<PaneLayout>;
  getPaneProcessInfo(paneId: string, signal?: AbortSignal): Promise<PaneProcessInfo>;
  startAgent(input: AgentStartInput, signal?: AbortSignal): Promise<AgentInfo>;
  getAgent(target: string, signal?: AbortSignal): Promise<AgentInfo>;
  listAgents(signal?: AbortSignal): Promise<readonly AgentInfo[]>;
  readAgent(target: string, input: ReadInput, signal?: AbortSignal): Promise<ReadResult>;
  sendInput(paneId: string, text: string, keys: readonly string[], signal?: AbortSignal): Promise<void>;
  sendKeys(paneId: string, keys: readonly string[], signal?: AbortSignal): Promise<void>;
  waitForEvent(input: EventMatch, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrEvent>;
  subscribe(input: readonly Subscription[], signal?: AbortSignal): Promise<HerdrSubscriptionStream>;
  focusAgent(target: string, signal?: AbortSignal): Promise<void>;
  closePane(paneId: string, signal?: AbortSignal): Promise<void>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<void>;
  listWorktrees(input: WorktreeSelector, signal?: AbortSignal): Promise<{ source: WorktreeSourceInfo; worktrees: readonly WorktreeInfo[] }>;
  createWorktree(input: WorktreeCreateInput, signal?: AbortSignal): Promise<WorktreeCreatedResult>;
  openWorktree(input: WorktreeOpenInput, signal?: AbortSignal): Promise<WorktreeOpenedResult>;
  removeWorktree(workspaceId: string, force: boolean, signal?: AbortSignal): Promise<WorktreeRemovedResult>;
}

export class HerdrCompatibilityError extends Error {
  constructor(readonly serverVersion: string, readonly serverProtocol: number, message: string) { super(message); this.name = "HerdrCompatibilityError"; }
}
export class HerdrIdentityError extends Error { constructor(message: string) { super(message); this.name = "HerdrIdentityError"; } }

function validateWorktreeSelector(input: WorktreeSelector, requireExplicit: boolean): void {
  const count = Number(input.workspace_id !== undefined) + Number(input.cwd !== undefined);
  if (count > 1 || (requireExplicit && count !== 1)) throw new HerdrIdentityError(`Worktree source requires ${requireExplicit ? "exactly" : "at most"} one of workspace_id or cwd`);
  if (input.cwd !== undefined && !input.cwd.startsWith("/")) throw new HerdrIdentityError("Raw worktree cwd must be absolute");
}
function validateNoFocus(value: false | undefined): void { if (value !== undefined && value !== false) throw new HerdrIdentityError("Extension worktree operations must use focus:false"); }

function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value); if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(actual); const right = parse(minimum); if (!left || !right) return false;
  for (let index = 0; index < 3; index++) { if (left[index]! > right[index]!) return true; if (left[index]! < right[index]!) return false; }
  return !actual.includes("-");
}

export class HerdrClient implements HerdrRequestClient {
  constructor(readonly transport: HerdrNdjsonTransport) {}
  async #result(method: string, params: object, expectedType: UsedHerdrResultType, signal?: AbortSignal, responseTimeoutMs?: number) {
    const options: RequestOptions = { ...(signal === undefined ? {} : { signal }), ...(responseTimeoutMs === undefined ? {} : { responseTimeoutMs }) };
    return expectResult(await this.transport.request(method, toWireRecord(params), options), expectedType);
  }
  async ping(signal?: AbortSignal): Promise<PingResult> {
    const result = await this.#result("ping", {}, "pong", signal); const version = result.version; const protocol = result.protocol;
    if (typeof version !== "string" || !Number.isSafeInteger(protocol)) throw new HerdrCompatibilityError(String(version), Number(protocol), "Herdr ping omitted valid version/protocol metadata");
    return result as PingResult;
  }
  async assertCompatible(signal?: AbortSignal): Promise<PingResult> {
    const ping = await this.ping(signal);
    if (ping.protocol !== HERDR_PROTOCOL_VERSION || !semverAtLeast(ping.version, MINIMUM_HERDR_VERSION)) {
      throw new HerdrCompatibilityError(ping.version, ping.protocol, `Incompatible Herdr server ${ping.version}/protocol ${ping.protocol}; require Herdr >=${MINIMUM_HERDR_VERSION} with protocol ${HERDR_PROTOCOL_VERSION}`);
    }
    return ping;
  }
  async snapshot(signal?: AbortSignal): Promise<SessionSnapshot> { const result = await this.#result("session.snapshot", {}, "session_snapshot", signal); return decodeSnapshot(result.snapshot); }
  async currentPane(callerPaneId: string, signal?: AbortSignal): Promise<PaneInfo> { const result = await this.#result("pane.current", { caller_pane_id: callerPaneId }, "pane_current", signal); return decodePane(result.pane); }
  async createTab(input: TabCreateInput, signal?: AbortSignal) { const result = await this.#result("tab.create", input, "tab_created", signal); return { tab: decodeTab(result.tab), rootPane: decodePane(result.root_pane) }; }
  async getTab(tabId: string, signal?: AbortSignal) { return decodeTab((await this.#result("tab.get", { tab_id: tabId }, "tab_info", signal)).tab); }
  async listTabs(workspaceId?: string, signal?: AbortSignal) { const params = workspaceId === undefined ? {} : { workspace_id: workspaceId }; const result = await this.#result("tab.list", params, "tab_list", signal); if (!Array.isArray(result.tabs)) throw new Error("tab_list.tabs must be an array"); return result.tabs.map((item) => decodeTab(item)); }
  async getWorkspace(workspaceId: string, signal?: AbortSignal) { return decodeWorkspace((await this.#result("workspace.get", { workspace_id: workspaceId }, "workspace_info", signal)).workspace); }
  async listWorkspaces(signal?: AbortSignal) { const result = await this.#result("workspace.list", {}, "workspace_list", signal); if (!Array.isArray(result.workspaces)) throw new Error("workspace_list.workspaces must be an array"); return result.workspaces.map((item) => decodeWorkspace(item)); }
  async getPane(paneId: string, signal?: AbortSignal) { return decodePane((await this.#result("pane.get", { pane_id: paneId }, "pane_info", signal)).pane); }
  async listPanes(workspaceId?: string, signal?: AbortSignal) { const result = await this.#result("pane.list", workspaceId === undefined ? {} : { workspace_id: workspaceId }, "pane_list", signal); if (!Array.isArray(result.panes)) throw new Error("pane_list.panes must be an array"); return result.panes.map((item) => decodePane(item)); }
  async getPaneLayout(paneId: string, signal?: AbortSignal) { return decodeLayout((await this.#result("pane.layout", { pane_id: paneId }, "pane_layout", signal)).layout); }
  async getPaneProcessInfo(paneId: string, signal?: AbortSignal) { return decodeProcessInfo((await this.#result("pane.process_info", { pane_id: paneId }, "pane_process_info", signal)).process_info); }
  async startAgent(input: AgentStartInput, signal?: AbortSignal) { return decodeAgent((await this.#result("agent.start", input, "agent_started", signal)).agent); }
  async getAgent(target: string, signal?: AbortSignal) { return decodeAgent((await this.#result("agent.get", { target }, "agent_info", signal)).agent); }
  async listAgents(signal?: AbortSignal) { const result = await this.#result("agent.list", {}, "agent_list", signal); if (!Array.isArray(result.agents)) throw new Error("agent_list.agents must be an array"); return result.agents.map((item) => decodeAgent(item)); }
  async readAgent(target: string, input: ReadInput, signal?: AbortSignal) { return decodeRead((await this.#result("agent.read", { target, ...input }, "pane_read", signal)).read); }
  async sendInput(paneId: string, text: string, keys: readonly string[], signal?: AbortSignal) { await this.#result("pane.send_input", { pane_id: paneId, text, keys }, "ok", signal); }
  async sendKeys(paneId: string, keys: readonly string[], signal?: AbortSignal) { await this.#result("pane.send_keys", { pane_id: paneId, keys }, "ok", signal); }
  async waitForEvent(input: EventMatch, signal?: AbortSignal, timeoutMs?: number): Promise<HerdrEvent> { const result = await this.#result("events.wait", { match_event: input, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) }, "wait_matched", signal, timeoutMs === undefined ? undefined : timeoutMs + 1_000); return decodeEvent(result.event) as HerdrEvent; }
  subscribe(input: readonly Subscription[], signal?: AbortSignal) { return this.transport.subscribe(toWireRecord({ subscriptions: input }), signal === undefined ? {} : { signal }); }
  async focusAgent(target: string, signal?: AbortSignal) { await this.#result("agent.focus", { target }, "ok", signal); }
  async closePane(paneId: string, signal?: AbortSignal) { await this.#result("pane.close", { pane_id: paneId }, "ok", signal); }
  async closeTab(tabId: string, signal?: AbortSignal) { await this.#result("tab.close", { tab_id: tabId }, "ok", signal); }
  async listWorktrees(input: WorktreeSelector, signal?: AbortSignal) {
    validateWorktreeSelector(input, true);
    const result = await this.#result("worktree.list", input, "worktree_list", signal);
    if (!Array.isArray(result.worktrees)) throw new HerdrIdentityError("worktree_list.worktrees must be an array");
    return { source: result.source as WorktreeSourceInfo, worktrees: result.worktrees as unknown as readonly WorktreeInfo[] };
  }
  async createWorktree(input: WorktreeCreateInput, signal?: AbortSignal): Promise<WorktreeCreatedResult> {
    validateWorktreeSelector(input, true); validateNoFocus(input.focus);
    if (input.path !== undefined && !input.path.startsWith("/")) throw new HerdrIdentityError("Raw worktree path must be absolute");
    const result = await this.#result("worktree.create", { ...input, focus: false }, "worktree_created", signal);
    return { workspace: result.workspace as WorkspaceInfo, tab: result.tab as TabInfo, rootPane: result.root_pane as PaneInfo, worktree: result.worktree as WorktreeInfo };
  }
  async openWorktree(input: WorktreeOpenInput, signal?: AbortSignal): Promise<WorktreeOpenedResult> {
    validateWorktreeSelector(input, true); validateNoFocus(input.focus);
    if (Number(input.path !== undefined) + Number(input.branch !== undefined) !== 1) throw new HerdrIdentityError("worktree.open requires exactly one of path or branch");
    if (input.path !== undefined && !input.path.startsWith("/")) throw new HerdrIdentityError("Raw worktree path must be absolute");
    const result = await this.#result("worktree.open", { ...input, focus: false }, "worktree_opened", signal);
    return { workspace: result.workspace as WorkspaceInfo, tab: result.tab as TabInfo, rootPane: result.root_pane as PaneInfo, worktree: result.worktree as WorktreeInfo, alreadyOpen: result.already_open as boolean };
  }
  async removeWorktree(workspaceId: string, force: boolean, signal?: AbortSignal): Promise<WorktreeRemovedResult> {
    if (!workspaceId) throw new HerdrIdentityError("worktree.remove requires an explicit workspace identity");
    const result = await this.#result("worktree.remove", { workspace_id: workspaceId, force }, "worktree_removed", signal);
    return { workspaceId: result.workspace_id as string, path: result.path as string, forced: result.forced as boolean };
  }
}

export interface ParentIdentityEnvironment { readonly HERDR_ENV?: string; readonly HERDR_SOCKET_PATH?: string; readonly HERDR_PANE_ID?: string; readonly HERDR_TAB_ID?: string; readonly HERDR_WORKSPACE_ID?: string; }
export interface ParentSessionIdentity { readonly id?: string; readonly path?: string; }
export interface ParentPreflight { readonly pane: PaneInfo; readonly agent: AgentInfo; readonly snapshot: SessionSnapshot; readonly nativeSession: { readonly kind: "id" | "path"; readonly value: string; readonly source: string }; }

function sameNativeSession(left: PaneInfo["agent_session"], right: PaneInfo["agent_session"]): boolean {
  return left !== undefined && left !== null && right !== undefined && right !== null
    && left.agent === "pi" && right.agent === "pi"
    && left.kind === right.kind && left.value === right.value && left.source === right.source;
}

export async function preflightOwningParent(client: HerdrClient, environment: ParentIdentityEnvironment, parent: ParentSessionIdentity, signal?: AbortSignal): Promise<ParentPreflight> {
  if (environment.HERDR_ENV !== "1") throw new HerdrIdentityError("HERDR_ENV=1 is required; orchestration is available only inside Herdr");
  if (!environment.HERDR_SOCKET_PATH) throw new HerdrIdentityError("HERDR_SOCKET_PATH is required");
  if (client.transport.socketPath !== environment.HERDR_SOCKET_PATH) throw new HerdrIdentityError("Herdr client socket does not match HERDR_SOCKET_PATH");
  if (!environment.HERDR_PANE_ID || !environment.HERDR_TAB_ID || !environment.HERDR_WORKSPACE_ID) throw new HerdrIdentityError("HERDR_PANE_ID, HERDR_TAB_ID, and HERDR_WORKSPACE_ID are all required");
  const supplied = [
    ...(typeof parent.id === "string" && parent.id.length > 0 ? [{ kind: "id" as const, value: parent.id }] : []),
    ...(typeof parent.path === "string" && parent.path.length > 0 ? [{ kind: "path" as const, value: parent.path }] : []),
  ];
  if (supplied.length === 0) throw new HerdrIdentityError("A current Pi parent session id or path is required");
  await client.assertCompatible(signal);
  const [current, snapshot] = await Promise.all([client.currentPane(environment.HERDR_PANE_ID, signal), client.snapshot(signal)]);
  if (snapshot.protocol !== HERDR_PROTOCOL_VERSION) throw new HerdrIdentityError(`Snapshot protocol ${snapshot.protocol} does not match protocol ${HERDR_PROTOCOL_VERSION}`);
  if (current.pane_id !== environment.HERDR_PANE_ID || current.tab_id !== environment.HERDR_TAB_ID || current.workspace_id !== environment.HERDR_WORKSPACE_ID) throw new HerdrIdentityError("pane.current does not match the caller's Herdr environment identity");
  if (current.agent !== "pi" || current.agent_session?.agent !== "pi") throw new HerdrIdentityError("pane.current is not a native Pi session");
  const pane = snapshot.panes.find((candidate) => candidate.terminal_id === current.terminal_id);
  if (!pane || pane.pane_id !== current.pane_id || pane.tab_id !== current.tab_id || pane.workspace_id !== current.workspace_id || pane.agent !== "pi" || !sameNativeSession(current.agent_session, pane.agent_session)) throw new HerdrIdentityError("session.snapshot does not reconcile the caller pane, topology, and native Pi identity");
  const agent = snapshot.agents.find((candidate) => candidate.terminal_id === current.terminal_id);
  if (!agent || agent.agent !== "pi" || agent.pane_id !== pane.pane_id || agent.tab_id !== pane.tab_id || agent.workspace_id !== pane.workspace_id || !sameNativeSession(pane.agent_session, agent.agent_session)) throw new HerdrIdentityError("The snapshot agent does not match the reconciled native Pi pane topology");
  const native = agent.agent_session!;
  if (!supplied.some((identity) => identity.kind === native.kind && identity.value === native.value)) throw new HerdrIdentityError("The caller's native Pi session cannot be proven against either supplied parent identity");
  return { pane, agent, snapshot, nativeSession: { kind: native.kind, value: native.value, source: native.source } };
}

export function createHerdrClientFromEnvironment(environment: ParentIdentityEnvironment = process.env): HerdrClient {
  if (!environment.HERDR_SOCKET_PATH) throw new HerdrIdentityError("HERDR_SOCKET_PATH is required");
  return new HerdrClient(new HerdrNdjsonTransport({ socketPath: environment.HERDR_SOCKET_PATH }));
}
