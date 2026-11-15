import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
} from "@goat/contracts";
import { makeProviderFailure, makeProviderRetryTurnItem } from "@goat/provider-core/server/failure";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { readableProviderErrorMessage } from "../providerErrorMessage.ts";
import type { ActiveTurn, EventOf, ThreadState, TurnTerminal } from "./adapterState.ts";
import type { ItemBase } from "./externalPrompts.ts";

export const makeTurnStatusItems = (deps: {
  readonly driver: ProviderDriverKind;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly ordinalOf: (turn: ActiveTurn, nativeId: string) => number;
  readonly itemBase: (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    status: OrchestrationV2TurnItem["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
    updatedAt: DateTime.Utc,
  ) => ItemBase;
}) => {
  const { driver, emit, ordinalOf, itemBase } = deps;

  const emitCompaction = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    status: "running" | "completed" | "failed" | "interrupted",
    summary?: string,
  ) {
    const compaction = turn.compaction;
    if (compaction === undefined) return;
    const updatedAt = yield* DateTime.now;
    const completedAt = status === "running" ? null : updatedAt;
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...itemBase(
          state,
          turn,
          compaction.nativeId,
          status,
          compaction.startedAt,
          completedAt,
          updatedAt,
        ),
        nodeId: turn.input.rootNodeId,
        type: "compaction",
        driver,
        title:
          status === "running"
            ? "Compacting context"
            : status === "completed"
              ? "Context compacted"
              : status === "failed"
                ? "Compaction failed"
                : "Compaction interrupted",
        ...(summary === undefined || summary.length === 0 ? {} : { summary }),
      },
    });
    if (status !== "running") turn.compaction = undefined;
  });

  const emitRetry = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    status: "running" | TurnTerminal["status"],
    failure?: OrchestrationV2ProviderFailure,
  ) {
    const retry = turn.retry;
    if (retry === undefined) return;
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: makeProviderRetryTurnItem({
        driver,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: turn.input.rootNodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        itemOrdinal: ordinalOf(turn, `terminal-failure:${turn.providerTurn.id}`),
        failure: failure ?? retry.failure,
        retry: retry.retry,
        status,
        startedAt: retry.startedAt,
        updatedAt: yield* DateTime.now,
      }),
    });
  });

  const updateRetry = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    { attempt, error }: Pick<EventOf<"session.retry.scheduled">["data"], "attempt" | "error">,
    delayMs: number,
  ) {
    turn.retry = {
      retry: {
        // OpenCode counts the first request as attempt 1, so its first retry is attempt 2.
        attempt: Math.max(1, attempt - 1),
        maxAttempts: null,
        retryDelayMs: Math.max(0, Math.trunc(delayMs)),
      },
      failure: makeProviderFailure({
        message: readableProviderErrorMessage(error.message, error.status, error.response?.body),
        code: error.type,
        class: "provider_error",
        retryable: true,
      }),
      startedAt: turn.retry?.startedAt ?? (yield* DateTime.now),
    };
    yield* emitRetry(state, turn, "running");
  });

  return { emitCompaction, emitRetry, updateRetry };
};
