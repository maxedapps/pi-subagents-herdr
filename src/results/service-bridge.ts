import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GenerationSummary, PublicResultView, ResultEnvelopeV1 } from "./contracts.ts";
import { formatActionNotice, type RunAttention } from "./action-notices.ts";
import { toPublicResultView } from "./contracts.ts";
import { ResultCoordinator, type CoordinatorRunView } from "./coordinator.ts";
import { ResultDeliveryService, type DeliveryItem } from "./delivery.ts";
import { listResultEnvelopes } from "./store.ts";

/** Minimal run shape the tool service exposes to result services. */
export interface ResultManagedRun {
  readonly id: string;
  readonly runNonce: string;
  readonly profile: { readonly name: string };
  readonly policy: { readonly harness: CoordinatorRunView["harness"] };
  readonly lifecycle: string;
  herdrStatus: CoordinatorRunView["herdrStatus"];
  nextGeneration: number;
  activeGeneration?: GenerationSummary;
  latestResult?: PublicResultView;
  readonly ephemeral?: {
    readonly directory: string;
    readonly resultExchangeDirectory?: string;
  };
  readonly journal: {
    readonly parent: { readonly sessionId: string; readonly sessionPath?: string };
    readonly resources: {
      readonly terminalId?: string;
      readonly nativeSession?: DeliveryItem["nativeSession"];
    };
  };
  readonly target?: {
    readonly terminalId?: string;
    readonly nativeSession?: DeliveryItem["nativeSession"];
  };
  readonly artifacts?: {
    readonly metadataRoots?: Parameters<typeof listResultEnvelopes>[2];
  };
  readonly attention?: RunAttention;
}

export interface ResultServiceHost {
  readonly pi: ExtensionAPI;
  readonly runtimeEpoch: string;
  getContext(): ExtensionContext | undefined;
  getCheckout(): string | undefined;
  listManagedRuns(): Iterable<ResultManagedRun>;
  getManagedRun(runId: string): ResultManagedRun | undefined;
  persistRunMetadata(runId: string): Promise<void>;
  refreshAttention?(runId: string): Promise<void>;
  onResultStageAdvanced?(envelope: ResultEnvelopeV1): void;
  notifyUi(): void;
}

function sessionParent(host: ResultServiceHost, run: ResultManagedRun): { sessionId: string; sessionPath?: string } {
  const context = host.getContext();
  if (context) {
    const sessionId = context.sessionManager.getSessionId();
    const sessionPath = context.sessionManager.getSessionFile();
    return { sessionId, ...(sessionPath === undefined ? {} : { sessionPath }) };
  }
  return {
    sessionId: run.journal.parent.sessionId,
    ...(run.journal.parent.sessionPath === undefined ? {} : { sessionPath: run.journal.parent.sessionPath }),
  };
}

export function toCoordinatorView(host: ResultServiceHost, run: ResultManagedRun): CoordinatorRunView {
  const parent = sessionParent(host, run);
  const view: CoordinatorRunView = {
    id: run.id,
    runNonce: run.runNonce,
    harness: run.policy.harness,
    profileName: run.profile.name,
    lifecycle: run.lifecycle,
    herdrStatus: run.herdrStatus,
    parentSessionId: parent.sessionId,
    ...(parent.sessionPath === undefined ? {} : { parentSessionPath: parent.sessionPath }),
    nextGeneration: run.nextGeneration,
    ...(run.activeGeneration === undefined ? {} : { activeGeneration: run.activeGeneration }),
    ...(run.ephemeral === undefined ? {} : {
      ephemeral: {
        directory: run.ephemeral.directory,
        ...(run.ephemeral.resultExchangeDirectory === undefined ? {} : { resultExchangeDirectory: run.ephemeral.resultExchangeDirectory }),
      },
    }),
  };
  Object.defineProperty(view, "activeGeneration", {
    get: () => run.activeGeneration,
    set: (value: GenerationSummary | undefined) => {
      if (value === undefined) delete run.activeGeneration;
      else run.activeGeneration = value;
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(view, "nextGeneration", {
    get: () => run.nextGeneration,
    set: (value: number) => { run.nextGeneration = value; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(view, "herdrStatus", {
    get: () => run.herdrStatus,
    enumerable: true,
    configurable: true,
  });
  return view;
}

export function installResultServices(host: ResultServiceHost): {
  readonly coordinator: ResultCoordinator;
  readonly delivery: ResultDeliveryService;
} {
  const coordinator = new ResultCoordinator({
    getCheckout: () => host.getCheckout(),
    listRuns: () => [...host.listManagedRuns()].map((run) => toCoordinatorView(host, run)),
    getRun: (runId) => {
      const run = host.getManagedRun(runId);
      return run ? toCoordinatorView(host, run) : undefined;
    },
    persistRunMetadata: (runId) => host.persistRunMetadata(runId),
    onResultCaptured: (envelope) => {
      const run = host.getManagedRun(envelope.runId);
      if (run) {
        run.latestResult = toPublicResultView(envelope);
        if (run.activeGeneration?.generation === envelope.generation) {
          run.activeGeneration = {
            ...run.activeGeneration,
            phase: "captured",
            resultId: envelope.resultId,
            source: envelope.source,
          };
        }
      }
      host.onResultStageAdvanced?.(envelope);
      delivery.scheduleFlush();
      host.notifyUi();
    },
  });

  const delivery = new ResultDeliveryService({
    pi: host.pi,
    getContext: () => host.getContext(),
    getCheckout: () => host.getCheckout(),
    runtimeEpoch: host.runtimeEpoch,
    listQueued: async () => {
      const checkout = host.getCheckout();
      if (!checkout) return [];
      const items: DeliveryItem[] = [];
      for (const run of host.listManagedRuns()) {
        await host.refreshAttention?.(run.id);
        const terminalId = run.target?.terminalId ?? run.journal.resources.terminalId;
        const nativeSession = run.target?.nativeSession ?? run.journal.resources.nativeSession;
        const envelopes = await listResultEnvelopes(checkout, run.id, run.artifacts?.metadataRoots);
        for (const envelope of envelopes) {
          if (
            envelope.delivery.stage === "captured"
            || envelope.delivery.stage === "dispatched"
            || envelope.delivery.stage === "parent_persisted"
          ) {
            items.push({
              envelope,
              profileName: run.profile.name,
              ...(terminalId === undefined ? {} : { terminalId }),
              ...(nativeSession === undefined ? {} : { nativeSession }),
              ...(run.attention === undefined ? {} : { actionText: formatActionNotice(run.id, run.attention) }),
            });
          }
        }
      }
      return items;
    },
    onStageAdvanced: (envelope: ResultEnvelopeV1) => {
      const run = host.getManagedRun(envelope.runId);
      if (run) run.latestResult = toPublicResultView(envelope);
      host.onResultStageAdvanced?.(envelope);
      host.notifyUi();
    },
  });

  return { coordinator, delivery };
}
