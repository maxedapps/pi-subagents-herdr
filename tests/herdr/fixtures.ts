import type { AgentInfo, PaneInfo, PaneLayout, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../src/herdr/protocol.ts";
export const workspace: WorkspaceInfo = { workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" };
export const tab: TabInfo = { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" };
export const nativeSession = { source: "herdr:pi", agent: "pi", kind: "path" as const, value: "/tmp/session.jsonl" };
export const pane: PaneInfo = { pane_id: "w1:p1", terminal_id: "term_parent", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 4, agent: "pi", agent_session: nativeSession };
export const agent: AgentInfo = { terminal_id: "term_parent", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: true, agent_status: "idle", revision: 4, agent: "pi", agent_session: nativeSession };
export const layout: PaneLayout = { workspace_id: "w1", tab_id: "w1:t1", zoomed: false, area: { x: 0, y: 0, width: 80, height: 24 }, focused_pane_id: "w1:p1", panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } }], splits: [{ id: "split-1", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 80, height: 24 } }] };
export const snapshot: SessionSnapshot = { version: "0.7.3", protocol: 16, focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1", workspaces: [workspace], tabs: [tab], panes: [pane], layouts: [layout], agents: [agent] };
export function success(id: string | undefined, result: Record<string, unknown>) { return { id: id ?? "", result } as never; }
