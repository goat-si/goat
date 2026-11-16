import type { OrchestrationV2ProviderThread, ProviderInstanceId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";

export function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly storeCwd: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    nativeMetadata: { cursorStoreCwd: input.storeCwd },
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const id = providerThread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined) {
    throw new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing its Cursor agent id.`,
    });
  }
  return id;
}
