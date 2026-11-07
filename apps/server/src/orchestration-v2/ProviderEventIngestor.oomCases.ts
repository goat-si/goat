import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
export function registerAgentOomIngestorCases({
  makeLayerTest,
  layerTestEventSink,
  layerEmptyInstances,
  threadCreatedEvent,
  modelSelection,
  CODEX_DRIVER,
}: Pick<
  typeof import("./ProviderEventIngestor.test.ts"),
  | "makeLayerTest"
  | "layerTestEventSink"
  | "layerEmptyInstances"
  | "threadCreatedEvent"
  | "modelSelection"
  | "CODEX_DRIVER"
>) {
  it.effect.each([false, true])(
    "attributes terminal failures only to OOM-marked threads (%s)",
    (oomKilled) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const sink = yield* EventSink.EventSinkV2;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const thread = yield* threadCreatedEvent(now);
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: thread.threadId,
        });
        const providerThreadId = ids.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "oom-native-thread",
        });
        const providerTurnId = ids.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "oom-native-turn",
        });
        yield* sink.write({ events: [thread] });
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: thread.threadId,
          event: {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId,
            providerTurnId,
            runOrdinal: 1,
            failureItemOrdinal: 1,
            status: "failed",
            failure: makeProviderFailure({
              message: "provider failed",
              code: "provider_error",
              class: "unknown",
            }),
            threadDisposition: "reusable",
          },
        });
        const result = yield* projection.getThreadProjection(thread.threadId);
        const error = result.visibleTurnItems.find((item) => item.item.type === "error")?.item;
        assert.equal(error?.type, "error");
        if (error?.type !== "error") return;
        assert.equal(
          error.failure.message,
          oomKilled ? "Killed: out of memory." : "provider failed",
        );
        assert.equal(error.failure.code, oomKilled ? "oom_kill" : "provider_error");
      }).pipe(Effect.provide(makeLayerTest(layerTestEventSink, layerEmptyInstances, oomKilled))),
  );
}
