#!/usr/bin/env -S node --throw-deprecation --import tsx
import { randomUUID } from "node:crypto";
import { HerdrClient } from "../src/herdr/client.ts";
import { HerdrNdjsonTransport } from "../src/herdr/transport.ts";
import type { HerdrSubscriptionEvent, PaneInfo, TabInfo } from "../src/herdr/protocol.ts";

const socketPath = process.env.HERDR_SOCKET_PATH;
const callerPaneId = process.env.HERDR_PANE_ID;
if (process.env.HERDR_ENV !== "1" || !socketPath || !callerPaneId) throw new Error("Run inside the owning Herdr pane with HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_PANE_ID");
const client = new HerdrClient(new HerdrNdjsonTransport({ socketPath, connectTimeoutMs: 2_000, responseTimeoutMs: 5_000 }));
const resources: { tab?: TabInfo; root?: PaneInfo; closed?: boolean } = {};
const events: HerdrSubscriptionEvent[] = [];
let subscription: Awaited<ReturnType<HerdrClient["subscribe"]>> | undefined;
let collector: Promise<void> | undefined;
let collectorError: unknown;
const report: Record<string, unknown> = { started_at: new Date().toISOString(), created: [], closed: [], retained: [], checks: [] };

async function verifiedCleanup(): Promise<void> {
  if (!resources.root || resources.closed) return;
  try {
    const snapshot = await client.snapshot();
    const current = snapshot.panes.find((pane) => pane.terminal_id === resources.root!.terminal_id);
    if (!current) { resources.closed = true; return; }
    if (!resources.tab || current.tab_id !== resources.tab.tab_id) { (report.retained as unknown[]).push({ terminal_id: resources.root.terminal_id, reason: "created terminal moved outside the created tab" }); return; }
    await client.closePane(current.pane_id); resources.closed = true; (report.closed as unknown[]).push({ pane_id: current.pane_id, terminal_id: current.terminal_id });
  } catch (error) { (report.retained as unknown[]).push({ terminal_id: resources.root.terminal_id, reason: error instanceof Error ? error.message : String(error) }); }
}

try {
  const ping = await client.assertCompatible(); (report.checks as unknown[]).push({ ping });
  const before = await client.snapshot(); (report.checks as unknown[]).push({ snapshot: { workspaces: before.workspaces.length, tabs: before.tabs.length, panes: before.panes.length } });
  const caller = await client.currentPane(callerPaneId); (report.checks as unknown[]).push({ current_pane: { pane_id: caller.pane_id, terminal_id: caller.terminal_id } });
  const controller = new AbortController();
  subscription = await client.subscribe([{ type: "tab.created" }, { type: "pane.created" }, { type: "pane.closed" }, { type: "tab.closed" }], controller.signal);
  collector = (async () => { try { for await (const event of subscription!) events.push(event); } catch (error) { if (!controller.signal.aborted) collectorError = error; } })();
  const created = await client.createTab({ workspace_id: caller.workspace_id, label: `pi-herdr-conformance-${randomUUID().slice(0, 8)}`, focus: false });
  resources.tab = created.tab; resources.root = created.rootPane; (report.created as unknown[]).push({ tab_id: created.tab.tab_id, pane_id: created.rootPane.pane_id, terminal_id: created.rootPane.terminal_id });
  if (created.tab.focused || created.rootPane.focused) throw new Error("No-focus tab creation unexpectedly focused the disposable resource");
  const [tab, pane, layout, processInfo] = await Promise.all([client.getTab(created.tab.tab_id), client.getPane(created.rootPane.pane_id), client.getPaneLayout(created.rootPane.pane_id), client.getPaneProcessInfo(created.rootPane.pane_id)]);
  if (pane.terminal_id !== created.rootPane.terminal_id || tab.tab_id !== created.tab.tab_id || layout.tab_id !== tab.tab_id || processInfo.pane_id !== pane.pane_id) throw new Error("Created resource identity did not reconcile across get/layout/process responses");
  await client.sendInput(pane.pane_id, "printf '__PI_HERDR_NO_MODEL_CONFORMANCE__\\n'", ["enter"]);
  (report.checks as unknown[]).push({ get_layout_process_send: true });
  await verifiedCleanup();
  await new Promise((resolve) => setTimeout(resolve, 150)); controller.abort(); subscription.close(); await collector;
  if (collectorError !== undefined) throw collectorError;
  const names = events.map((event) => event.event); (report.checks as unknown[]).push({ subscription_events: names });
  if (!names.includes("tab_created") || !names.includes("pane_created") || !names.includes("pane_closed")) throw new Error(`Missing expected subscription events: ${names.join(", ")}`);
  report.ok = (report.retained as unknown[]).length === 0;
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); await verifiedCleanup(); report.ok = false;
} finally { subscription?.close(); await collector?.catch(() => undefined); report.finished_at = new Date().toISOString(); }
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
