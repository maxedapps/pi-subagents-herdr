import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDoctorReport } from "../doctor/report.ts";
import type { HerdrSubagentsSettings } from "../config/settings.ts";
import type { HerdrToolRuntimeController } from "../tools/service.ts";
import { OverlayActions, type UiRuntimeApi } from "./actions.ts";
import { SubagentsOverlay, type OverlayAction } from "./overlay.ts";
import { adaptiveRefreshDelay, DashboardProjector, type DashboardState } from "./status.ts";
import { statusSummaryLabel } from "./status.ts";
import { SubagentsWidget } from "./widget.ts";

const UI_KEY = "herdr-subagents";

interface UiRuntime extends UiRuntimeApi {
  subscribeUi(listener: () => void): () => void;
  widgetVisibility(): HerdrSubagentsSettings["widget"]["visibility"];
  doctor?: () => ReturnType<HerdrToolRuntimeController["doctor"]>;
}

type OverlayResult =
  | { readonly type: "close" }
  | { readonly type: "focus"; readonly id: string }
  | { readonly type: "stop"; readonly id: string };

export class HerdrSubagentsUiSession {
  readonly #mainProjector = new DashboardProjector();
  #context: ExtensionContext | undefined;
  #state: DashboardState = this.#mainProjector.project({ ok: true, scope: "current_session", runs: [], counts: {} });
  #unsubscribe: (() => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #widgetRequestRender: (() => void) | undefined;
  #widgetInstalled = false;
  #overlayDone: (() => void) | undefined;
  #overlayRefresh: (() => void) | undefined;
  #overlayOpen = false;
  #generation = 0;
  #refreshing: Promise<void> | undefined;
  #refreshQueued = false;

  constructor(private readonly runtime: UiRuntime) {}

  async start(context: ExtensionContext): Promise<void> {
    await this.stop();
    this.#context = context;
    this.#generation += 1;
    if (context.mode !== "tui") return;
    this.#unsubscribe = this.runtime.subscribeUi(() => this.requestRefresh());
    await this.#refreshMain(this.#generation);
  }

  async stop(): Promise<void> {
    this.#generation += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#clearTimer();
    this.#overlayDone?.();
    this.#overlayDone = undefined;
    this.#overlayRefresh = undefined;
    this.#overlayOpen = false;
    const context = this.#context;
    this.#context = undefined;
    if (context) {
      context.ui.setStatus(UI_KEY, undefined);
      context.ui.setWidget(UI_KEY, undefined);
    }
    this.#widgetInstalled = false;
    this.#widgetRequestRender = undefined;
    await this.#refreshing?.catch(() => undefined);
  }

  requestRefresh(): void {
    if (!this.#context || this.#context.mode !== "tui") return;
    this.#overlayRefresh?.();
    if (this.#refreshing) { this.#refreshQueued = true; return; }
    void this.#refreshMain(this.#generation);
  }

  async command(args: string, context: ExtensionCommandContext): Promise<void> {
    if (context.mode !== "tui") {
      context.ui.notify("/subagents is available only in Pi's interactive terminal TUI; lifecycle tools remain available in this mode.", "warning");
      return;
    }
    if (args.trim().length > 0) {
      context.ui.notify("Usage: /subagents (current-session owned runs only)", "warning");
      return;
    }
    const actions = new OverlayActions(this.runtime, context);
    const overlayProjector = new DashboardProjector();
    let overlay: SubagentsOverlay | undefined;
    const initial = await this.#loadCurrent(overlayProjector);
    this.#overlayOpen = true;
    this.#scheduleTimer();
    const result = await context.ui.custom<OverlayResult>((tui, theme, _keybindings, done) => {
      const close = (value: OverlayResult) => {
        if (this.#overlayDone) this.#overlayDone = undefined;
        done(value);
      };
      this.#overlayDone = () => close({ type: "close" });
      let refreshing = false;
      let queued = false;
      const refresh = async () => {
        if (refreshing) { queued = true; return; }
        refreshing = true;
        try { overlay?.setState(await this.#loadCurrent(overlayProjector)); }
        catch (error) { overlay?.setMessage(error instanceof Error ? error.message : String(error)); }
        finally {
          refreshing = false;
          if (queued) { queued = false; void refresh(); }
        }
      };
      const onAction = (action: OverlayAction) => {
        if (action.type === "close") close({ type: "close" });
        else if (action.type === "focus") close({ type: "focus", id: action.id });
        else if (action.type === "stop") close({ type: "stop", id: action.id });
        else void refresh();
      };
      overlay = new SubagentsOverlay(initial, theme, onAction, () => tui.requestRender());
      this.#overlayRefresh = () => { void refresh(); };
      return overlay;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "88%", minWidth: 24, maxHeight: "85%", margin: 1 },
    });
    this.#overlayDone = undefined;
    this.#overlayRefresh = undefined;
    this.#overlayOpen = false;
    this.#scheduleTimer();
    if (result.type === "focus") await actions.focusAfterOverlayClosed(result.id);
    else if (result.type === "stop") await actions.stopAfterOverlayClosed(result.id);
    this.requestRefresh();
  }

  async #loadCurrent(projector = this.#mainProjector): Promise<DashboardState> {
    return projector.project(await this.runtime.list({ scope: "current_session" }));
  }

  async #refreshMain(generation: number): Promise<void> {
    if (!this.#context || generation !== this.#generation || this.#refreshing) return;
    const operation = (async () => {
      try {
        const state = await this.#loadCurrent();
        if (!this.#context || generation !== this.#generation) return;
        this.#state = state;
        this.#renderPersistentUi(this.#context);
      } catch (error) {
        if (this.#context && generation === this.#generation) {
          this.#state = this.#mainProjector.project({ ok: false, status: "unavailable", reason: error instanceof Error ? error.message : String(error) });
          this.#renderPersistentUi(this.#context);
        }
      } finally {
        this.#refreshing = undefined;
        if (this.#refreshQueued) { this.#refreshQueued = false; this.requestRefresh(); }
        else this.#scheduleTimer();
      }
    })();
    this.#refreshing = operation;
    await operation;
  }

  #renderPersistentUi(context: ExtensionContext): void {
    if (this.#state.runs.length === 0) {
      context.ui.setStatus(UI_KEY, undefined);
      context.ui.setWidget(UI_KEY, undefined);
      this.#widgetInstalled = false;
      this.#widgetRequestRender = undefined;
      return;
    }
    const raw = `◆ ${this.#state.summary.total} subagent${this.#state.summary.total === 1 ? "" : "s"} · ${statusSummaryLabel(this.#state.summary)}`;
    const color = this.#state.summary.failures ? "error" : this.#state.summary.blocked ? "warning" : "accent";
    context.ui.setStatus(UI_KEY, context.ui.theme.fg(color, raw));
    if (this.runtime.widgetVisibility() === "never") {
      context.ui.setWidget(UI_KEY, undefined);
      this.#widgetInstalled = false;
      return;
    }
    if (!this.#widgetInstalled) {
      context.ui.setWidget(UI_KEY, (tui, theme) => {
        this.#widgetRequestRender = () => tui.requestRender();
        return new SubagentsWidget(() => this.#state, theme);
      }, { placement: "aboveEditor" });
      this.#widgetInstalled = true;
    } else this.#widgetRequestRender?.();
  }

  #scheduleTimer(): void {
    this.#clearTimer();
    if (!this.#context) return;
    const delay = adaptiveRefreshDelay(this.#state, this.#overlayOpen);
    if (delay === undefined) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.requestRefresh(); }, delay);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export function registerHerdrSubagentsUi(pi: ExtensionAPI, runtime: HerdrToolRuntimeController): HerdrSubagentsUiSession {
  const session = new HerdrSubagentsUiSession(runtime);
  pi.registerCommand("subagents", {
    description: "Focus or gracefully stop a current-session owned subagent",
    handler: (args, context) => session.command(args, context),
  });
  pi.registerCommand("subagents-doctor", {
    description: "Run a read-only package, Herdr, profile, artifact, Git, integration, and recovery diagnostic",
    handler: async (_args, context) => {
      if (!runtime.doctor) throw new Error("Doctor runtime is unavailable");
      const report = await runtime.doctor();
      const formatted = formatDoctorReport(report);
      if (context.mode !== "tui") {
        context.ui.notify(formatted, report.summary.fail ? "error" : report.summary.warning ? "warning" : "info");
        return;
      }
      await context.ui.custom<void>((tui, theme, _keybindings, done) => {
        const body = new Text(formatted, 1, 0);
        return {
          render(width: number) { return [...body.render(width), truncateToWidth(theme.fg("dim", "enter/esc close · read-only · no adoption or cleanup"), width)]; },
          invalidate() { body.invalidate(); },
          handleInput(data: string) { if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done(); tui.requestRender(); },
        };
      });
    },
  });
  return session;
}

export * from "./actions.ts";
export * from "./overlay.ts";
export * from "./status.ts";
export * from "./theme.ts";
export * from "./widget.ts";
