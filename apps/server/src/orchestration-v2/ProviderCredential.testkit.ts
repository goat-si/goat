import * as Effect from "effect/Effect";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export const startCredentialTurn = Effect.fn("test.startCredentialTurn")(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  input: Pick<
    ProviderAdapter.ProviderAdapterV2TurnInput,
    "appThread" | "providerThread" | "modelSelection" | "runtimePolicy"
  > & { readonly text: string },
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const threadId = input.appThread.id;
  const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
  return yield* runtime.startTurn({
    appThread: input.appThread,
    providerThread: input.providerThread,
    modelSelection: input.modelSelection,
    runtimePolicy: input.runtimePolicy,
    threadId,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
    rootNodeId: idAllocator.derive.rootNode({ runId }),
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
      text: input.text,
      attachments: [],
    },
  });
});
