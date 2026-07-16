import type { SessionSnapshot } from "./protocol.ts";
import type { HerdrLiveCache } from "./subscriptions.ts";
import type { SubagentRegistry } from "../runtime/registry.ts";

/** Apply one authoritative snapshot to cache and owned registry without guessing absent fields. */
export function reconcileSnapshot(cache: HerdrLiveCache, registry: SubagentRegistry, snapshot: SessionSnapshot, now = Date.now()): void {
  cache.replace(snapshot, now);
  registry.applySnapshot(snapshot, now);
}
