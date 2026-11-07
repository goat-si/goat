import * as Option from "effect/Option";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type * as Fixture from "./ProviderSessionManager.test.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing session test fixture");
  return value;
}
export function registerExtensionSessionChecks({
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeThreadCreatedEvent,
  makeProviderThread,
  layerTest,
}: {
  emptyState: typeof Fixture.emptyState;
  modelSelection: typeof Fixture.modelSelection;
  CODEX_DRIVER: typeof Fixture.CODEX_DRIVER;
  runtimePolicy: typeof Fixture.runtimePolicy;
  makeThreadCreatedEvent: typeof Fixture.makeThreadCreatedEvent;
  makeProviderThread: typeof Fixture.makeProviderThread;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect(
    "ProviderSessionManagerV2 projects idle extension statuses and rejects a retired runtime's updates",
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        yield* Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make("thread-extension-status");
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* eventSink.write({
            events: [
              yield* makeThreadCreatedEvent({ idAllocator, threadId, now: yield* DateTime.now }),
            ],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const firstClient = yield* required(runtime.subscribeEvents);
          const secondClient = yield* required(runtime.subscribeEvents);
          const oldQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
          assert.isDefined(oldQueue);
          const statuses = [{ key: "watch", text: "Watching 4 files" }];
          yield* Queue.offer(required(oldQueue), {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: { ...runtime.providerSession, extensionStatuses: statuses },
          });
          yield* Effect.all([
            firstClient.events.pipe(Stream.runHead),
            secondClient.events.pipe(Stream.runHead),
          ]);
          assert.deepEqual(
            (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)
              ?.extensionStatuses,
            statuses,
          );
          const reused = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          assert.deepEqual(reused.providerSession.extensionStatuses, statuses);
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
                type: "provider-session.updated",
                threadId,
                driver: CODEX_DRIVER,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: reused.providerSession,
              },
            ],
          });
          assert.deepEqual(
            (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)
              ?.extensionStatuses,
            statuses,
          );
          yield* manager.close(providerSessionId);
          assert.deepEqual(
            (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)
              ?.extensionStatuses,
            [],
          );
          const replacement = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const replacementClient = yield* required(replacement.subscribeEvents);
          const newQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
          assert.isDefined(newQueue);
          yield* Queue.offer(required(oldQueue), {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: {
              ...runtime.providerSession,
              extensionStatuses: [{ key: "stale", text: "Old session" }],
            },
          });
          yield* Queue.offer(required(newQueue), {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: {
              ...replacement.providerSession,
              extensionStatuses: [{ key: "new", text: "New session" }],
            },
          });
          yield* replacementClient.events.pipe(Stream.runHead);
          assert.deepEqual(
            (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)
              ?.extensionStatuses,
            [{ key: "new", text: "New session" }],
          );
          assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).messages, 0);
          assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).turnItems, 0);
        }).pipe(
          Effect.provide(
            layerTest({
              state,
              idleTimeoutMs: 60_000,
              extensionStatuses: [{ key: "initial", text: "Watching" }],
            }),
          ),
        );
      }),
  );

  it.effect.each(["session metadata", "session status changes", "provider work"] as const)(
    "ProviderSessionManagerV2 expires idle sessions according to %s",
    (activity) =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        yield* Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make("thread-session-metadata-idle");
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* eventSink.write({
            events: [
              yield* makeThreadCreatedEvent({ idAllocator, threadId, now: yield* DateTime.now }),
            ],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const subscriber = yield* required(runtime.subscribeEvents);
          const observed = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* subscriber.events.pipe(
            Stream.runForEach((event) => Queue.offer(observed, event)),
            Effect.ignore,
            Effect.forkScoped,
          );
          const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
          assert.isDefined(queue);
          const waitingSession = { ...runtime.providerSession, status: "waiting" as const };
          yield* Queue.offer(required(queue), {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: waitingSession,
          });
          yield* Queue.take(observed);

          for (const text of ["Watching 1 file", "Watching 2 files"]) {
            yield* TestClock.adjust("300 millis");
            yield* Queue.offer(required(queue), {
              type: "provider_session.updated",
              driver: CODEX_DRIVER,
              providerSession: {
                ...waitingSession,
                extensionStatuses: [{ key: "watch", text }],
              },
            });
            yield* Queue.take(observed);
          }
          yield* TestClock.adjust("300 millis");
          const statuses = [{ key: "watch", text: "Watching 3 files" }];
          yield* Queue.offer(
            required(queue),
            activity === "provider work"
              ? {
                  type: "provider_thread.updated",
                  driver: CODEX_DRIVER,
                  providerThread: makeProviderThread({
                    idAllocator,
                    threadId,
                    providerSessionId,
                    now: yield* DateTime.now,
                  }),
                }
              : {
                  type: "provider_session.updated",
                  driver: CODEX_DRIVER,
                  providerSession: {
                    ...waitingSession,
                    status: activity === "session status changes" ? "ready" : "waiting",
                    extensionStatuses: statuses,
                  },
                },
          );
          yield* Queue.take(observed);
          if (activity !== "provider work") {
            assert.deepEqual(
              (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)
                ?.extensionStatuses,
              statuses,
            );
          }
          const afterSequence = yield* eventSink.latestSequence({ threadId });
          yield* TestClock.adjust("100 millis");
          assert.equal(yield* manager.isLive(providerSessionId), activity !== "session metadata");
          if (activity !== "session metadata") {
            yield* TestClock.adjust("900 millis");
          }
          assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
          yield* eventSink
            .stream({ threadId, afterSequence, eventType: "provider-session.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-session.updated" &&
                  stored.event.payload.status === "stopped",
              ),
              Stream.runHead,
            );
          assert.deepEqual(
            (yield* projectionStore.getThreadProjection(threadId)).providerSessions.at(-1)
              ?.extensionStatuses,
            [],
          );
          assert.equal((yield* Ref.get(state)).closeCount, 1);
        }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000 })));
      }),
  );
}
