import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrRequestClient } from "../herdr/client.ts";
import type { SessionSnapshot } from "../herdr/protocol.ts";
import { reconcileOwnership, recoverActiveBranchOwnership, type CurrentParentIdentity, type OperationalMetadata, type PiBranchEntry } from "./ownership.ts";

export type RecoveryDisposition = "owned" | "orphaned" | "uncertain";
export interface RecoveryRecord { readonly runId: string; readonly disposition: RecoveryDisposition; readonly reason: string; }
export interface RecoverableRuntimeService { stop(): void | Promise<void>; }

export class RuntimeRecovery {
  #records = new Map<string, RecoveryRecord>(); #beforeTreeOwned = new Set<string>(); #services = new Set<RecoverableRuntimeService>();
  list(): readonly RecoveryRecord[] { return [...this.#records.values()]; }
  registerService(service: RecoverableRuntimeService): void { this.#services.add(service); }
  recover(activeBranch: readonly PiBranchEntry[], snapshot: SessionSnapshot, currentParent: CurrentParentIdentity, metadata: readonly OperationalMetadata[] = [], forceObservational = false): readonly RecoveryRecord[] {
    const active = recoverActiveBranchOwnership(activeBranch); const ids = new Set([...active.keys(), ...metadata.flatMap((item) => item.runId ? [item.runId] : [])]);
    const next = new Map<string, RecoveryRecord>();
    for (const runId of ids) {
      if (forceObservational) { next.set(runId, { runId, disposition: "orphaned", reason: "Forked/new Pi sessions cannot inherit ownership without an explicit transfer protocol" }); continue; }
      const evidence = metadata.find((item) => item.runId === runId); const result = reconcileOwnership({ runId, active, snapshot, currentParent, ...(evidence === undefined ? {} : { metadata: evidence }) });
      next.set(runId, { runId, disposition: result.state, reason: result.reason });
    }
    this.#records = next; return this.list();
  }
  sessionBeforeTree(): void { this.#beforeTreeOwned = new Set([...this.#records.values()].filter((item) => item.disposition === "owned").map((item) => item.runId)); }
  sessionTree(activeBranch: readonly PiBranchEntry[], snapshot: SessionSnapshot, currentParent: CurrentParentIdentity, metadata: readonly OperationalMetadata[] = []): readonly RecoveryRecord[] {
    this.recover(activeBranch, snapshot, currentParent, metadata);
    for (const runId of this.#beforeTreeOwned) if (this.#records.get(runId)?.disposition !== "owned") this.#records.set(runId, { runId, disposition: "orphaned", reason: "Run belongs to the abandoned Pi /tree branch" });
    this.#beforeTreeOwned.clear(); return this.list();
  }
  sessionStart(reason: "startup" | "reload" | "new" | "resume" | "fork", activeBranch: readonly PiBranchEntry[], snapshot: SessionSnapshot, currentParent: CurrentParentIdentity, metadata: readonly OperationalMetadata[] = []): readonly RecoveryRecord[] {
    return this.recover(activeBranch, snapshot, currentParent, metadata, reason === "fork" || reason === "new");
  }
  async sessionShutdown(): Promise<void> {
    await Promise.all([...this.#services].map((service) => Promise.resolve(service.stop()).catch(() => undefined))); this.#services.clear();
  }
}

export interface RecoveryLifecycleOptions {
  readonly runtime: RuntimeRecovery;
  readonly client: HerdrRequestClient;
  readonly metadata?: () => readonly OperationalMetadata[];
  readonly onRecovered?: (records: readonly RecoveryRecord[]) => void;
}

function contextIdentity(context: ExtensionContext): CurrentParentIdentity {
  const sessionId = context.sessionManager.getSessionId(); const sessionPath = context.sessionManager.getSessionFile();
  return { sessionId, ...(sessionPath === undefined ? {} : { sessionPath }) };
}

/** Wire Pi branch/session lifecycle to recovery. It never closes child resources. */
export function registerRecoveryLifecycle(pi: ExtensionAPI, options: RecoveryLifecycleOptions): void {
  const branch = (context: ExtensionContext) => context.sessionManager.getBranch() as readonly PiBranchEntry[];
  pi.on("session_start", async (event, context) => {
    const records = options.runtime.sessionStart(event.reason, branch(context), await options.client.snapshot(), contextIdentity(context), options.metadata?.() ?? []);
    options.onRecovered?.(records);
  });
  pi.on("session_before_tree", () => { options.runtime.sessionBeforeTree(); });
  pi.on("session_tree", async (_event, context) => {
    const records = options.runtime.sessionTree(branch(context), await options.client.snapshot(), contextIdentity(context), options.metadata?.() ?? []);
    options.onRecovered?.(records);
  });
  pi.on("session_shutdown", async () => { await options.runtime.sessionShutdown(); });
}
