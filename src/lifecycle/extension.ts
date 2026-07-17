import { keyText, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { PACKAGE_ASSETS } from "../package-paths.ts";
import { RESULT_CUSTOM_TYPE } from "../results/contracts.ts";
import { ACTION_NOTICE_CUSTOM_TYPE } from "../results/action-notices.ts";
import { actionCollapsedPreview, resultCollapsedPreview } from "../results/presentation.ts";
import { registerChildResultBridge } from "../results/child-bridge.ts";
import { registerHerdrToolSurface } from "../tools/index.ts";
import { registerHerdrSubagentsUi } from "../ui/index.ts";

export interface SessionRuntime {
  start(context: ExtensionContext): void | Promise<void>;
  stop(): void | Promise<void>;
  noteParentSettled?(): void;
  reconcileResultPersistence?(): void | Promise<void>;
}

export interface ExtensionRegistrationOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test/integration seam. Supplying it bypasses the production tool runtime. */
  readonly createRuntime?: () => SessionRuntime;
}

export interface ExtensionRegistration {
  readonly mode: "parent" | "child";
  readonly registeredEvents: readonly string[];
  readonly registeredTools: readonly string[];
}

function messageContentText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
      .map((block) => String((block as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

export function registerHerdrSubagentsExtension(
  pi: ExtensionAPI,
  options: ExtensionRegistrationOptions = {},
): ExtensionRegistration {
  const environment = options.environment ?? process.env;
  if (environment.PI_HERDR_SUBAGENT === "1") {
    // Code-enforced child boundary: register only the narrow result bridge.
    // No parent tools, commands, UI, lifecycle runtime, skill injection, or
    // prompt metadata. Herdr's separately installed Pi integration remains loaded.
    const bridge = registerChildResultBridge(pi, environment);
    return {
      mode: "child",
      registeredEvents: bridge?.registeredEvents ?? [],
      registeredTools: [],
    };
  }

  pi.on("resources_discover", () => ({ skillPaths: [PACKAGE_ASSETS.skill] }));

  const surface = options.createRuntime === undefined
    ? registerHerdrToolSurface(pi, { environment })
    : undefined;
  const ui = surface === undefined ? undefined : registerHerdrSubagentsUi(pi, surface.runtime);
  const createRuntime = options.createRuntime ?? (() => {
    const core = surface!.runtime.createSessionRuntime();
    return {
      async start(context: ExtensionContext) { await core.start(context); await ui!.start(context); },
      async stop() { await ui!.stop(); await core.stop(); },
      noteParentSettled() { core.noteParentSettled?.(); },
      async reconcileResultPersistence() { await core.reconcileResultPersistence?.(); },
    };
  });
  let runtime: SessionRuntime | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  pi.on("session_start", async (_event, context) => {
    if (runtime !== undefined) return;
    if (startPromise !== undefined) return startPromise;

    const pending = (async () => {
      let next: SessionRuntime | undefined;
      try {
        next = createRuntime();
        await next.start(context);
        runtime = next;
      } catch (error) {
        if (next !== undefined) await Promise.resolve(next.stop()).catch(() => undefined);
        throw error;
      }
    })();
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = undefined;
    }
  });

  pi.on("agent_settled", () => {
    // Automatic result delivery replaces the old status-call reminder loop.
    runtime?.noteParentSettled?.();
  });

  pi.on("message_end", async (event) => {
    // Pi invokes extension message_end before the custom message is appended to the
    // session branch. Always schedule a deferred persistence scan so in-flight
    // herdr-subagents.result.v1 deliveries can advance once the branch is durable.
    // Filtering only RESULT_CUSTOM_TYPE would miss the pre-append window.
    void event;
    setTimeout(() => {
      void Promise.resolve(runtime?.reconcileResultPersistence?.()).catch(() => undefined);
    }, 0).unref?.();
  });

  if (typeof pi.registerMessageRenderer === "function") {
    const expandedOr = (
      message: unknown,
      expanded: boolean,
      theme: Theme,
      preview: (text: string) => string,
    ) => {
      const text = messageContentText(message as { content?: unknown });
      return new Text(expanded ? text : theme.fg("muted", preview(text)), 0, 0);
    };
    const expansionHint = () => keyText("app.tools.expand") || "Ctrl+O";
    pi.registerMessageRenderer(RESULT_CUSTOM_TYPE, (message, options, theme) =>
      expandedOr(message, options.expanded, theme, (text) => resultCollapsedPreview(text, expansionHint())));
    pi.registerMessageRenderer(ACTION_NOTICE_CUSTOM_TYPE, (message, options, theme) =>
      expandedOr(message, options.expanded, theme, (text) => actionCollapsedPreview(text, expansionHint())));
  }

  pi.on("session_shutdown", async () => {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = (async () => {
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      const active = runtime;
      runtime = undefined;
      if (active !== undefined) await active.stop();
    })();
    try {
      await stopPromise;
    } finally {
      stopPromise = undefined;
    }
  });

  return {
    mode: "parent",
    registeredEvents: [
      "resources_discover",
      "session_start",
      "agent_settled",
      "message_end",
      "session_shutdown",
    ],
    registeredTools: surface?.names ?? [],
  };
}
