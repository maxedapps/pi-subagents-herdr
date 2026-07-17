import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionToolResult, ListToolResult } from "../tools/contracts.ts";
import type { ListToolInput, StopToolInput } from "../tools/schemas.ts";

export interface UiFocusResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly attentionChanged?: boolean;
}

export interface UiRuntimeApi {
  list(input: ListToolInput): Promise<ListToolResult>;
  stop(input: StopToolInput, signal?: AbortSignal): Promise<ActionToolResult>;
  focusUi(id: string, signal?: AbortSignal): Promise<UiFocusResult>;
}

export class OverlayActions {
  constructor(private readonly runtime: UiRuntimeApi, private readonly ctx: ExtensionCommandContext) {}

  async stopAfterOverlayClosed(id: string): Promise<void> {
    const confirmed = await this.ctx.ui.confirm(
      "Stop owned subagent?",
      "The child process/session will end. A writer worktree will be removed automatically only when clean no-change/integration and identity checks pass; otherwise it remains with an action-required notice.",
    );
    if (!confirmed) return;
    const result = await this.runtime.stop({ id, mode: "graceful" }, this.ctx.signal);
    if (!result.ok) {
      this.ctx.ui.notify(`Stop unavailable: ${result.reason}`, result.status === "blocked" ? "warning" : "error");
      return;
    }
    const stopped = result.result as { readonly stopped?: boolean; readonly reason?: string };
    if (stopped.stopped !== true) {
      this.ctx.ui.notify(stopped.reason ?? `Subagent ${id} was not stopped; artifacts and worktree remain.`, "warning");
      return;
    }
    const cleanup = result.cleanup as { readonly removed?: boolean; readonly reason?: string } | undefined;
    this.ctx.ui.notify(cleanup?.removed
      ? `Stopped ${result.run.profile} (${result.run.id}); writer resources finalized.`
      : `Stopped ${result.run.profile} (${result.run.id}).${cleanup?.reason ? ` Cleanup requires attention: ${cleanup.reason}` : ""}`, cleanup && !cleanup.removed ? "warning" : "info");
  }

  async focusAfterOverlayClosed(id: string): Promise<void> {
    const result = await this.runtime.focusUi(id, this.ctx.signal);
    if (!result.ok) {
      this.ctx.ui.notify(result.reason ?? `Could not focus ${id}.`, result.reason?.includes("uncertain") ? "warning" : "error");
      return;
    }
    this.ctx.ui.notify(result.attentionChanged
      ? "Focused terminal. The backend changed unseen done attention to idle; no new task was started."
      : "Focused owned subagent terminal.", "info");
  }
}
