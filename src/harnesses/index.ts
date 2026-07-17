import type { Harness } from "../contracts/harness.ts";
import type { HarnessAdapter, HarnessLaunch, LaunchContext } from "./base.ts";
import { resolveExecutable } from "./base.ts";
import { ClaudeHarnessAdapter } from "./claude.ts";
import { CodexHarnessAdapter } from "./codex.ts";
import { PiHarnessAdapter } from "./pi.ts";
import { GrokHarnessAdapter } from "./grok.ts";

const PREPARED = Symbol("prepared-herdr-harness-launch");

export interface PreparedHarnessLaunch {
  readonly [PREPARED]: true;
  readonly adapter: HarnessAdapter;
  readonly launch: HarnessLaunch;
  readonly context: LaunchContext;
}

export function harnessAdapter(harness: Harness): HarnessAdapter {
  switch (harness) {
    case "pi": return new PiHarnessAdapter();
    case "claude": return new ClaudeHarnessAdapter();
    case "codex": return new CodexHarnessAdapter();
    case "grok": return new GrokHarnessAdapter();
  }
}

/**
 * Mandatory pre-resource gate. Call this before creating a group tab/worktree.
 * It resolves and validates exactly the selected harness; no fallback is attempted.
 */
export async function prepareHarnessLaunch(context: LaunchContext): Promise<PreparedHarnessLaunch> {
  const adapter = harnessAdapter(context.policy.harness);
  const executable = await resolveExecutable(adapter.capabilities.executable, context.executable);
  const checked = { ...context, executable };
  await adapter.check(checked);
  const launch = await adapter.buildLaunch(checked);
  return Object.freeze({ [PREPARED]: true as const, adapter, launch, context });
}

export function assertPreparedHarnessLaunch(value: PreparedHarnessLaunch): void {
  if (value[PREPARED] !== true) throw new Error("Harness launch was not prepared before resource creation");
}

export * from "./base.ts";
export * from "./capabilities.ts";
export * from "./pi.ts";
export * from "./claude.ts";
export * from "./codex.ts";
export * from "./grok.ts";
