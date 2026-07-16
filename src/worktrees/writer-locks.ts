import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { HERDR_PROTOCOL_VERSION, MINIMUM_HERDR_VERSION } from "../contracts/protocol.ts";
import type { HerdrRequestClient } from "../herdr/client.ts";
import type {
  CheckoutIdentity,
  HerdrLeaseReconciliation,
  WriterBinding,
  WriterLease,
} from "./contracts.ts";

const execFileAsync = promisify(execFile);
const LEASE_DIRECTORY = join(".subagents", "writer-leases");
const LEASE_FILE = "writer.json";
const TRANSACTION_LOCK = "writer.transaction.lock";

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function git(checkout: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return result.stdout.trim();
}

/** Resolve immutable-enough local Git identity without reading mutable branch names. */
export async function identifyCheckout(path: string): Promise<CheckoutIdentity> {
  const requested = await realpath(resolve(path));
  const rootText = await git(requested, ["rev-parse", "--show-toplevel"]);
  const checkoutPath = await realpath(rootText);
  if (!isWithin(checkoutPath, requested)) throw new Error("Git returned a checkout outside the requested path");
  const commonText = await git(checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonGitDir = await realpath(commonText);
  const gitHead = await git(checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40,64}$/i.test(gitHead)) throw new Error("Git HEAD did not resolve to a commit object");
  const repositoryId = `git-common-dir:${createHash("sha256").update(commonGitDir).digest("hex")}`;
  return { schemaVersion: 1, repositoryId, commonGitDir, checkoutPath, gitHead };
}

function sameCheckout(left: CheckoutIdentity, right: CheckoutIdentity): boolean {
  return left.repositoryId === right.repositoryId
    && left.commonGitDir === right.commonGitDir
    && left.checkoutPath === right.checkoutPath;
}

function sameBinding(left: Pick<WriterLease, keyof WriterBinding>, right: WriterBinding): boolean {
  return left.runId === right.runId
    && left.runNonce === right.runNonce
    && left.terminalId === right.terminalId
    && JSON.stringify(left.nativeSession) === JSON.stringify(right.nativeSession)
    && JSON.stringify(left.parent) === JSON.stringify(right.parent);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${label} must be a non-empty string`);
}

function decodeLease(value: unknown): WriterLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Writer lease must be an object");
  const lease = value as Record<string, unknown>;
  if (lease.schemaVersion !== 1) throw new Error("Unsupported writer lease schema");
  for (const key of ["runId", "runNonce", "terminalId"] as const) nonEmpty(lease[key], `lease.${key}`);
  if (typeof lease.checkout !== "object" || lease.checkout === null || Array.isArray(lease.checkout)) throw new Error("Writer lease checkout identity is malformed");
  const checkout = lease.checkout as Record<string, unknown>;
  if (checkout.schemaVersion !== 1) throw new Error("Writer lease checkout schema is malformed");
  for (const key of ["repositoryId", "commonGitDir", "checkoutPath", "gitHead"] as const) nonEmpty(checkout[key], `lease.checkout.${key}`);
  if (typeof lease.nativeSession !== "object" || lease.nativeSession === null || Array.isArray(lease.nativeSession)) throw new Error("Writer lease native session is malformed");
  const native = lease.nativeSession as Record<string, unknown>;
  if (native.kind !== "id" && native.kind !== "path") throw new Error("Writer lease native session kind is malformed");
  nonEmpty(native.value, "lease.nativeSession.value"); nonEmpty(native.source, "lease.nativeSession.source");
  if (typeof lease.parent !== "object" || lease.parent === null || Array.isArray(lease.parent)) throw new Error("Writer lease parent proof is malformed");
  const parent = lease.parent as Record<string, unknown>;
  nonEmpty(parent.sessionId, "lease.parent.sessionId"); nonEmpty(parent.branchEntryId, "lease.parent.branchEntryId");
  if (parent.sessionPath !== undefined) nonEmpty(parent.sessionPath, "lease.parent.sessionPath");
  if (!Number.isSafeInteger(lease.acquiredAt) || !Number.isSafeInteger(lease.updatedAt)) throw new Error("Writer lease timestamps are malformed");
  if (typeof lease.lastReconciled !== "object" || lease.lastReconciled === null || Array.isArray(lease.lastReconciled)) throw new Error("Writer lease reconciliation is malformed");
  const reconciliation = lease.lastReconciled as Record<string, unknown>;
  if (!["live", "gone", "uncertain"].includes(String(reconciliation.state))) throw new Error("Writer lease reconciliation state is malformed");
  if (reconciliation.protocol !== HERDR_PROTOCOL_VERSION || !Number.isSafeInteger(reconciliation.checkedAt)) throw new Error("Writer lease reconciliation protocol/timestamp is malformed");
  nonEmpty(reconciliation.herdrVersion, "lease.lastReconciled.herdrVersion"); nonEmpty(reconciliation.reason, "lease.lastReconciled.reason"); nonEmpty(reconciliation.boundTerminalId, "lease.lastReconciled.boundTerminalId");
  if (typeof reconciliation.boundNativeSession !== "object" || reconciliation.boundNativeSession === null || Array.isArray(reconciliation.boundNativeSession)) throw new Error("Writer lease reconciled native session is malformed");
  const reconciledNative = reconciliation.boundNativeSession as Record<string, unknown>; if (reconciledNative.kind !== "id" && reconciledNative.kind !== "path") throw new Error("Writer lease reconciled native session kind is malformed"); nonEmpty(reconciledNative.value, "lease.lastReconciled.boundNativeSession.value"); nonEmpty(reconciledNative.source, "lease.lastReconciled.boundNativeSession.source");
  if (reconciliation.boundTerminalId !== lease.terminalId || JSON.stringify(reconciliation.boundNativeSession) !== JSON.stringify(lease.nativeSession)) throw new Error("Writer lease reconciliation is not bound to the lease terminal/native session");
  return value as WriterLease;
}

function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): readonly number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const left = parse(actual); const right = parse(minimum);
  if (!left || !right || actual.includes("-")) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

function sameNativeSession(
  actual: { readonly kind: "id" | "path"; readonly value: string; readonly source: string } | null | undefined,
  expected: WriterBinding["nativeSession"],
): boolean {
  return actual !== undefined && actual !== null
    && actual.kind === expected.kind && actual.value === expected.value && actual.source === expected.source;
}

/** Herdr, not elapsed time or process liveness, decides whether a durable writer binding is gone. */
export async function reconcileWriterLeaseWithHerdr(
  client: HerdrRequestClient,
  lease: WriterLease,
  signal?: AbortSignal,
): Promise<HerdrLeaseReconciliation> {
  const ping = await client.ping(signal);
  if (ping.protocol !== HERDR_PROTOCOL_VERSION || !semverAtLeast(ping.version, MINIMUM_HERDR_VERSION)) {
    throw new Error(`Incompatible Herdr ${ping.version}/protocol ${ping.protocol}; writer lease retained`);
  }
  const snapshot = await client.snapshot(signal);
  if (snapshot.protocol !== HERDR_PROTOCOL_VERSION) throw new Error(`Herdr snapshot protocol ${snapshot.protocol} is incompatible; writer lease retained`);
  const pane = snapshot.panes.find((candidate) => candidate.terminal_id === lease.terminalId);
  const agent = snapshot.agents.find((candidate) => candidate.terminal_id === lease.terminalId);
  const nativeElsewhere = snapshot.agents.find((candidate) => sameNativeSession(candidate.agent_session, lease.nativeSession));
  const base = { checkedAt: Date.now(), herdrVersion: ping.version, protocol: HERDR_PROTOCOL_VERSION, boundTerminalId: lease.terminalId, boundNativeSession: lease.nativeSession } as const;
  if (!pane && !agent && !nativeElsewhere) return { ...base, state: "gone", reason: "Bound terminal and native session are absent from the compatible live Herdr snapshot" };
  if (!pane || !agent) return { ...base, state: "uncertain", reason: "Herdr exposes only part of the bound terminal identity; lease retained", ...(pane ? { paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id } : {}) };
  if (pane.pane_id !== agent.pane_id || pane.tab_id !== agent.tab_id || pane.workspace_id !== agent.workspace_id) {
    return { ...base, state: "uncertain", reason: "Bound pane and agent topology disagree; lease retained", paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
  }
  if (!sameNativeSession(agent.agent_session, lease.nativeSession)) {
    return { ...base, state: "uncertain", reason: "Bound terminal exists with a different or missing native session; lease retained", paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
  }
  return { ...base, state: "live", reason: "Bound terminal, native session, and topology are live", paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id };
}

async function ensureLeaseDirectory(checkout: CheckoutIdentity): Promise<string> {
  const subagents = join(checkout.checkoutPath, ".subagents");
  try {
    const info = await lstat(subagents);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Checkout .subagents path is not a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { await mkdir(subagents, { mode: 0o700 }); }
    catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
    const created = await lstat(subagents);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Checkout .subagents path is not a real directory");
  }
  const directory = join(checkout.checkoutPath, LEASE_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  if (!isWithin(checkout.checkoutPath, canonical)) throw new Error("Writer lease directory escaped the canonical checkout");
  return canonical;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

interface TransactionLockOwner { readonly pid: number; readonly nonce: string; readonly acquiredAt: number; }
const TRANSACTION_OWNER_FILE = "owner.json";
const TRANSACTION_RECLAIM_DIRECTORY = ".reclaim";

function decodeTransactionOwner(value: unknown): TransactionLockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Transaction lock owner is malformed");
  const owner = value as Record<string, unknown>;
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || !Number.isSafeInteger(owner.acquiredAt)) throw new Error("Transaction lock owner pid/timestamp is malformed");
  nonEmpty(owner.nonce, "transaction lock nonce");
  return value as TransactionLockOwner;
}
async function readTransactionOwner(path: string): Promise<{ owner: TransactionLockOwner; dev: number; ino: number }> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Transaction lock is not a real directory");
  const owner = decodeTransactionOwner(JSON.parse(await readFile(join(path, TRANSACTION_OWNER_FILE), "utf8")));
  return { owner, dev: info.dev, ino: info.ino };
}
async function createTransactionOwner(path: string, owner: TransactionLockOwner): Promise<{ dev: number; ino: number } | undefined> {
  const candidate = `${path}.${process.pid}.${owner.nonce}.candidate`;
  await mkdir(candidate, { mode: 0o700 });
  try {
    const handle = await open(join(candidate, TRANSACTION_OWNER_FILE), "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await rename(candidate, path); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      return undefined;
    }
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino };
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

/** Directory ownership plus an in-directory reclaim claim prevents stale reclaimers deleting a successor lock. */
async function acquireTransactionLock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  const owner: TransactionLockOwner = { pid: process.pid, nonce: randomUUID(), acquiredAt: Date.now() };
  while (true) {
    try {
      const identity = await createTransactionOwner(path, owner);
      if (identity) {
        return async () => {
          let current: Awaited<ReturnType<typeof readTransactionOwner>>;
          try { current = await readTransactionOwner(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          if (current.owner.nonce !== owner.nonce || current.owner.pid !== owner.pid || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Refused to release a transaction lock whose token/inode identity changed");
          const releasedPath = `${path}.${owner.nonce}.released`;
          await rename(path, releasedPath);
          const released = await lstat(releasedPath);
          if (released.dev !== identity.dev || released.ino !== identity.ino) throw new Error("Released transaction lock inode changed during atomic detachment");
          await rm(releasedPath, { recursive: true });
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const observed = await readTransactionOwner(path);
      if (!processAlive(observed.owner.pid)) {
        try {
          await mkdir(join(path, TRANSACTION_RECLAIM_DIRECTORY), { mode: 0o700 });
          const claimed = await readTransactionOwner(path);
          const same = claimed.owner.nonce === observed.owner.nonce && claimed.owner.pid === observed.owner.pid && claimed.dev === observed.dev && claimed.ino === observed.ino;
          if (!same || processAlive(claimed.owner.pid)) {
            await rm(join(path, TRANSACTION_RECLAIM_DIRECTORY), { recursive: true, force: true });
            throw new Error("Stale transaction lock changed while reclamation was claimed");
          }
          const reclaimedPath = `${path}.${claimed.owner.nonce}.reclaimed`;
          await rename(path, reclaimedPath);
          const reclaimed = await lstat(reclaimedPath);
          if (reclaimed.dev !== observed.dev || reclaimed.ino !== observed.ino) throw new Error("Reclaimed transaction lock inode changed during atomic detachment");
          await rm(reclaimedPath, { recursive: true });
          continue;
        } catch (error) {
          if (["EEXIST", "ENOENT"].includes(String((error as NodeJS.ErrnoException).code))) continue;
          throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Malformed/unknown ownership is retained fail-closed rather than age-deleted.
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the cross-process writer lease transaction lock");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${LEASE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

function assertProofBound(proof: HerdrLeaseReconciliation, binding: WriterBinding, maximumAgeMs: number): void {
  if (proof.boundTerminalId !== binding.terminalId || JSON.stringify(proof.boundNativeSession) !== JSON.stringify(binding.nativeSession)) throw new Error("Herdr reconciliation proof is not bound to the requested terminal/native session");
  if (proof.protocol !== HERDR_PROTOCOL_VERSION || !semverAtLeast(proof.herdrVersion, MINIMUM_HERDR_VERSION)) throw new Error("Writer lease proof is not from a compatible Herdr");
  const age = Date.now() - proof.checkedAt;
  if (!Number.isSafeInteger(proof.checkedAt) || age < -1_000 || age > maximumAgeMs) throw new Error("Writer lease proof is stale or has an invalid timestamp");
}

export type WriterLeaseAcquisition =
  | { readonly acquired: true; readonly lease: WriterLease; readonly reclaimed?: WriterLease }
  | { readonly acquired: false; readonly reason: string; readonly retainedLease?: WriterLease };

export interface WriterLeaseStoreOptions {
  readonly transactionTimeoutMs?: number;
  readonly proofMaxAgeMs?: number;
}

export class WriterLeaseStore {
  readonly #transactionTimeoutMs: number;
  readonly #proofMaxAgeMs: number;
  constructor(options: WriterLeaseStoreOptions = {}) {
    this.#transactionTimeoutMs = options.transactionTimeoutMs ?? 5_000;
    this.#proofMaxAgeMs = options.proofMaxAgeMs ?? 5_000;
  }

  async paths(checkout: CheckoutIdentity): Promise<{ directory: string; lease: string; lock: string }> {
    const directory = await ensureLeaseDirectory(checkout);
    return { directory, lease: join(directory, LEASE_FILE), lock: join(directory, TRANSACTION_LOCK) };
  }

  async read(checkout: CheckoutIdentity): Promise<WriterLease | undefined> {
    const paths = await this.paths(checkout);
    try { return decodeLease(JSON.parse(await readFile(paths.lease, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async acquire(input: {
    readonly checkout: CheckoutIdentity;
    readonly binding: WriterBinding;
    readonly liveProof: HerdrLeaseReconciliation;
    readonly reconcileExisting: (lease: WriterLease) => Promise<HerdrLeaseReconciliation>;
    readonly now?: number;
  }): Promise<WriterLeaseAcquisition> {
    assertProofBound(input.liveProof, input.binding, this.#proofMaxAgeMs);
    if (input.liveProof.state !== "live" || input.liveProof.protocol !== HERDR_PROTOCOL_VERSION) throw new Error("A compatible live Herdr terminal/native-session proof is required before granting a writer lease");
    const paths = await this.paths(input.checkout);
    const unlock = await acquireTransactionLock(paths.lock, this.#transactionTimeoutMs);
    try {
      let existing: WriterLease | undefined;
      try { existing = decodeLease(JSON.parse(await readFile(paths.lease, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { acquired: false, reason: `Existing writer lease is unreadable or malformed and was retained: ${error instanceof Error ? error.message : String(error)}` };
      }
      const now = input.now ?? Date.now();
      if (existing) {
        if (!sameCheckout(existing.checkout, input.checkout)) return { acquired: false, reason: "Existing writer lease checkout identity does not match its canonical location", retainedLease: existing };
        if (sameBinding(existing, input.binding)) {
          const renewed = { ...existing, updatedAt: now, lastReconciled: input.liveProof };
          await atomicWriteJson(paths.lease, renewed);
          return { acquired: true, lease: renewed };
        }
        let proof: HerdrLeaseReconciliation;
        try { proof = await input.reconcileExisting(existing); assertProofBound(proof, existing, this.#proofMaxAgeMs); }
        catch (error) { return { acquired: false, reason: `Herdr could not prove the existing writer gone; lease retained: ${error instanceof Error ? error.message : String(error)}`, retainedLease: existing }; }
        if (proof.state !== "gone") {
          const retained = { ...existing, updatedAt: now, lastReconciled: proof };
          await atomicWriteJson(paths.lease, retained);
          return { acquired: false, reason: `Checkout already has a ${proof.state} writer binding: ${proof.reason}`, retainedLease: retained };
        }
        const lease: WriterLease = { schemaVersion: 1, checkout: input.checkout, ...input.binding, acquiredAt: now, updatedAt: now, lastReconciled: input.liveProof };
        await atomicWriteJson(paths.lease, lease);
        return { acquired: true, lease, reclaimed: existing };
      }
      const lease: WriterLease = { schemaVersion: 1, checkout: input.checkout, ...input.binding, acquiredAt: now, updatedAt: now, lastReconciled: input.liveProof };
      await atomicWriteJson(paths.lease, lease);
      return { acquired: true, lease };
    } finally { await unlock(); }
  }

  async release(input: {
    readonly checkout: CheckoutIdentity;
    readonly binding: WriterBinding;
    readonly reconcile: (lease: WriterLease) => Promise<HerdrLeaseReconciliation>;
  }): Promise<{ released: boolean; reason: string; retainedLease?: WriterLease }> {
    const paths = await this.paths(input.checkout);
    const unlock = await acquireTransactionLock(paths.lock, this.#transactionTimeoutMs);
    try {
      let existing: WriterLease;
      try { existing = decodeLease(JSON.parse(await readFile(paths.lease, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { released: true, reason: "No writer lease remained" };
        return { released: false, reason: `Writer lease is unreadable or malformed and was retained: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!sameCheckout(existing.checkout, input.checkout) || !sameBinding(existing, input.binding)) return { released: false, reason: "Writer lease holder/checkout identity did not match; retained", retainedLease: existing };
      let proof: HerdrLeaseReconciliation;
      try { proof = await input.reconcile(existing); assertProofBound(proof, existing, this.#proofMaxAgeMs); }
      catch (error) { return { released: false, reason: `Herdr could not prove the writer gone; lease retained: ${error instanceof Error ? error.message : String(error)}`, retainedLease: existing }; }
      if (proof.state !== "gone") {
        const retained = { ...existing, updatedAt: Date.now(), lastReconciled: proof };
        await atomicWriteJson(paths.lease, retained);
        return { released: false, reason: `Writer is ${proof.state}; lease retained: ${proof.reason}`, retainedLease: retained };
      }
      await unlink(paths.lease);
      return { released: true, reason: proof.reason };
    } finally { await unlock(); }
  }
}

export class WriterScheduler {
  constructor(readonly leases: WriterLeaseStore) {}
  authorizeReadOnly(_checkout: CheckoutIdentity): { readonly allowed: true; readonly isolation: "shared-checkout" } {
    return { allowed: true, isolation: "shared-checkout" };
  }
  async acquireWriter(input: Parameters<WriterLeaseStore["acquire"]>[0]): Promise<(WriterLeaseAcquisition & { readonly isolation: "exclusive-checkout" }) & { readonly requiresIsolatedWorktree?: true }> {
    const result = await this.leases.acquire(input);
    return result.acquired
      ? { ...result, isolation: "exclusive-checkout" }
      : { ...result, isolation: "exclusive-checkout", requiresIsolatedWorktree: true };
  }
}
