import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeThreadCreatedEvent } from "./test/ProviderSessionManagerMemoryDto.testkit.ts";
import {
  makeProviderThread,
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
} from "./ProviderSessionFixture.testkit.ts";
import { layerTest } from "./test/ProviderSessionManagerHarness.testkit.ts";

it.effect(
  "ProviderSessionManagerV2 unloads each idle native thread a fresh session replaced in the same app thread",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-fresh-rounds");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        // Each scheduled "fresh session" round opens a new native thread in the same app thread.
        for (const round of [1, 2]) {
          const runId = idAllocator.derive.run({ threadId, ordinal: round });
          const providerThread = makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: `native-round-${round}`,
          });
          yield* runtime.startTurn({
            appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
            threadId,
            runId,
            runOrdinal: round,
            providerTurnOrdinal: 1,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "server",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: round }),
              text: "Reply with OK.",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          });
          const subscription = yield* runtime.subscribeEvents!;
          yield* Queue.offer((yield* Ref.get(state)).eventQueues.get(String(providerSessionId))!, {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: providerThread.id,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: `native-turn-${round}`,
            }),
            runOrdinal: round,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* subscription.events.pipe(Stream.runHead);
        }

        yield* TestClock.adjust("1 second");
        assert.sameMembers(
          [...(yield* Ref.get(state)).unloadedNativeThreadIds],
          ["native-round-1", "native-round-2"],
        );
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            // Keep the shared app-server open, as other conversations do.
            hasPendingBackgroundWork: Effect.succeed(true),
          }),
        ),
      );
    }),
);
