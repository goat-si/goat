import type {
  OrchestrationV2ContextTransfer,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  RunAttemptId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeForkHistoryReader } from "../ForkHistoryReader.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@goat/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as TurnItemPositionStore from "../TurnItemPositionStore.ts";
import { visibleDeltaRunOrdinals } from "../ProviderContextBoundaries.ts";

export const makeNativeForkRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const { readForkHistory } = makeForkHistoryReader(store);
  return Effect.fn("ProviderTurnStartService.recoverNativeFork")(function* (input: {
    projection: Pick<OrchestrationV2ThreadProjection, "thread">;
    source: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "attempts">;
    sourceRun: OrchestrationV2Run;
    sourceProviderThread: OrchestrationV2ProviderThread;
    providerThread: OrchestrationV2ProviderThread;
    freshThread: OrchestrationV2ProviderThread;
    attemptId: RunAttemptId;
    run: OrchestrationV2Run;
    rootNode: OrchestrationV2ExecutionNode;
    transfer: OrchestrationV2ContextTransfer;
    failure: Error;
  }) {
    const source = {
      ...input.source,
      ...(yield* store.getThreadRecords(input.source.thread.id, ["runs", "attempts"])),
    };
    const now = yield* DateTime.now;
    const items = yield* readForkHistory(source, input.sourceRun.ordinal);
    const handoff = yield* handoffs.prepareProviderHandoff({
      threadId: input.projection.thread.id,
      sourceThreadId: input.source.thread.id,
      targetRunId: input.run.id,
      transferId: input.transfer.id,
      fromProviderThreadIds: [input.sourceProviderThread.id],
      toProviderThreadId: input.providerThread.id,
      fromProviderInstanceId: input.sourceRun.providerInstanceId,
      toProviderInstanceId: input.run.providerInstanceId,
      coveredRunOrdinals: visibleDeltaRunOrdinals(source, items),
      strategy: "full_thread_summary",
      items,
      runs: source.runs,
      createdAt: now,
    });
    const cause = "cause" in input.failure ? input.failure.cause : undefined;
    const message = makeProviderFailure({
      cause: input.failure,
      message:
        knownProviderFailureMessage(input.failure) ??
        (cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : input.failure.message),
      class: "provider_error",
    }).message;
    const itemId = ids.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "native-fork-fallback",
    });
    const notice: OrchestrationV2TurnItem = {
      id: itemId,
      threadId: input.projection.thread.id,
      runId: input.run.id,
      nodeId: input.rootNode.id,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* positions.allocate({
        threadId: input.projection.thread.id,
        turnItemId: itemId,
        runId: input.run.id,
        runOrdinal: input.run.ordinal,
        placement: "run_start",
      }),
      status: "completed",
      title: "Native fork failed",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "system_notice",
      message: `Could not fork the source conversation natively (${message}). Started a fresh session with its history.`,
    };
    const write = yield* sink.writeIfRunCurrent({
      threadId: input.projection.thread.id,
      runId: input.run.id,
      activeAttemptId: input.attemptId,
      expectedStatus: "starting",
      events: [
        {
          id: yield* ids.allocate.event({ threadId: input.projection.thread.id }),
          type: "provider-thread.updated",
          threadId: input.projection.thread.id,
          driver: input.freshThread.driver,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: { ...input.freshThread, forkedFrom: null },
        },
        {
          id: yield* ids.allocate.event({ threadId: input.projection.thread.id }),
          type: "context-handoff.updated",
          threadId: input.projection.thread.id,
          runId: input.run.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: handoff,
        },
        {
          id: yield* ids.allocate.event({ threadId: input.projection.thread.id }),
          type: "context-transfer.updated",
          threadId: input.projection.thread.id,
          runId: input.run.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...input.transfer,
            status: "resolved_portable",
            resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
            error: null,
            updatedAt: now,
          },
        },
        {
          id: yield* ids.allocate.event({ threadId: input.projection.thread.id }),
          type: "turn-item.updated",
          threadId: input.projection.thread.id,
          runId: input.run.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: now,
          payload: notice,
        },
      ],
    });
    return write.committed ? handoff : undefined;
  });
});
