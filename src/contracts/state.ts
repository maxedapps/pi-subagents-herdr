import type { Harness } from "./harness.ts";
import type { OwnershipProof } from "./ownership.ts";

export type HerdrStatus = "working" | "blocked" | "done" | "idle" | "unknown";
export type RunLifecycle =
  | "starting"
  | "running"
  | "interrupting"
  | "stopping"
  | "stopped"
  | "failed"
  | "lost";

interface StateBase {
  readonly herdrStatus: HerdrStatus;
  readonly changedAt: number;
}

export type RunState =
  | (StateBase & { readonly lifecycle: "starting" })
  | (StateBase & { readonly lifecycle: "running" })
  | (StateBase & { readonly lifecycle: "interrupting" })
  | (StateBase & { readonly lifecycle: "stopping" })
  | (StateBase & { readonly lifecycle: "stopped"; readonly reason?: string })
  | (StateBase & { readonly lifecycle: "failed"; readonly error: string })
  | (StateBase & { readonly lifecycle: "lost"; readonly reason: string });

export interface MutableTopology {
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
}

export interface SubagentRecord extends MutableTopology {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ownership: OwnershipProof;
  readonly profileName: string;
  readonly harness: Harness;
  lifecycle: RunLifecycle;
  herdrStatus: HerdrStatus;
  /** Stable Herdr identity after launch. Never rewrite this from topology events. */
  readonly terminalId?: string;
  readonly createdAt: number;
  updatedAt: number;
}

export function assertSubagentRecord(record: SubagentRecord): void {
  if (record.schemaVersion !== 1) throw new Error("Unsupported subagent record schema");
  if (record.id.length === 0 || record.ownership.runNonce.length === 0) {
    throw new Error("Subagent identity and run nonce must be non-empty");
  }
  const proofTerminal = record.ownership.child.terminalId;
  if (record.terminalId !== proofTerminal) throw new Error("Stable terminal identity does not match ownership proof; the one-time binding must be exact");
}

export function updateMutableTopology(
  record: SubagentRecord,
  topology: Readonly<MutableTopology>,
  updatedAt: number,
): SubagentRecord {
  const next: SubagentRecord = {
    ...record,
    updatedAt,
  };
  if (topology.paneId === undefined) delete next.paneId;
  else next.paneId = topology.paneId;
  if (topology.tabId === undefined) delete next.tabId;
  else next.tabId = topology.tabId;
  if (topology.workspaceId === undefined) delete next.workspaceId;
  else next.workspaceId = topology.workspaceId;
  assertSubagentRecord(next);
  return next;
}
