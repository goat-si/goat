import {
  ProviderDriverKind,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderThreadId,
  type ThreadId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

const MUSE_PROVIDER = ProviderDriverKind.make("muse");

export const museNativeRef = (nativeId: string) => ({
  driver: MUSE_PROVIDER,
  nativeId,
  strength: "strong" as const,
});

export function registerMuseProviderThread(input: {
  readonly existing: OrchestrationV2ProviderThread | undefined;
  readonly id: ProviderThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly appThreadId: ThreadId;
  readonly nativeSessionId: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return input.existing
    ? {
        ...input.existing,
        providerSessionId: input.providerSessionId,
        nativeThreadRef: museNativeRef(input.nativeSessionId),
        ...(input.existing.nativeThreadRef?.nativeId !== input.nativeSessionId
          ? { nativeConversationHeadRef: null, contextUsage: null }
          : {}),
        status: "idle",
        updatedAt: input.now,
      }
    : {
        id: input.id,
        driver: MUSE_PROVIDER,
        providerInstanceId: input.providerInstanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: input.appThreadId,
        ownerNodeId: null,
        nativeThreadRef: museNativeRef(input.nativeSessionId),
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
}
