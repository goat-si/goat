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
import * as Effect from "effect/Effect";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/** Decides which provider session a new provider thread lands on. */
export const makeProviderSessionPlacement = (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly settings: Effect.Effect<{ readonly codexAppServerIsolation: CodexAppServerIsolation }>;
}) => {
  const providerSessionIdFor = Effect.fn("ProviderSessionPlacement.providerSessionIdFor")(
    function* (placement: {
      readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
    }) {
      const capabilities = yield* placement.adapter.getCapabilities();
      if (!capabilities.sessions.supportsMultipleProviderThreadsPerSession) {
        return yield* input.idAllocator.allocate.providerSession({
          providerInstanceId: placement.providerInstanceId,
          threadId: placement.threadId,
        });
      }
      const perThread =
        placement.adapter.driver === CODEX_DRIVER &&
        (yield* input.settings).codexAppServerIsolation === "thread";
      return input.idAllocator.derive.providerSession({
        providerInstanceId: placement.providerInstanceId,
        ...(perThread ? { threadId: placement.threadId } : {}),
      });
    },
  );
  return { providerSessionIdFor };
};

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
