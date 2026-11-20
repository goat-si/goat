import { MessageId, RunId, type OrchestrationV2ThreadProjection } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { awaitThreadState, snapshot, titleUpdated } from "./threadsSyncFixtures.ts";
import { BASE_PROJECTION, THREAD_ID, makeHarness } from "./threadsSync.testkit.ts";

describe("EnvironmentThreads", () => {
  it.effect("caches a running thread once when its view closes, not on each update", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      const running: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        runs: [
          {
            id: RunId.make("run-running"),
            threadId: THREAD_ID,
            ordinal: 1,
            providerInstanceId: BASE_PROJECTION.thread.providerInstanceId,
            modelSelection: BASE_PROJECTION.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message-running"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
            startedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      };
      yield* Queue.offer(harness.inputs, snapshot(running, 4));
      yield* Queue.offer(harness.inputs, titleUpdated("Streaming update", 5));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.thread.title === "Streaming update",
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(0);

      yield* Scope.close(scope, Exit.void);
      const saved = yield* Ref.get(harness.savedThreads);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.snapshotSequence).toBe(5);
      expect(saved[0]?.projection.thread.title).toBe("Streaming update");
      expect(saved[0]?.projection.runs[0]?.status).toBe("running");
    }),
  );
});
