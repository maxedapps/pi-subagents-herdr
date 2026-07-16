import type { HerdrStatus } from "../contracts/state.ts";

export const HERDR_READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export type ReadSource = (typeof HERDR_READ_SOURCES)[number];
export type ReadFormat = "text" | "ansi";
export type WireRecord = Record<string, unknown>;

export const USED_HERDR_METHOD_RESULTS = {
  "ping": "pong",
  "session.snapshot": "session_snapshot",
  "workspace.get": "workspace_info",
  "workspace.list": "workspace_list",
  "tab.create": "tab_created",
  "tab.get": "tab_info",
  "tab.list": "tab_list",
  "tab.close": "ok",
  "pane.current": "pane_current",
  "pane.get": "pane_info",
  "pane.list": "pane_list",
  "pane.layout": "pane_layout",
  "pane.process_info": "pane_process_info",
  "pane.send_input": "ok",
  "pane.send_keys": "ok",
  "pane.close": "ok",
  "agent.start": "agent_started",
  "agent.get": "agent_info",
  "agent.list": "agent_list",
  "agent.read": "pane_read",
  "agent.focus": "agent_info",
  "events.subscribe": "subscription_started",
  "events.wait": "wait_matched",
  "worktree.list": "worktree_list",
  "worktree.create": "worktree_created",
  "worktree.open": "worktree_opened",
  "worktree.remove": "worktree_removed",
} as const;
export const USED_HERDR_RESULT_TYPES = [...new Set(Object.values(USED_HERDR_METHOD_RESULTS))] as readonly UsedHerdrResultType[];
export type UsedHerdrResultType = (typeof USED_HERDR_METHOD_RESULTS)[keyof typeof USED_HERDR_METHOD_RESULTS];

export const HERDR_EVENT_NAMES = [
  "workspace_created", "workspace_updated", "workspace_closed", "workspace_focused",
  "tab_created", "tab_closed", "tab_focused",
  "pane_created", "pane_closed", "pane_focused", "pane_moved", "pane_exited",
  "pane_agent_status_changed", "layout_updated",
  "worktree_created", "worktree_opened", "worktree_removed",
] as const;
export type HerdrEventName = (typeof HERDR_EVENT_NAMES)[number];
export const HERDR_SUBSCRIPTION_EVENT_NAMES = ["pane.output_matched", "pane.agent_status_changed", "pane.scroll_changed"] as const;
export type HerdrSubscriptionEventName = (typeof HERDR_SUBSCRIPTION_EVENT_NAMES)[number];

export type HerdrErrorCode =
  | "not_found" | "timeout" | "invalid_params" | "unavailable" | "incompatible"
  | "invalid_request" | "internal" | (string & {});

export interface HerdrErrorBody { readonly code: HerdrErrorCode; readonly message: string; }
export interface SuccessEnvelope<T extends WireRecord = WireRecord> { readonly id: string; readonly result: T; }
export interface ErrorEnvelope { readonly id: string; readonly error: HerdrErrorBody; }
export type ResponseEnvelope<T extends WireRecord = WireRecord> = SuccessEnvelope<T> | ErrorEnvelope;

export class HerdrProtocolError extends Error {
  constructor(message: string, readonly value?: unknown) { super(message); this.name = "HerdrProtocolError"; }
}
export class HerdrApiError extends Error {
  constructor(readonly requestId: string, readonly code: HerdrErrorCode, message: string) {
    super(`Herdr ${code}: ${message}`); this.name = "HerdrApiError";
  }
}

export interface AgentSessionInfo extends WireRecord {
  readonly source: string; readonly agent: string; readonly kind: "id" | "path"; readonly value: string;
}
export interface WorkspaceWorktreeInfo extends WireRecord {
  readonly repo_key: string; readonly repo_name: string; readonly repo_root: string; readonly checkout_path: string; readonly is_linked_worktree: boolean;
}
export interface WorkspaceInfo extends WireRecord {
  readonly workspace_id: string; readonly number: number; readonly label: string; readonly focused: boolean;
  readonly pane_count: number; readonly tab_count: number; readonly active_tab_id: string; readonly agent_status: HerdrStatus;
  readonly worktree?: WorkspaceWorktreeInfo | null;
}
export interface TabInfo extends WireRecord {
  readonly tab_id: string; readonly workspace_id: string; readonly number: number; readonly label: string;
  readonly focused: boolean; readonly pane_count: number; readonly agent_status: HerdrStatus;
}
export interface PaneScrollInfo extends WireRecord { readonly offset_from_bottom: number; readonly max_offset_from_bottom: number; readonly viewport_rows: number; }
export interface PaneInfo extends WireRecord {
  readonly pane_id: string; readonly terminal_id: string; readonly workspace_id: string; readonly tab_id: string;
  readonly focused: boolean; readonly agent_status: HerdrStatus; readonly revision: number;
  readonly agent?: string | null; readonly cwd?: string | null; readonly foreground_cwd?: string | null;
  readonly agent_session?: AgentSessionInfo | null; readonly scroll?: PaneScrollInfo | null;
}
export interface AgentInfo extends WireRecord {
  readonly terminal_id: string; readonly workspace_id: string; readonly tab_id: string; readonly pane_id: string;
  readonly focused: boolean; readonly agent_status: HerdrStatus; readonly revision: number;
  readonly agent?: string | null; readonly cwd?: string | null; readonly foreground_cwd?: string | null;
  readonly agent_session?: AgentSessionInfo | null;
}
export interface PaneLayoutRect extends WireRecord { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface PaneLayoutPane extends WireRecord { readonly pane_id: string; readonly focused: boolean; readonly rect: PaneLayoutRect; }
export interface PaneLayoutSplit extends WireRecord { readonly id: string; readonly direction: "right" | "down"; readonly ratio: number; readonly rect: PaneLayoutRect; }
export interface PaneLayout extends WireRecord {
  readonly workspace_id: string; readonly tab_id: string; readonly zoomed: boolean;
  readonly focused_pane_id: string; readonly panes: readonly PaneLayoutPane[]; readonly splits: readonly PaneLayoutSplit[];
  readonly area: PaneLayoutRect;
}
export interface PaneProcess extends WireRecord {
  readonly pid: number; readonly name: string; readonly argv?: readonly string[] | null;
  readonly argv0?: string | null; readonly cmdline?: string | null; readonly cwd?: string | null;
}
export interface PaneProcessInfo extends WireRecord {
  readonly pane_id: string; readonly shell_pid?: number | null; readonly tty?: string | null;
  readonly foreground_process_group_id?: number | null; readonly foreground_processes?: readonly PaneProcess[];
}
export interface ReadResult extends WireRecord {
  readonly pane_id: string; readonly workspace_id: string; readonly tab_id: string; readonly source: ReadSource;
  readonly format: ReadFormat; readonly text: string; readonly revision: number; readonly truncated: boolean;
}
export interface SessionSnapshot extends WireRecord {
  readonly version: string; readonly protocol: number;
  readonly workspaces: readonly WorkspaceInfo[]; readonly tabs: readonly TabInfo[]; readonly panes: readonly PaneInfo[];
  readonly layouts: readonly PaneLayout[]; readonly agents: readonly AgentInfo[];
  readonly focused_workspace_id?: string | null; readonly focused_tab_id?: string | null; readonly focused_pane_id?: string | null;
}
export interface PingResult extends WireRecord { readonly type: "pong"; readonly version: string; readonly protocol: number; }
export interface WorktreeSourceInfo extends WireRecord {
  readonly repo_key: string; readonly repo_name: string; readonly repo_root: string;
  readonly source_checkout_path: string; readonly source_workspace_id?: string | null;
}
export interface WorktreeInfo extends WireRecord {
  readonly path: string; readonly branch?: string | null; readonly is_bare: boolean; readonly is_detached: boolean;
  readonly is_prunable: boolean; readonly is_linked_worktree: boolean; readonly label: string;
  readonly open_workspace_id?: string | null;
}
export interface WorktreeSelector { readonly workspace_id?: string; readonly cwd?: string; }
export interface WorktreeCreateInput extends WorktreeSelector {
  readonly branch?: string; readonly base?: string; readonly path?: string; readonly label?: string; readonly focus?: false;
}
export interface WorktreeOpenInput extends WorktreeSelector {
  readonly branch?: string; readonly path?: string; readonly label?: string; readonly focus?: false;
}
export interface WorktreeCreatedResult {
  readonly workspace: WorkspaceInfo; readonly tab: TabInfo; readonly rootPane: PaneInfo; readonly worktree: WorktreeInfo;
}
export interface WorktreeOpenedResult extends WorktreeCreatedResult { readonly alreadyOpen: boolean; }
export interface WorktreeRemovedResult { readonly workspaceId: string; readonly path: string; readonly forced: boolean; }

export interface TabCreateInput { readonly workspace_id?: string; readonly label?: string; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly focus?: boolean; }
export interface AgentStartInput {
  readonly name: string; readonly argv: readonly string[]; readonly workspace_id?: string; readonly tab_id?: string;
  readonly split?: "right" | "down"; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly focus?: boolean;
}
export interface ReadInput { readonly source: ReadSource; readonly lines?: number; readonly strip_ansi?: boolean; readonly format?: ReadFormat; }

export type LifecycleSubscription =
  | { readonly type: "workspace.created" | "workspace.updated" | "workspace.closed" | "workspace.focused" }
  | { readonly type: "worktree.created" | "worktree.opened" | "worktree.removed" }
  | { readonly type: "tab.created" | "tab.closed" | "tab.focused" }
  | { readonly type: "pane.created" | "pane.closed" | "pane.moved" | "pane.exited" | "pane.focused" }
  | { readonly type: "layout.updated" };
export interface AgentStatusSubscription { readonly type: "pane.agent_status_changed"; readonly pane_id: string; readonly agent_status?: HerdrStatus; }
export type Subscription = LifecycleSubscription | AgentStatusSubscription;

export type EventMatch =
  | { readonly event: "workspace_created"; readonly workspace_id?: string }
  | { readonly event: "workspace_closed"; readonly workspace_id: string }
  | { readonly event: "tab_created"; readonly workspace_id?: string; readonly tab_id?: string }
  | { readonly event: "tab_closed"; readonly tab_id: string }
  | { readonly event: "pane_created"; readonly workspace_id?: string; readonly pane_id?: string }
  | { readonly event: "pane_closed" | "pane_moved" | "pane_exited"; readonly pane_id: string }
  | { readonly event: "pane_agent_status_changed"; readonly pane_id: string; readonly agent_status: HerdrStatus }
  | { readonly event: "worktree_created" | "worktree_opened" | "worktree_removed"; readonly workspace_id?: string };

export interface HerdrEvent extends WireRecord { readonly event: HerdrEventName; readonly data: WireRecord; }
export interface HerdrSubscriptionEvent extends WireRecord {
  readonly event: HerdrEventName | HerdrSubscriptionEventName;
  readonly data: WireRecord;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HerdrProtocolError(`${label} must be an object`, value);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string { if (typeof value !== "string") throw new HerdrProtocolError(`${label} must be a string`, value); return value; }
function bool(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new HerdrProtocolError(`${label} must be a boolean`, value); return value; }
function uint(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new HerdrProtocolError(`${label} must be a safe unsigned integer`, value);
  return value as number;
}
function finiteNumber(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new HerdrProtocolError(`${label} must be a finite number`, value); return value; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new HerdrProtocolError(`${label} must be an array`, value); return value; }
function stringArray(value: unknown, label: string): string[] { return array(value, label).map((entry, index) => string(entry, `${label}[${index}]`)); }
function status(value: unknown, label: string): HerdrStatus {
  if (!["idle", "working", "blocked", "done", "unknown"].includes(value as string)) throw new HerdrProtocolError(`${label} is not an AgentStatus`, value);
  return value as HerdrStatus;
}
function optionalNullableString(value: unknown, label: string): void { if (value !== undefined && value !== null) string(value, label); }
function optionalBoolean(value: unknown, label: string): void { if (value !== undefined) bool(value, label); }
function stringMap(value: unknown, label: string): void {
  if (value === undefined) return;
  const item = record(value, label); for (const [key, entry] of Object.entries(item)) string(entry, `${label}.${key}`);
}

export function decodeAgentSession(value: unknown, label = "agent_session"): AgentSessionInfo {
  const item = record(value, label); string(item.source, `${label}.source`); string(item.agent, `${label}.agent`);
  if (item.kind !== "id" && item.kind !== "path") throw new HerdrProtocolError(`${label}.kind must be id or path`, item.kind);
  string(item.value, `${label}.value`); return value as AgentSessionInfo;
}
function decodeScroll(value: unknown, label: string): PaneScrollInfo {
  const item = record(value, label); uint(item.offset_from_bottom, `${label}.offset_from_bottom`); uint(item.max_offset_from_bottom, `${label}.max_offset_from_bottom`); uint(item.viewport_rows, `${label}.viewport_rows`); return value as PaneScrollInfo;
}
function decodeCommonAgent(item: Record<string, unknown>, label: string): void {
  string(item.terminal_id, `${label}.terminal_id`); string(item.workspace_id, `${label}.workspace_id`);
  string(item.tab_id, `${label}.tab_id`); string(item.pane_id, `${label}.pane_id`); bool(item.focused, `${label}.focused`);
  status(item.agent_status, `${label}.agent_status`); uint(item.revision, `${label}.revision`);
  optionalNullableString(item.agent, `${label}.agent`); optionalNullableString(item.cwd, `${label}.cwd`);
  optionalNullableString(item.foreground_cwd, `${label}.foreground_cwd`); optionalNullableString(item.custom_status, `${label}.custom_status`);
  optionalNullableString(item.display_agent, `${label}.display_agent`); optionalNullableString(item.title, `${label}.title`); optionalNullableString(item.label, `${label}.label`); optionalNullableString(item.name, `${label}.name`);
  stringMap(item.state_labels, `${label}.state_labels`);
  if (item.agent_session !== undefined && item.agent_session !== null) decodeAgentSession(item.agent_session, `${label}.agent_session`);
}
function decodeWorkspaceWorktree(value: unknown, label: string): WorkspaceWorktreeInfo {
  const item = record(value, label); string(item.repo_key, `${label}.repo_key`); string(item.repo_name, `${label}.repo_name`);
  string(item.repo_root, `${label}.repo_root`); string(item.checkout_path, `${label}.checkout_path`); bool(item.is_linked_worktree, `${label}.is_linked_worktree`); return value as WorkspaceWorktreeInfo;
}
export function decodeWorktreeSource(value: unknown, label = "worktree_source"): WorktreeSourceInfo {
  const item = record(value, label); string(item.repo_key, `${label}.repo_key`); string(item.repo_name, `${label}.repo_name`);
  string(item.repo_root, `${label}.repo_root`); string(item.source_checkout_path, `${label}.source_checkout_path`);
  optionalNullableString(item.source_workspace_id, `${label}.source_workspace_id`); return value as WorktreeSourceInfo;
}
export function decodeWorktree(value: unknown, label = "worktree"): WorktreeInfo {
  const item = record(value, label); string(item.path, `${label}.path`); optionalNullableString(item.branch, `${label}.branch`);
  bool(item.is_bare, `${label}.is_bare`); bool(item.is_detached, `${label}.is_detached`); bool(item.is_prunable, `${label}.is_prunable`);
  bool(item.is_linked_worktree, `${label}.is_linked_worktree`); string(item.label, `${label}.label`);
  optionalNullableString(item.open_workspace_id, `${label}.open_workspace_id`); return value as WorktreeInfo;
}
export function decodeWorkspace(value: unknown, label = "workspace"): WorkspaceInfo {
  const item = record(value, label); string(item.workspace_id, `${label}.workspace_id`); uint(item.number, `${label}.number`);
  string(item.label, `${label}.label`); bool(item.focused, `${label}.focused`); uint(item.pane_count, `${label}.pane_count`);
  uint(item.tab_count, `${label}.tab_count`); string(item.active_tab_id, `${label}.active_tab_id`); status(item.agent_status, `${label}.agent_status`);
  if (item.worktree !== undefined && item.worktree !== null) decodeWorkspaceWorktree(item.worktree, `${label}.worktree`);
  return value as WorkspaceInfo;
}
export function decodeTab(value: unknown, label = "tab"): TabInfo {
  const item = record(value, label); string(item.tab_id, `${label}.tab_id`); string(item.workspace_id, `${label}.workspace_id`);
  uint(item.number, `${label}.number`); string(item.label, `${label}.label`); bool(item.focused, `${label}.focused`);
  uint(item.pane_count, `${label}.pane_count`); status(item.agent_status, `${label}.agent_status`); return value as TabInfo;
}
export function decodePane(value: unknown, label = "pane"): PaneInfo {
  const item = record(value, label); decodeCommonAgent(item, label);
  if (item.scroll !== undefined && item.scroll !== null) decodeScroll(item.scroll, `${label}.scroll`);
  return value as PaneInfo;
}
export function decodeAgent(value: unknown, label = "agent"): AgentInfo {
  const item = record(value, label); decodeCommonAgent(item, label); optionalBoolean(item.screen_detection_skipped, `${label}.screen_detection_skipped`); return value as AgentInfo;
}
function decodeRect(value: unknown, label: string): PaneLayoutRect {
  const item = record(value, label); uint(item.x, `${label}.x`, 65_535); uint(item.y, `${label}.y`, 65_535); uint(item.width, `${label}.width`, 65_535); uint(item.height, `${label}.height`, 65_535); return value as PaneLayoutRect;
}
function decodeLayoutPane(value: unknown, label: string): PaneLayoutPane {
  const item = record(value, label); string(item.pane_id, `${label}.pane_id`); bool(item.focused, `${label}.focused`); decodeRect(item.rect, `${label}.rect`); return value as PaneLayoutPane;
}
function decodeLayoutSplit(value: unknown, label: string): PaneLayoutSplit {
  const item = record(value, label); string(item.id, `${label}.id`); if (item.direction !== "right" && item.direction !== "down") throw new HerdrProtocolError(`${label}.direction is invalid`, item.direction);
  finiteNumber(item.ratio, `${label}.ratio`); decodeRect(item.rect, `${label}.rect`); return value as PaneLayoutSplit;
}
export function decodeLayout(value: unknown, label = "layout"): PaneLayout {
  const item = record(value, label); string(item.workspace_id, `${label}.workspace_id`); string(item.tab_id, `${label}.tab_id`);
  bool(item.zoomed, `${label}.zoomed`); decodeRect(item.area, `${label}.area`); string(item.focused_pane_id, `${label}.focused_pane_id`);
  array(item.panes, `${label}.panes`).forEach((entry, index) => decodeLayoutPane(entry, `${label}.panes[${index}]`));
  array(item.splits, `${label}.splits`).forEach((entry, index) => decodeLayoutSplit(entry, `${label}.splits[${index}]`)); return value as PaneLayout;
}
function decodeProcess(value: unknown, label: string): PaneProcess {
  const item = record(value, label); uint(item.pid, `${label}.pid`, 4_294_967_295); string(item.name, `${label}.name`);
  if (item.argv !== undefined && item.argv !== null) stringArray(item.argv, `${label}.argv`);
  optionalNullableString(item.argv0, `${label}.argv0`); optionalNullableString(item.cmdline, `${label}.cmdline`); optionalNullableString(item.cwd, `${label}.cwd`); return value as PaneProcess;
}
export function decodeProcessInfo(value: unknown, label = "process_info"): PaneProcessInfo {
  const item = record(value, label); string(item.pane_id, `${label}.pane_id`);
  if (item.shell_pid !== undefined && item.shell_pid !== null) uint(item.shell_pid, `${label}.shell_pid`, 4_294_967_295);
  optionalNullableString(item.tty, `${label}.tty`);
  if (item.foreground_process_group_id !== undefined && item.foreground_process_group_id !== null) uint(item.foreground_process_group_id, `${label}.foreground_process_group_id`, 4_294_967_295);
  if (item.foreground_processes !== undefined) array(item.foreground_processes, `${label}.foreground_processes`).forEach((entry, index) => decodeProcess(entry, `${label}.foreground_processes[${index}]`));
  return value as PaneProcessInfo;
}
export function decodeRead(value: unknown, label = "read"): ReadResult {
  const item = record(value, label); string(item.pane_id, `${label}.pane_id`); string(item.workspace_id, `${label}.workspace_id`);
  string(item.tab_id, `${label}.tab_id`); if (!HERDR_READ_SOURCES.includes(item.source as ReadSource)) throw new HerdrProtocolError(`${label}.source is invalid`, item.source);
  if (item.format !== "text" && item.format !== "ansi") throw new HerdrProtocolError(`${label}.format is invalid`, item.format);
  string(item.text, `${label}.text`); uint(item.revision, `${label}.revision`); bool(item.truncated, `${label}.truncated`); return value as ReadResult;
}
export function decodeSnapshot(value: unknown): SessionSnapshot {
  const item = record(value, "snapshot"); string(item.version, "snapshot.version"); uint(item.protocol, "snapshot.protocol", 4_294_967_295);
  array(item.workspaces, "snapshot.workspaces").forEach((entry, index) => decodeWorkspace(entry, `snapshot.workspaces[${index}]`));
  array(item.tabs, "snapshot.tabs").forEach((entry, index) => decodeTab(entry, `snapshot.tabs[${index}]`));
  array(item.panes, "snapshot.panes").forEach((entry, index) => decodePane(entry, `snapshot.panes[${index}]`));
  array(item.layouts, "snapshot.layouts").forEach((entry, index) => decodeLayout(entry, `snapshot.layouts[${index}]`));
  array(item.agents, "snapshot.agents").forEach((entry, index) => decodeAgent(entry, `snapshot.agents[${index}]`));
  optionalNullableString(item.focused_workspace_id, "snapshot.focused_workspace_id"); optionalNullableString(item.focused_tab_id, "snapshot.focused_tab_id");
  optionalNullableString(item.focused_pane_id, "snapshot.focused_pane_id"); return value as SessionSnapshot;
}

export function decodeResponseEnvelope(value: unknown, expectedId?: string): ResponseEnvelope {
  const envelope = record(value, "response"); const id = string(envelope.id, "response.id");
  if (expectedId !== undefined && id !== expectedId) throw new HerdrProtocolError(`Response id mismatch: expected ${expectedId}, received ${id}`, value);
  const hasResult = Object.hasOwn(envelope, "result"); const hasError = Object.hasOwn(envelope, "error");
  if (hasResult === hasError) throw new HerdrProtocolError("Response must contain exactly one of result or error", value);
  if (hasError) { const error = record(envelope.error, "response.error"); string(error.code, "response.error.code"); string(error.message, "response.error.message"); return value as ErrorEnvelope; }
  record(envelope.result, "response.result"); return value as SuccessEnvelope;
}

export function decodeResult(value: unknown, expectedType: UsedHerdrResultType): WireRecord {
  const item = record(value, "response.result"); const actualType = string(item.type, "response.result.type");
  if (actualType !== expectedType) throw new HerdrProtocolError(`Expected result type ${expectedType}, received ${actualType}`, value);
  switch (expectedType) {
    case "pong": {
      string(item.version, "response.result.version"); uint(item.protocol, "response.result.protocol", 4_294_967_295);
      if (item.capabilities !== undefined && item.capabilities !== null) { const capabilities = record(item.capabilities, "response.result.capabilities"); bool(capabilities.live_handoff, "response.result.capabilities.live_handoff"); if (capabilities.detached_server_daemon !== undefined) bool(capabilities.detached_server_daemon, "response.result.capabilities.detached_server_daemon"); }
      break;
    }
    case "session_snapshot": decodeSnapshot(item.snapshot); break;
    case "workspace_info": decodeWorkspace(item.workspace, "response.result.workspace"); break;
    case "workspace_list": array(item.workspaces, "response.result.workspaces").forEach((entry, index) => decodeWorkspace(entry, `response.result.workspaces[${index}]`)); break;
    case "tab_created": decodeTab(item.tab, "response.result.tab"); decodePane(item.root_pane, "response.result.root_pane"); break;
    case "tab_info": decodeTab(item.tab, "response.result.tab"); break;
    case "tab_list": array(item.tabs, "response.result.tabs").forEach((entry, index) => decodeTab(entry, `response.result.tabs[${index}]`)); break;
    case "pane_current": case "pane_info": decodePane(item.pane, "response.result.pane"); break;
    case "pane_list": array(item.panes, "response.result.panes").forEach((entry, index) => decodePane(entry, `response.result.panes[${index}]`)); break;
    case "pane_layout": decodeLayout(item.layout, "response.result.layout"); break;
    case "pane_process_info": decodeProcessInfo(item.process_info, "response.result.process_info"); break;
    case "agent_started": decodeAgent(item.agent, "response.result.agent"); stringArray(item.argv, "response.result.argv"); break;
    case "agent_info": decodeAgent(item.agent, "response.result.agent"); break;
    case "agent_list": array(item.agents, "response.result.agents").forEach((entry, index) => decodeAgent(entry, `response.result.agents[${index}]`)); break;
    case "pane_read": decodeRead(item.read, "response.result.read"); break;
    case "wait_matched": decodeEvent(item.event); break;
    case "worktree_list":
      decodeWorktreeSource(item.source, "response.result.source");
      array(item.worktrees, "response.result.worktrees").forEach((entry, index) => decodeWorktree(entry, `response.result.worktrees[${index}]`));
      break;
    case "worktree_created":
      decodeWorkspace(item.workspace, "response.result.workspace"); decodeTab(item.tab, "response.result.tab");
      decodePane(item.root_pane, "response.result.root_pane"); decodeWorktree(item.worktree, "response.result.worktree"); break;
    case "worktree_opened":
      decodeWorkspace(item.workspace, "response.result.workspace"); decodeTab(item.tab, "response.result.tab");
      decodePane(item.root_pane, "response.result.root_pane"); decodeWorktree(item.worktree, "response.result.worktree");
      bool(item.already_open, "response.result.already_open"); break;
    case "worktree_removed":
      string(item.workspace_id, "response.result.workspace_id"); string(item.path, "response.result.path"); bool(item.forced, "response.result.forced"); break;
    case "subscription_started": case "ok": break;
  }
  return value as WireRecord;
}

export function expectResult(value: ResponseEnvelope, expectedType: UsedHerdrResultType): WireRecord {
  if ("error" in value) throw new HerdrApiError(value.id, value.error.code, value.error.message);
  return decodeResult(value.result, expectedType);
}

const EVENT_NAME_SET = new Set<string>(HERDR_EVENT_NAMES);
const SUBSCRIPTION_EVENT_NAME_SET = new Set<string>(HERDR_SUBSCRIPTION_EVENT_NAMES);
export function decodeEvent(value: unknown): HerdrSubscriptionEvent {
  const envelope = record(value, "event envelope"); const name = string(envelope.event, "event envelope.event"); const data = record(envelope.data, "event envelope.data");
  if (EVENT_NAME_SET.has(name)) {
    if (data.type !== name) throw new HerdrProtocolError(`Event data type must equal ${name}`, value);
    validateEventData(name as HerdrEventName, data);
  } else if (SUBSCRIPTION_EVENT_NAME_SET.has(name)) validateSubscriptionEventData(name as HerdrSubscriptionEventName, data);
  else throw new HerdrProtocolError(`Unsupported Herdr event ${name}`, value);
  return value as HerdrSubscriptionEvent;
}
function validateOptionalAgentStatusFields(data: Record<string, unknown>, label: string): void {
  optionalNullableString(data.agent, `${label}.agent`); optionalNullableString(data.custom_status, `${label}.custom_status`);
  optionalNullableString(data.display_agent, `${label}.display_agent`); optionalNullableString(data.title, `${label}.title`); stringMap(data.state_labels, `${label}.state_labels`);
}
function validateEventData(name: HerdrEventName, data: Record<string, unknown>): void {
  if (name === "workspace_created" || name === "workspace_updated") decodeWorkspace(data.workspace, "event.data.workspace");
  else if (name === "workspace_closed") { string(data.workspace_id, "event.data.workspace_id"); if (data.workspace !== undefined && data.workspace !== null) decodeWorkspace(data.workspace, "event.data.workspace"); }
  else if (name === "workspace_focused") string(data.workspace_id, "event.data.workspace_id");
  else if (name === "tab_created") decodeTab(data.tab, "event.data.tab");
  else if (name === "tab_closed" || name === "tab_focused") { string(data.tab_id, "event.data.tab_id"); string(data.workspace_id, "event.data.workspace_id"); }
  else if (name === "pane_created") decodePane(data.pane, "event.data.pane");
  else if (name === "pane_moved") {
    string(data.previous_pane_id, "event.data.previous_pane_id"); string(data.previous_workspace_id, "event.data.previous_workspace_id"); string(data.previous_tab_id, "event.data.previous_tab_id"); decodePane(data.pane, "event.data.pane");
    optionalNullableString(data.closed_tab_id, "event.data.closed_tab_id"); optionalNullableString(data.closed_workspace_id, "event.data.closed_workspace_id");
    if (data.created_tab !== undefined && data.created_tab !== null) decodeTab(data.created_tab, "event.data.created_tab");
    if (data.created_workspace !== undefined && data.created_workspace !== null) decodeWorkspace(data.created_workspace, "event.data.created_workspace");
  } else if (name === "layout_updated") decodeLayout(data.layout, "event.data.layout");
  else if (name === "worktree_created" || name === "worktree_opened") {
    decodeWorkspace(data.workspace, "event.data.workspace"); decodeWorktree(data.worktree, "event.data.worktree");
    if (name === "worktree_opened") bool(data.already_open, "event.data.already_open");
  } else if (name === "worktree_removed") {
    string(data.workspace_id, "event.data.workspace_id"); decodeWorktree(data.worktree, "event.data.worktree"); bool(data.forced, "event.data.forced");
    if (data.workspace !== undefined && data.workspace !== null) decodeWorkspace(data.workspace, "event.data.workspace");
  } else {
    string(data.pane_id, "event.data.pane_id"); string(data.workspace_id, "event.data.workspace_id");
    if (name === "pane_agent_status_changed") { status(data.agent_status, "event.data.agent_status"); validateOptionalAgentStatusFields(data, "event.data"); }
  }
}
function validateSubscriptionEventData(name: HerdrSubscriptionEventName, data: Record<string, unknown>): void {
  string(data.pane_id, "event.data.pane_id"); string(data.workspace_id, "event.data.workspace_id");
  if (name === "pane.agent_status_changed") { status(data.agent_status, "event.data.agent_status"); validateOptionalAgentStatusFields(data, "event.data"); }
  else if (name === "pane.output_matched") { string(data.matched_line, "event.data.matched_line"); decodeRead(data.read, "event.data.read"); }
  else decodeScroll(data.scroll, "event.data.scroll");
}

export function toWireRecord(value: object): WireRecord { return value as WireRecord; }
