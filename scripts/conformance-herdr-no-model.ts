#!/usr/bin/env -S node --throw-deprecation --import tsx
import { randomUUID } from "node:crypto";
import { HerdrClient } from "../src/herdr/client.ts";
import { HerdrNdjsonTransport } from "../src/herdr/transport.ts";
import type { AgentInfo, PaneInfo, TabInfo } from "../src/herdr/protocol.ts";
import { reconcileExactPlacement, verifyIdleShell } from "../src/runtime/groups.ts";

const socketPath = process.env.HERDR_SOCKET_PATH;
const callerPaneId = process.env.HERDR_PANE_ID;
if (process.env.HERDR_ENV !== "1" || !socketPath || !callerPaneId) throw new Error("Run inside the owning Herdr pane with HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_PANE_ID");
const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath, connectTimeoutMs: 2_000, responseTimeoutMs: 5_000 }));
const resources: { tab?: TabInfo; root?: PaneInfo; child?: AgentInfo; tabClosed?: boolean; childClosed?: boolean } = {};
const report: Record<string, unknown> = { started_at: new Date().toISOString(), created: [], closed: [], retained: [], checks: [] };

function retain(resource: string, reason: string): void { (report.retained as unknown[]).push({ resource, reason }); }

async function verifiedCleanup(): Promise<void> {
  try {
    let snapshot = await client.snapshot();
    if (resources.child && !resources.childClosed) {
      const childPane = snapshot.panes.find((pane) => pane.terminal_id === resources.child!.terminal_id);
      const childAgent = snapshot.agents.find((agent) => agent.terminal_id === resources.child!.terminal_id);
      if (childPane) {
        if (childPane.pane_id !== resources.child.pane_id || childPane.workspace_id !== resources.child.workspace_id || childPane.tab_id !== resources.child.tab_id
          || childAgent && (childAgent.pane_id !== childPane.pane_id || childAgent.workspace_id !== childPane.workspace_id || childAgent.tab_id !== childPane.tab_id)) {
          retain(`child terminal ${resources.child.terminal_id}`, "fresh pane/agent topology no longer matches the returned agent.start identity");
          return;
        }
        await client.closePane(childPane.pane_id);
        snapshot = await client.snapshot();
        if (snapshot.panes.some((pane) => pane.terminal_id === resources.child!.terminal_id) || snapshot.agents.some((agent) => agent.terminal_id === resources.child!.terminal_id)) {
          retain(`child terminal ${resources.child.terminal_id}`, "exact pane close returned but child identity remains");
          return;
        }
        resources.childClosed = true; (report.closed as unknown[]).push({ pane_id: childPane.pane_id, terminal_id: childPane.terminal_id });
      } else if (childAgent) {
        retain(`child terminal ${resources.child.terminal_id}`, "agent remains without a matching pane");
        return;
      } else resources.childClosed = true;
    }

    if (!resources.root || !resources.tab || resources.tabClosed) return;
    snapshot = await client.snapshot();
    const root = snapshot.panes.find((pane) => pane.terminal_id === resources.root!.terminal_id);
    const tab = snapshot.tabs.find((candidate) => candidate.tab_id === resources.tab!.tab_id);
    if (!root && !tab) { resources.tabClosed = true; return; }
    if (!root || !tab || root.pane_id !== resources.root.pane_id || root.workspace_id !== resources.root.workspace_id || root.tab_id !== resources.tab.tab_id || tab.workspace_id !== resources.root.workspace_id) {
      retain(`tab ${resources.tab.tab_id}`, "fresh topology no longer matches the exact created root/tab identity");
      return;
    }
    const idleDeadline = Date.now() + 5_000;
    let idleReason = "root process state was not checked";
    while (true) {
      snapshot = await client.snapshot();
      const currentRoot = snapshot.panes.find((pane) => pane.terminal_id === resources.root!.terminal_id);
      const tabPanes = snapshot.panes.filter((pane) => pane.tab_id === resources.tab!.tab_id);
      if (!currentRoot || currentRoot.pane_id !== resources.root.pane_id || currentRoot.tab_id !== resources.tab.tab_id
        || tabPanes.length !== 1 || tabPanes[0]!.terminal_id !== resources.root.terminal_id) {
        retain(`tab ${resources.tab.tab_id}`, "unknown, moved, or non-root panes remain in the created tab");
        return;
      }
      const idle = verifyIdleShell(await client.getPaneProcessInfo(currentRoot.pane_id));
      if (idle.idle) break;
      idleReason = idle.reason;
      if (Date.now() >= idleDeadline) { retain(`tab ${resources.tab.tab_id}`, `root did not become an idle shell within 5000 ms: ${idleReason}`); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await client.closeTab(resources.tab.tab_id);
    snapshot = await client.snapshot();
    if (snapshot.tabs.some((candidate) => candidate.tab_id === resources.tab!.tab_id) || snapshot.panes.some((pane) => pane.terminal_id === resources.root!.terminal_id)) {
      retain(`tab ${resources.tab.tab_id}`, "exact tab close returned but created topology remains");
      return;
    }
    resources.tabClosed = true; (report.closed as unknown[]).push({ tab_id: resources.tab.tab_id, root_terminal_id: resources.root.terminal_id });
  } catch (error) {
    retain(resources.child ? `child ${resources.child.terminal_id}` : resources.root ? `root ${resources.root.terminal_id}` : "uncreated placement", error instanceof Error ? error.message : String(error));
  }
}

try {
  const ping = await client.assertCompatible(); (report.checks as unknown[]).push({ ping });
  const caller = await client.currentPane(callerPaneId); (report.checks as unknown[]).push({ current_pane: { pane_id: caller.pane_id, terminal_id: caller.terminal_id } });
  const suffix = randomUUID().slice(0, 8);
  const created = await client.createTab({ workspace_id: caller.workspace_id, label: `pi-herdr-placement-${suffix}`, focus: false });
  resources.tab = created.tab; resources.root = created.rootPane; (report.created as unknown[]).push({ tab_id: created.tab.tab_id, pane_id: created.rootPane.pane_id, terminal_id: created.rootPane.terminal_id });
  if (created.tab.focused || created.rootPane.focused) throw new Error("No-focus tab creation unexpectedly focused the disposable resource");
  await reconcileExactPlacement(client, { workspaceId: caller.workspace_id, tabId: created.tab.tab_id, rootPaneId: created.rootPane.pane_id, rootTerminalId: created.rootPane.terminal_id });
  const processInfo = await client.getPaneProcessInfo(created.rootPane.pane_id);
  if (processInfo.pane_id !== created.rootPane.pane_id) throw new Error("Placement process probe returned a different root pane");
  const child = await client.startAgent({ name: `pi-herdr-no-model-${suffix}`, argv: ["/bin/sh", "-lc", "printf '__PI_HERDR_NO_MODEL_PLACEMENT__\\n'; sleep 2"], workspace_id: caller.workspace_id, tab_id: created.tab.tab_id, cwd: process.cwd(), focus: false });
  resources.child = child; (report.created as unknown[]).push({ agent_terminal_id: child.terminal_id, pane_id: child.pane_id, tab_id: child.tab_id, workspace_id: child.workspace_id });
  if (child.workspace_id !== caller.workspace_id || child.tab_id !== created.tab.tab_id || child.focused) throw new Error("agent.start returned outside the exact no-focus placement");
  const afterStart = await client.snapshot();
  const childPane = afterStart.panes.find((pane) => pane.terminal_id === child.terminal_id);
  if (!childPane || childPane.pane_id !== child.pane_id || childPane.workspace_id !== child.workspace_id || childPane.tab_id !== child.tab_id) throw new Error("agent.start child identity did not reconcile in a fresh snapshot");
  (report.checks as unknown[]).push({ exact_placement_ready: true, agent_start_no_model: true });
  await verifiedCleanup();
  report.ok = (report.retained as unknown[]).length === 0 && resources.childClosed === true && resources.tabClosed === true;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); await verifiedCleanup(); report.ok = false;
} finally { report.finished_at = new Date().toISOString(); }
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
