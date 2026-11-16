import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeProviderFailure, makeProviderRetryTurnItem } from "@goat/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EventSink from "./EventSink.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type * as Fixture from "./ProviderSessionManager.test.ts";
import {
  CODEX_DRIVER,
  emptyState,
  makeProviderThread,
  modelSelection,
  runtimePolicy,
} from "./ProviderSessionFixture.testkit.ts";

export function registerRetryStallCheck({
  makeThreadCreatedEvent,
  layerTest,
}: {
  makeThreadCreatedEvent: typeof Fixture.makeThreadCreatedEvent;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("ProviderSessionManagerV2 fails a turn whose provider retry never resumes", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const interrupted = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-retry-stall");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const subscribeEvents = runtime.subscribeEvents;
        assert.isDefined(subscribeEvents);
        const subscription = yield* subscribeEvents;
        const published = yield* Queue.unbounded<void>();
        // The pump updates the stall watch before it publishes a turn item.
        const collected = yield* subscription.events.pipe(
          Stream.tap((event) =>
            event.type === "turn_item.updated" ? Queue.offer(published, undefined) : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(adapterQueue);
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "retry-stall-turn",
        });
        const failure = makeProviderFailure({
          message: "Rate limit exceeded",
          code: "rate_limited",
          class: "usage_limit",
          retryable: true,
        });
        const retry = { attempt: 2, maxAttempts: 5, retryDelayMs: 60_000 };
        const retryItem = (status: "running" | "interrupted" | "completed") =>
          makeProviderRetryTurnItem({
            driver: CODEX_DRIVER,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: providerThread.id,
            providerTurnId,
            itemOrdinal: 3,
            failure,
            retry,
            status,
            startedAt: now,
            updatedAt: now,
          });
        yield* Queue.offer(adapterQueue, {
          type: "turn_item.updated",
          driver: CODEX_DRIVER,
          turnItem: retryItem("running"),
        });
        yield* Queue.take(published);
        const offerOutput = (outputThreadId: ThreadId) =>
          Queue.offer(adapterQueue, {
            type: "turn_item.updated",
            driver: CODEX_DRIVER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_DRIVER,
                nativeItemId: `retry-stall-output-${outputThreadId}`,
              }),
              threadId: outputThreadId,
              runId: null,
              nodeId: null,
              providerThreadId: providerThread.id,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 4,
              type: "compaction",
              driver: CODEX_DRIVER,
              status: "running",
              title: "Compacting context",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          }).pipe(Effect.andThen(Queue.take(published)));
        // The stall window is 15 minutes plus the provider's announced retry delay.
        yield* TestClock.adjust("15 minutes");
        assert.equal((yield* Ref.get(state)).interruptCount, 0);
        // Output on the retry's thread proves the provider is alive, so a new window starts.
        yield* offerOutput(threadId);
        yield* TestClock.adjust("1 minute");
        // Another thread's output lets the timer start its next wait and does not count.
        yield* offerOutput(ThreadId.make("thread-provider-session-manager-retry-stall-other"));
        yield* TestClock.adjust("15 minutes");
        assert.equal((yield* Ref.get(state)).interruptCount, 0);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(interrupted);
        yield* Queue.offer(adapterQueue, {
          type: "turn_item.updated",
          driver: CODEX_DRIVER,
          turnItem: retryItem("interrupted"),
        });
        yield* Queue.offer(adapterQueue, {
          type: "provider_turn.updated",
          driver: CODEX_DRIVER,
          threadId,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: providerThread.id,
            nodeId: idAllocator.derive.rootNode({
              runId: idAllocator.derive.run({ threadId, ordinal: 1 }),
            }),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "interrupted",
            startedAt: now,
            completedAt: now,
          },
        });
        yield* Queue.offer(adapterQueue, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          status: "interrupted",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Queue.offer(adapterQueue, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: { ...runtime.providerSession, status: "stopped", updatedAt: now },
        });
        yield* Queue.end(adapterQueue);

        const events = Array.from(yield* Fiber.join(collected));
        const terminal = events.find((event) => event.type === "turn.terminal");
        const providerTurn = events.find((event) => event.type === "provider_turn.updated");
        assert.equal(
          providerTurn?.type === "provider_turn.updated" ? providerTurn.providerTurn.status : null,
          "failed",
        );
        assert.deepEqual(terminal, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          failureItemOrdinal: 3,
          status: "failed",
          failure: { ...failure, retryable: false },
          retry,
          retryStartedAt: now,
          threadDisposition: "reusable",
        });
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60 * 60_000,
            interruptTurn: Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
          }),
        ),
      );
    }),
  );

  it.effect("ProviderSessionManagerV2 leaves a turn alone once its provider retry settles", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const interrupted = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-retry-stall");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const subscribeEvents = runtime.subscribeEvents;
        assert.isDefined(subscribeEvents);
        const subscription = yield* subscribeEvents;
        const published = yield* Queue.unbounded<void>();
        // The pump updates the stall watch before it publishes a turn item.
        const _collected = yield* subscription.events.pipe(
          Stream.tap((event) =>
            event.type === "turn_item.updated" ? Queue.offer(published, undefined) : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(adapterQueue);
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "retry-stall-turn",
        });
        const failure = makeProviderFailure({
          message: "Rate limit exceeded",
          code: "rate_limited",
          class: "usage_limit",
          retryable: true,
        });
        const retry = { attempt: 2, maxAttempts: 5, retryDelayMs: 60_000 };
        const retryItem = (status: "running" | "interrupted" | "completed") =>
          makeProviderRetryTurnItem({
            driver: CODEX_DRIVER,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: providerThread.id,
            providerTurnId,
            itemOrdinal: 3,
            failure,
            retry,
            status,
            startedAt: now,
            updatedAt: now,
          });
        yield* Queue.offer(adapterQueue, {
          type: "turn_item.updated",
          driver: CODEX_DRIVER,
          turnItem: retryItem("running"),
        });
        yield* Queue.take(published);
        yield* Queue.offer(adapterQueue, {
          type: "turn_item.updated",
          driver: CODEX_DRIVER,
          turnItem: retryItem("completed"),
        });
        yield* Queue.take(published);
        yield* TestClock.adjust("16 minutes");
        assert.equal((yield* Ref.get(state)).interruptCount, 0);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60 * 60_000,
            interruptTurn: Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
          }),
        ),
      );
    }),
  );
}
