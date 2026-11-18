import type { OrchestrationV2ProviderThread, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";

// The adapter's own constants; only read when a provider thread is built, after both modules load.
import { CODEX_DRIVER_KIND as CODEX_PROVIDER, codexTimestamp } from "./CodexAdapterV2.ts";

export function providerThreadFromCodexThread(input: {
  readonly appThreadId: ThreadId | null;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly ownerNodeId: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly thread: {
    readonly createdAt: number;
    readonly forkedFromId?: string | null;
    readonly id: string;
    readonly updatedAt: number;
  };
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_PROVIDER,
      nativeThreadId: input.thread.id,
    }),
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: {
      driver: CODEX_PROVIDER,
      nativeId: input.thread.id,
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: codexTimestamp(input.thread.createdAt),
    updatedAt: codexTimestamp(input.thread.updatedAt),
  };
}
