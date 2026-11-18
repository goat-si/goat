import { NodeId, ProviderThreadId, ProviderTurnId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import {
  modelSelection,
  CODEX_DRIVER,
  threadCreatedEvent,
} from "../ProviderEventIngestor.fixtures.ts";

// @effect-diagnostics-next-line effectFnOpportunity:off - Preserve the extracted test helper.
export const ingestCompletedProviderTurn = (
  guard: Pick<
    Parameters<ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"]>[0],
    "writeIfRunCurrent" | "writeIfProviderThreadOwner"
  >,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerTurnId = ProviderTurnId.make("provider-turn:locked");
    const exit = yield* ingestor
      .ingestNormalized({
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        }),
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_turn.updated",
          driver: CODEX_DRIVER,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: ProviderThreadId.make("provider-thread:locked"),
            nodeId: NodeId.make("node:locked-turn"),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        ...guard,
      })
      .pipe(Effect.exit);
    const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
    return { exit, providerTurnId, persisted: projection.providerTurns.map((turn) => turn.id) };
  });
