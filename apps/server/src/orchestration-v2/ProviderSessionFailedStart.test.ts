import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerTest } from "./test/ProviderSessionManagerHarness.testkit.ts";
import { makeThreadCreatedEvent } from "./test/ProviderSessionManagerMemoryDto.testkit.ts";
import {
  makeProviderThread,
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
} from "./ProviderSessionFixture.testkit.ts";

it.effect("ProviderSessionManagerV2 resumes a thread natively again after its start failed", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-failed-start-resume");
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
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
        nativeThreadId: `native-${threadId}`,
      });
      const resume = runtime.resumeThread({
        providerThread,
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* resume;
      yield* resume;
      assert.equal((yield* Ref.get(state)).resumeCount, 1);
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      yield* runtime
        .startTurn({
          appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "turn",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.flip);
      yield* resume;
      assert.equal((yield* Ref.get(state)).resumeCount, 2);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          startTurn: Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CODEX_DRIVER,
              detail: "query ended before the turn could start",
            }),
          ),
        }),
      ),
    );
  }),
);
