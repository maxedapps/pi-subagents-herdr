import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionToolResult, ListToolResult } from "../tools/contracts.ts";
import type { InterruptToolInput, ListToolInput, SendToolInput, StopToolInput } from "../tools/schemas.ts";
import type { DashboardScope } from "./status.ts";
import type { UiRunDetails } from "./details.ts";

export interface UiFocusResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly attentionChanged?: boolean;
}

export interface UiRuntimeApi {
  list(input: ListToolInput): Promise<ListToolResult>;
  listUi?(input: ListToolInput): Promise<ListToolResult>;
  inspectUi(scope: DashboardScope, id: string): Promise<UiRunDetails>;
  send(input: SendToolInput, signal?: AbortSignal): Promise<ActionToolResult>;
  interrupt(input: InterruptToolInput, signal?: AbortSignal): Promise<ActionToolResult>;
  stop(input: StopToolInput, signal?: AbortSignal): Promise<ActionToolResult>;
  focusUi(id: string, signal?: AbortSignal): Promise<UiFocusResult>;
}

function resultMessage(action: string, result: ActionToolResult): { message: string; type: "info" | "warning" | "error" } {
  if (!result.ok) return { message: `${action} unavailable: ${result.reason}`, type: result.status === "blocked" ? "warning" : "error" };
  return { message: `${action} completed for ${result.run.profile} (${result.run.id})`, type: "info" };
}

export class OverlayActions {
  constructor(private readonly runtime: UiRuntimeApi, private readonly ctx: ExtensionCommandContext) {}

  async send(id: string): Promise<void> {
    const message = await this.ctx.ui.input("Send to owned subagent", "Follow-up message");
    if (!message?.trim()) return;
    const result = await this.runtime.send({ id, message: message.trim() }, this.ctx.signal);
    const notice = resultMessage("Send", result);
    this.ctx.ui.notify(notice.message, notice.type);
  }

  async interrupt(id: string): Promise<void> {
    const result = await this.runtime.interrupt({ id }, this.ctx.signal);
    const notice = resultMessage("Interrupt", result);
    this.ctx.ui.notify(notice.message, notice.type);
  }

  async stop(id: string, force: boolean): Promise<void> {
    const confirmed = await this.ctx.ui.confirm(
      force ? "Force-stop owned subagent?" : "Stop owned subagent?",
      force
        ? "This revalidates active-branch ownership and terminal/native identity immediately before pane close. Artifacts and worktrees are retained."
        : "Graceful stop preserves artifacts and retains any writer worktree.",
    );
    if (!confirmed) return;
    const result = await this.runtime.stop({ id, mode: force ? "force" : "graceful", cleanup: "retain" }, this.ctx.signal);
    const notice = resultMessage(force ? "Force stop" : "Stop", result);
    this.ctx.ui.notify(notice.message, notice.type);
  }

  async cleanup(id: string): Promise<void> {
    const confirmed = await this.ctx.ui.confirm(
      "Stop and request safe cleanup?",
      "Cleanup is attempted only after fresh active-branch identity validation. Dirty, unreviewed, unintegrated, live, or uncertain work is retained.",
    );
    if (!confirmed) return;
    const parentReview = await this.ctx.ui.input("Parent review evidence", "What did you inspect and verify?");
    if (!parentReview?.trim()) {
      this.ctx.ui.notify("Safe cleanup cancelled: parent review evidence is required.", "warning");
      return;
    }
    const choice = await this.ctx.ui.select("Objective integration evidence", [
      "No child changes",
      "Parent commit contains child changes",
      "Parent and child trees match",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return;
    let integration: StopToolInput["integration"];
    if (choice === "No child changes") integration = { kind: "no_changes" };
    else {
      const parentCheckoutPath = await this.ctx.ui.input("Parent checkout path", this.ctx.cwd);
      if (!parentCheckoutPath?.trim()) return;
      if (choice.startsWith("Parent commit")) {
        const parentRef = await this.ctx.ui.input("Parent Git ref", "HEAD");
        integration = { kind: "commit_contained", parentCheckoutPath: parentCheckoutPath.trim(), ...(parentRef?.trim() ? { parentRef: parentRef.trim() } : {}) };
      } else {
        const parentRef = await this.ctx.ui.input("Parent Git ref", "HEAD");
        integration = { kind: "tree_matches", parentCheckoutPath: parentCheckoutPath.trim(), ...(parentRef?.trim() ? { parentRef: parentRef.trim() } : {}) };
      }
    }
    const result = await this.runtime.stop({ id, mode: "graceful", cleanup: "remove_if_safe", parentReview: parentReview.trim(), integration }, this.ctx.signal);
    const notice = resultMessage("Safe cleanup", result);
    this.ctx.ui.notify(notice.message, notice.type);
  }

  async focusAfterOverlayClosed(id: string): Promise<void> {
    const result = await this.runtime.focusUi(id, this.ctx.signal);
    if (!result.ok) {
      this.ctx.ui.notify(result.reason ?? `Could not focus ${id}.`, "error");
      return;
    }
    this.ctx.ui.notify(result.attentionChanged
      ? "Focused terminal. The backend changed unseen done attention to idle; no new task was started."
      : "Focused owned subagent terminal.", "info");
  }
}
