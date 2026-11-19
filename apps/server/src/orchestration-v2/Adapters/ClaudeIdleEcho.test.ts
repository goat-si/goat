import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { claudeSdkFrame, turnOneResult, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue)) {
          yield* capture((marker) => actual.offer(queue, marker));
        }
        return yield* actual.take(queue);
      }),
  };
});

it.effect("ignores replayed local command output while idle but keeps genuine wake frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-idle-local-command"),
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);
      const frame = (content: string, isReplay: boolean) =>
        claudeSdkFrame({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          ...(isReplay ? { isReplay } : {}),
          uuid: "00000000-0000-4000-8000-000000000b01",
          session_id: WAKE_NATIVE_SESSION,
        });
      yield* harness.offerAndWait(
        frame("<local-command-stdout>Set model</local-command-stdout>", true),
      );
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
      yield* harness.offerAndWait(frame("A background task finished.", false));
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
