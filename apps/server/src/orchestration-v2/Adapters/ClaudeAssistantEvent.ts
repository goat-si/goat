import { ProviderDriverKind } from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ActiveClaudeTurnContext } from "./ClaudeAdapterV2.ts";
import { buildAssistantArtifacts } from "./ClaudeAssistantArtifacts.ts";
import { sealAssistantTextEvent } from "./AssistantTextBoundary.ts";
const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
export function makeClaudeAssistantEventEmitter<E, R>(input: {
  idAllocator: IdAllocator.IdAllocatorV2["Service"];
  resolveItemOrdinal: (
    context: ActiveClaudeTurnContext,
    nativeItemId: string,
  ) => Effect.Effect<number>;
  emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<unknown, E, R>;
}) {
  const { idAllocator, resolveItemOrdinal, emitProviderEvent } = input;
  return Effect.fnUntraced(function* (input: {
    readonly context: ActiveClaudeTurnContext;
    readonly nativeItemId: string;
    readonly text: string;
    readonly streaming?: boolean;
    readonly sealed?: boolean;
    readonly finalAnswer?: { readonly startedAt: DateTime.Utc };
    // Republishes an emitted reply that a steer cut off mid-stream.
    readonly interrupted?: { readonly startedAt: DateTime.Utc };
  }) {
    if (
      input.interrupted === undefined &&
      input.finalAnswer === undefined &&
      input.context.assistant.emittedNativeItemIds.has(input.nativeItemId)
    ) {
      return undefined;
    }
    if (!input.streaming) input.context.assistant.emittedNativeItemIds.add(input.nativeItemId);
    const now = yield* DateTime.now;
    const startedAt =
      input.interrupted?.startedAt ??
      input.finalAnswer?.startedAt ??
      input.context.textProjector.startedAt(input.nativeItemId, now);
    const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
    const artifacts = buildAssistantArtifacts({
      idAllocator,
      turnInput: input.context.input,
      providerTurnId: input.context.providerTurnId,
      nativeItemId: input.nativeItemId,
      text: input.text,
      ordinal,
      ...(input.interrupted === undefined ? {} : { status: "interrupted" as const }),
      startedAt,
      completedAt: now,
      streaming: input.streaming,
      ...(input.finalAnswer === undefined
        ? {}
        : { finalAnswer: true, createdAt: input.finalAnswer.startedAt }),
    });
    yield* Effect.all(
      [
        emitProviderEvent({
          type: "node.updated",
          driver: CLAUDE_PROVIDER,
          node: artifacts.node,
        }),
        input.streaming
          ? Effect.void
          : emitProviderEvent({
              type: "message.updated",
              driver: CLAUDE_PROVIDER,
              message: artifacts.message,
            }),
        emitProviderEvent(
          input.sealed
            ? sealAssistantTextEvent({
                type: "turn_item.updated",
                driver: CLAUDE_PROVIDER,
                turnItem: artifacts.turnItem,
              })
            : {
                type: "turn_item.updated",
                driver: CLAUDE_PROVIDER,
                turnItem: artifacts.turnItem,
              },
        ),
      ],
      { concurrency: 1 },
    );
    return startedAt;
  });
}
