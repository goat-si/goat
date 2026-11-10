import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type * as Fixture from "./ProviderSessionManager.test.ts";
import {
  ExclusiveCapabilities,
  emptyState,
  modelSelection,
  runtimePolicy,
} from "./ProviderSessionFixture.testkit.ts";

export function registerDetachRequestCheck({
  makeThreadCreatedEvent,
  makeProviderThread,
  makePendingRuntimeRequestEvents,
  layerTest,
}: {
  makeThreadCreatedEvent: typeof Fixture.makeThreadCreatedEvent;
  makeProviderThread: typeof Fixture.makeProviderThread;
  makePendingRuntimeRequestEvents: typeof Fixture.makePendingRuntimeRequestEvents;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect(
    "ProviderSessionManagerV2 cancels a pending approval when a detach releases its session",
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const effect = Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
          const now = yield* DateTime.now;
          const projectId = yield* idAllocator.allocate.project({
            fixtureName: "provider-session-manager-detach-request",
          });
          const threadId = yield* idAllocator.allocate.thread({
            fixtureName: "provider-session-manager-detach-request",
            projectId,
          });
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
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const pendingRequest = yield* makePendingRuntimeRequestEvents({
            idAllocator,
            threadId,
            providerSessionId,
            providerThread,
            now,
          });
          yield* eventSink.write({ events: pendingRequest.events });
          yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

          yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });

          assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.id === pendingRequest.requestId,
          );
          assert.equal(request?.status, "cancelled");
          assert.equal(request?.responseCapability.type, "not_resumable");
        });

        yield* effect.pipe(
          Effect.provide(
            layerTest({ state, idleTimeoutMs: 60_000, capabilities: ExclusiveCapabilities }),
          ),
        );
      }),
  );
}
