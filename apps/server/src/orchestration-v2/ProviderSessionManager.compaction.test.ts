import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeThreadCreatedEvent } from "./test/ProviderSessionManagerMemoryDto.testkit.ts";
import { layerTest } from "./test/ProviderSessionManagerHarness.testkit.ts";
import {
  makeProviderThread,
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
} from "./ProviderSessionFixture.testkit.ts";

const idleReleaseAroundRun = (start: "compactThread" | "resumeTurn") =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread-${start}-outlasts-idle-timeout`);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
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
      const subscriber = yield* runtime.subscribeEvents!;
      const terminal = yield* subscriber.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
        nativeThreadId: `native-${threadId}`,
      });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const run = {
        appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
        rootNodeId: idAllocator.derive.rootNode({ runId }),
        providerThread,
        modelSelection,
        runtimePolicy,
      };
      const messageId = yield* idAllocator.allocate.message({ threadId, ordinal: 1 });
      yield* start === "compactThread"
        ? runtime.compactThread!({
            ...run,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId,
              text: "/compact",
              attachments: [],
            },
          })
        : runtime.resumeTurn!({
            ...run,
            cloudTask: {
              taskId: "cloud-task-resume-idle",
              status: "running",
              tracking: "live",
              source: { repository: "goat-si/goat", branch: "dev" },
              localChangesExcluded: false,
              updatedAt: DateTime.formatIso(now),
            },
          });

      // A running compaction or continuation can go minutes without a provider event.
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(yield* manager.isLive(providerSessionId));

      const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(queue);
      yield* Queue.offer(queue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId: providerThread.id,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: `native-turn-${start}`,
        }),
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      // The event pump marks the run idle before it publishes the event.
      yield* Fiber.join(terminal);
      yield* TestClock.adjust("2 seconds");
      assert.isFalse(yield* manager.isLive(providerSessionId));
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          resumeTurn: Effect.void,
          compactThread: Effect.void,
        }),
      ),
    );
  });

it.effect.each([
  { run: "compaction", start: "compactThread" },
  { run: "manual continuation", start: "resumeTurn" },
] as const)(
  "ProviderSessionManagerV2 keeps a session through a $run that outlasts the idle timeout",
  ({ start }) => idleReleaseAroundRun(start),
);
