import {
  type CodexAppServerIsolation,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  codexAppServerIsolationAvailable,
  codexSocketTransportMode,
} from "../provider/CodexDetachedAppServerLive.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/**
 * Decides which provider session a new provider thread lands on. A new Codex thread whose shared
 * process started before its model was added to Codex's catalog, or before its catalog entry
 * changed, opens its own process instead, so the shared one keeps its running work.
 */
export const makeProviderSessionPlacement = Effect.fn("ProviderSessionPlacement.make")(function* <
  E,
>(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly settings: Effect.Effect<{ readonly codexAppServerIsolation: CodexAppServerIsolation }>;
  readonly sessions?: {
    readonly get: (
      providerSessionId: ProviderSessionId,
    ) => Effect.Effect<
      Option.Option<Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "modelStatus">>,
      E
    >;
  };
}) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const isolationAvailable = codexAppServerIsolationAvailable(
    codexSocketTransportMode(platform, environment),
  );
  // Dispatch and the run-update reactor wait on placement, so it reads only what the runtime knows.
  const sharedPredates = Effect.fnUntraced(function* (shared: ProviderSessionId, model?: string) {
    if (model === undefined || input.sessions === undefined) return false;
    const live = yield* input.sessions.get(shared).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(live) || live.value.modelStatus === undefined) return false;
    const status = yield* live.value.modelStatus(model, { cachedOnly: true });
    return status === "predated" || status === "outdated";
  });
  const providerSessionIdFor = Effect.fn("ProviderSessionPlacement.providerSessionIdFor")(
    function* (placement: {
      readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly model?: string;
    }) {
      const capabilities = yield* placement.adapter.getCapabilities();
      if (!capabilities.sessions.supportsMultipleProviderThreadsPerSession) {
        return yield* input.idAllocator.allocate.providerSession({
          providerInstanceId: placement.providerInstanceId,
          threadId: placement.threadId,
        });
      }
      const isolable = placement.adapter.driver === CODEX_DRIVER && isolationAvailable;
      const shared = input.idAllocator.derive.providerSession({
        providerInstanceId: placement.providerInstanceId,
      });
      const perThread =
        isolable &&
        ((yield* input.settings).codexAppServerIsolation === "thread" ||
          (yield* sharedPredates(shared, placement.model)));
      return perThread
        ? input.idAllocator.derive.providerSession({
            providerInstanceId: placement.providerInstanceId,
            threadId: placement.threadId,
          })
        : shared;
    },
  );
  return { providerSessionIdFor };
});

/**
 * The stored session a provider thread keeps through a transition, or null when a new one
 * is placed. A shared-session thread keeps its session across same-instance restarts, so a
 * native thread and its subagents never load in two processes.
 */
export const keptProviderSessionId = (input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerInstanceId: ProviderInstanceId;
  readonly canResumeAcrossInstances: boolean;
  readonly releaseProviderSessionIds: ReadonlyArray<ProviderSessionId> | undefined;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}): ProviderSessionId | null => {
  const stored = input.providerThread.providerSessionId;
  if (stored === null || input.canResumeAcrossInstances) return null;
  if (input.providerThread.providerInstanceId !== input.providerInstanceId) return null;
  if (input.capabilities.sessions.supportsMultipleProviderThreadsPerSession) return stored;
  return input.releaseProviderSessionIds?.includes(stored) === true ? null : stored;
};
