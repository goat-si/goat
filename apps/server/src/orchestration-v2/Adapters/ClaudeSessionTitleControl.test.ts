import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerErrors.ts";
import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue))
          yield* capture((marker) => actual.offer(queue, marker));
        return yield* actual.take(queue);
      }),
  };
});

it.effect("sends a GOAT title through native rename and keeps failures out of metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      const harness = yield* makeWakeHarnessWithOptions({
        renameSession: (title) =>
          Effect.sync(() => {
            calls.push(title);
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ClaudeAgentSdkQueryRunnerError({
                  method: "renameSession",
                  cause: new Error("unavailable"),
                }),
              ),
            ),
          ),
      });
      const turn = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("rename-failure"),
        text: "Hello",
        attachments: [],
      });
      yield* harness.runtime.startTurn({
        ...turn,
        appThread: { ...turn.appThread, title: "My title" },
      });
      yield* harness.awaitEventsRecorded;
      assert.deepEqual(calls, ["My title"]);
      const thread = harness.events.findLast((entry) => entry.type === "provider_thread.updated");
      assert.isUndefined(
        thread?.type === "provider_thread.updated"
          ? thread.providerThread.nativeMetadata?.title
          : undefined,
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("ignores an in-flight GOAT rename echo and persists only the confirmed title", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const harness = yield* makeWakeHarnessWithOptions({
        renameSession: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      });
      const turn = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("rename-echo"),
        text: "Hello",
        attachments: [],
      });
      const starting = yield* harness.runtime
        .startTurn({ ...turn, appThread: { ...turn.appThread, title: "My title" } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "session_title_changed",
          title: "My title",
          uuid: "00000000-0000-4000-8000-000000000500",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.isFalse(harness.events.some((entry) => entry.type === "app_thread.created"));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(starting);
      yield* harness.awaitEventsRecorded;
      const thread = harness.events.findLast((entry) => entry.type === "provider_thread.updated");
      assert.equal(
        thread?.type === "provider_thread.updated"
          ? thread.providerThread.nativeMetadata?.title
          : undefined,
        "My title",
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("retains the confirmed native title after the turn finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const turn = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("rename-persist"),
        text: "Hello",
        attachments: [],
      });
      yield* harness.runtime.startTurn({
        ...turn,
        appThread: { ...turn.appThread, title: "My title" },
      });
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000701", result: "Done" }),
      );
      yield* harness.awaitTerminal(1);
      const thread = harness.events.findLast((entry) => entry.type === "provider_thread.updated");
      assert.equal(
        thread?.type === "provider_thread.updated"
          ? thread.providerThread.nativeMetadata?.title
          : undefined,
        "My title",
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
