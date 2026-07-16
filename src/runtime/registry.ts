import { assertSubagentRecord, updateMutableTopology, type SubagentRecord } from "../contracts/state.ts";
import type { NativeSessionIdentity } from "../contracts/ownership.ts";
import type { HerdrSubscriptionEvent, SessionSnapshot } from "../herdr/protocol.ts";

export class RegistryIdentityError extends Error { constructor(message: string) { super(message); this.name = "RegistryIdentityError"; } }
function sameProof(left: SubagentRecord["ownership"], right: SubagentRecord["ownership"]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameNative(left: NativeSessionIdentity | undefined, right: NativeSessionIdentity | undefined): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export class SubagentRegistry {
  #byRun = new Map<string, SubagentRecord>();
  #byTerminal = new Map<string, string>();
  get size(): number { return this.#byRun.size; }
  list(): readonly SubagentRecord[] { return [...this.#byRun.values()]; }
  get(runId: string): SubagentRecord | undefined { return this.#byRun.get(runId); }
  getByTerminal(terminalId: string): SubagentRecord | undefined { const runId = this.#byTerminal.get(terminalId); return runId ? this.#byRun.get(runId) : undefined; }

  register(record: SubagentRecord): void {
    assertSubagentRecord(record);
    if (this.#byRun.has(record.id)) throw new RegistryIdentityError(`Run id ${record.id} is already registered`);
    if (record.terminalId) { const owner = this.#byTerminal.get(record.terminalId); if (owner) throw new RegistryIdentityError(`Terminal ${record.terminalId} is already bound to ${owner}`); }
    this.#byRun.set(record.id, record); if (record.terminalId) this.#byTerminal.set(record.terminalId, record.id);
  }

  bindTerminal(runId: string, binding: { readonly terminalId: string; readonly nativeSession?: NativeSessionIdentity }, now = Date.now()): SubagentRecord {
    const existing = this.#byRun.get(runId); if (!existing) throw new RegistryIdentityError(`Unknown run ${runId}`);
    if (!binding.terminalId) throw new RegistryIdentityError("Terminal identity must be non-empty");
    if (existing.terminalId !== undefined || existing.ownership.child.terminalId !== undefined) throw new RegistryIdentityError(`Run ${runId} already has a terminal binding`);
    const owner = this.#byTerminal.get(binding.terminalId); if (owner) throw new RegistryIdentityError(`Terminal ${binding.terminalId} is already bound to ${owner}`);
    const priorNative = existing.ownership.child.nativeSession;
    if (priorNative !== undefined && binding.nativeSession !== undefined && !sameNative(priorNative, binding.nativeSession)) throw new RegistryIdentityError(`Run ${runId} native session proof changed during terminal binding`);
    const child = { ...existing.ownership.child, terminalId: binding.terminalId, ...(priorNative === undefined && binding.nativeSession !== undefined ? { nativeSession: binding.nativeSession } : {}) };
    const record: SubagentRecord = { ...existing, ownership: { ...existing.ownership, child }, terminalId: binding.terminalId, updatedAt: now };
    assertSubagentRecord(record); this.#byRun.set(runId, record); this.#byTerminal.set(binding.terminalId, runId); return record;
  }

  update(record: SubagentRecord): void {
    assertSubagentRecord(record); const existing = this.#byRun.get(record.id); if (!existing) throw new RegistryIdentityError(`Unknown run ${record.id}`);
    if (existing.ownership.runNonce !== record.ownership.runNonce || existing.terminalId !== record.terminalId || !sameProof(existing.ownership, record.ownership)) throw new RegistryIdentityError(`Immutable ownership or terminal identity changed for run ${record.id}`);
    if (record.terminalId && this.#byTerminal.get(record.terminalId) !== record.id) throw new RegistryIdentityError(`Terminal reverse binding is missing or stale for run ${record.id}`);
    this.#byRun.set(record.id, record);
  }

  applySnapshot(snapshot: SessionSnapshot, now = Date.now()): void {
    const byTerminal = new Map(snapshot.panes.map((pane) => [pane.terminal_id, pane] as const));
    for (const record of this.#byRun.values()) {
      if (!record.terminalId) continue;
      const pane = byTerminal.get(record.terminalId);
      if (!pane) { if (record.lifecycle !== "stopped" && record.lifecycle !== "failed") this.update({ ...record, lifecycle: "lost", herdrStatus: "unknown", updatedAt: now }); continue; }
      this.update({ ...updateMutableTopology(record, { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id }, now), herdrStatus: pane.agent_status });
    }
  }

  applyEvent(event: HerdrSubscriptionEvent, now = Date.now()): void {
    if (event.event === "pane_moved") {
      const value = event.data.pane; if (typeof value !== "object" || value === null || Array.isArray(value)) return; const pane = value as Record<string, unknown>;
      if (typeof pane.terminal_id !== "string" || typeof pane.pane_id !== "string" || typeof pane.tab_id !== "string" || typeof pane.workspace_id !== "string") return;
      const record = this.getByTerminal(pane.terminal_id); if (!record) return;
      this.update(updateMutableTopology(record, { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id }, now)); return;
    }
    if (event.event === "pane_agent_status_changed" || event.event === "pane.agent_status_changed") {
      const paneId = event.data.pane_id; if (typeof paneId !== "string") return;
      const record = [...this.#byRun.values()].find((candidate) => candidate.paneId === paneId); if (!record) return;
      const next = event.data.agent_status; if (next === "idle" || next === "working" || next === "blocked" || next === "done" || next === "unknown") this.update({ ...record, herdrStatus: next, updatedAt: now }); return;
    }
    if (event.event === "pane_closed" || event.event === "pane_exited") {
      const paneId = event.data.pane_id; const record = [...this.#byRun.values()].find((candidate) => candidate.paneId === paneId); if (!record) return;
      this.update({ ...record, lifecycle: event.event === "pane_closed" ? "stopped" : "lost", herdrStatus: "unknown", updatedAt: now });
    }
  }
}
