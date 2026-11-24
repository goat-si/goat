import type { OrchestrationV2ProviderFailure, ProviderDriverKind } from "@goat/contracts";
import { makeProviderRetryTurnItem } from "@goat/provider-core/server/failure";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { ActiveAcpTurn } from "./activeTurn.ts";

/** The retry notice a turn shows while the agent retries a failed model call. */
export function makeAcpProviderRetry(deps: {
  readonly driver: ProviderDriverKind;
  readonly activeTurn: Ref.Ref<ActiveAcpTurn | null>;
  readonly stoppedRunQuarantine: Ref.Ref<boolean>;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly resolveItemOrdinal: (
    context: ActiveAcpTurn,
    nativeItemId: string,
  ) => Effect.Effect<number>;
}) {
  const emit = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    status: "running" | "completed" | "interrupted" | "cancelled",
  ) {
    const state = context.providerRetry;
    if (state === undefined) return;
    yield* deps.emitProviderEvent({
      type: "turn_item.updated",
      driver: deps.driver,
      turnItem: makeProviderRetryTurnItem({
        driver: deps.driver,
        threadId: context.input.threadId,
        runId: context.input.runId,
        nodeId: context.input.rootNodeId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        ...state,
        status,
        updatedAt: yield* DateTime.now,
      }),
    });
    if (status !== "running") context.providerRetry = undefined;
  });

  const report = Effect.fnUntraced(function* (notice: {
    readonly sessionId: string;
    readonly failure: OrchestrationV2ProviderFailure;
  }) {
    const context = yield* Ref.get(deps.activeTurn);
    if (
      context === null ||
      context.finalized ||
      context.interrupted ||
      context.nativeThreadId !== notice.sessionId ||
      (yield* Ref.get(deps.stoppedRunQuarantine))
    )
      return;
    const previous = context.providerRetry;
    context.providerRetry = {
      failure: notice.failure,
      retry: {
        attempt: (previous?.retry.attempt ?? 0) + 1,
        maxAttempts: null,
        retryDelayMs: null,
      },
      startedAt: previous?.startedAt ?? (yield* DateTime.now),
      itemOrdinal:
        previous?.itemOrdinal ??
        (yield* deps.resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`)),
    };
    yield* emit(context, "running");
  });
  return { emit, report };
}
