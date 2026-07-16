import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHerdrToolSurface } from "../tools/index.ts";
import { registerHerdrSubagentsUi } from "../ui/index.ts";

export interface SessionRuntime {
  start(context: ExtensionContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface ExtensionRegistrationOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test/integration seam. Supplying it bypasses the production tool runtime. */
  readonly createRuntime?: () => SessionRuntime;
}

export interface ExtensionRegistration {
  readonly mode: "parent" | "child";
  readonly registeredEvents: readonly ("session_start" | "session_shutdown")[];
  readonly registeredTools: readonly string[];
}

export function registerHerdrSubagentsExtension(
  pi: ExtensionAPI,
  options: ExtensionRegistrationOptions = {},
): ExtensionRegistration {
  const environment = options.environment ?? process.env;
  if (environment.PI_HERDR_SUBAGENT === "1") {
    // Code-enforced child boundary: this package registers no parent tools,
    // commands, UI, lifecycle runtime, skill injection, or prompt
    // metadata. Herdr's separately installed Pi integration remains loaded.
    return { mode: "child", registeredEvents: [], registeredTools: [] };
  }

  const surface = options.createRuntime === undefined
    ? registerHerdrToolSurface(pi, { environment })
    : undefined;
  const ui = surface === undefined ? undefined : registerHerdrSubagentsUi(pi, surface.runtime);
  const createRuntime = options.createRuntime ?? (() => {
    const core = surface!.runtime.createSessionRuntime();
    return {
      async start(context: ExtensionContext) { await core.start(context); await ui!.start(context); },
      async stop() { await ui!.stop(); await core.stop(); },
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
    registeredEvents: ["session_start", "session_shutdown"],
    registeredTools: surface?.names ?? [],
  };
}
