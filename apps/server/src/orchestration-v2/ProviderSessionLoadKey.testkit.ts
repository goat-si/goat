import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as EventSink from "./EventSink.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type * as Fixture from "./ProviderSessionManager.test.ts";
import { emptyState, modelSelection, runtimePolicy } from "./ProviderSessionFixture.testkit.ts";

export function registerCodexLoadKeyCheck({
  makeThreadCreatedEvent,
  makeProviderThread,
  layerTest,
}: {
  makeThreadCreatedEvent: typeof Fixture.makeThreadCreatedEvent;
  makeProviderThread: typeof Fixture.makeProviderThread;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect.each([true, false])(
    "reloads only when the provider's load key changes (Codex normalization: %s)",
    (normalizeCodexLoad) =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        yield* Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const allocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const now = yield* DateTime.now;
          const projectId = yield* allocator.allocate.project({ fixtureName: "load-key-project" });
          const threadId = yield* allocator.allocate.thread({
            fixtureName: "load-key-thread",
            projectId,
          });
          const providerSessionId = allocator.derive.providerSession({
            providerInstanceId: modelSelection.instanceId,
          });
          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId, now })],
          });
          const providerThread = makeProviderThread({
            idAllocator: allocator,
            threadId,
            providerSessionId,
            now,
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          for (const effort of ["medium", "high", "medium"]) {
            yield* runtime.resumeThread({
              providerThread,
              threadId,
              modelSelection: {
                ...modelSelection,
                options: [{ id: "reasoningEffort", value: effort }],
              },
              runtimePolicy,
            });
          }
          assert.equal((yield* Ref.get(state)).resumeCount, normalizeCodexLoad ? 1 : 3);
          yield* runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection: { ...modelSelection, model: "other" },
            runtimePolicy,
          });
          assert.equal((yield* Ref.get(state)).resumeCount, normalizeCodexLoad ? 2 : 4);
        }).pipe(
          Effect.provide(layerTest({ state, idleTimeoutMs: 1000, normalizeCodexLoad })),
          Effect.scoped,
        );
      }),
  );
}
