import { writeFile } from "node:fs/promises";
import type { WriterBinding } from "../../src/worktrees/contracts.ts";
import { identifyCheckout, WriterLeaseStore } from "../../src/worktrees/writer-locks.ts";

const [checkoutPath, runId, terminalId, mode = "normal", marker] = process.argv.slice(2);
if (!checkoutPath || !runId || !terminalId) throw new Error("usage: writer-lease-child <checkout> <run> <terminal> [normal|crash] [marker]");
const checkout = await identifyCheckout(checkoutPath);
const binding = {
  runId,
  runNonce: `nonce-${runId}`,
  terminalId,
  nativeSession: { kind: "id" as const, value: `native-${runId}`, source: "herdr:pi" },
  parent: { sessionId: `parent-${runId}`, branchEntryId: `branch-${runId}` },
};
const proof = (value: WriterBinding, reason: string) => ({ state: "live" as const, checkedAt: Date.now(), herdrVersion: "0.7.3", protocol: 16 as const, reason, boundTerminalId: value.terminalId, boundNativeSession: value.nativeSession });
const result = await new WriterLeaseStore().acquire({ checkout, binding, liveProof: proof(binding, "fixture live"), reconcileExisting: async (lease) => proof(lease, "existing fixture live") });
if (marker) await writeFile(marker, JSON.stringify(result), "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
if (mode === "crash" && result.acquired) process.kill(process.pid, "SIGKILL");
