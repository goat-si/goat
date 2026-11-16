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
  wakeAssistant,
  wakeNotification,
  wakeResult,
  turnOneResult,
  wakeTaskStarted,
  wakeTurnInit,
  WAKE_TASK_ID,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

// Only collectors opt into queue capture. A FIFO marker then acknowledges all
// provider events offered before it, after their collector callbacks finish.
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

const makeWakeHarness = makeWakeHarnessWithOptions();
it.effect("offers a later wake after an earlier wake's continuation dispatch failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const SECOND_TASK_ID = "b2ndwake";
      const SECOND_TOOL_USE_ID = "toolu_second_wake";
      const SECOND_SUMMARY = 'Background command "Second sleep" completed (exit code 0)';
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-dispatch-failed-1"),
          text: "Run two builds in the background.",
          attachments: [],
        }),
      );
      yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          ...wakeTaskStarted,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          description: "Second sleep",
          uuid: "00000000-0000-4000-8000-000000000121",
        }),
      );
      yield* Queue.offer(harness.sdkMessages, turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* harness.offerAndWait(wakeNotification);
      yield* harness.offerAndWait(wakeTurnInit);
      assert.lengthOf(harness.continuationRequests, 1);
      yield* harness.offerAndWait(wakeAssistant);
      yield* harness.offerAndWait(wakeResult);

      // A failed dispatch never attaches the wake turn; clearIfCurrent is the only release.
      const failed = harness.continuationRequests[0]!;
      assert.isDefined(failed.clearIfCurrent);
      yield* failed.clearIfCurrent!();
      yield* harness.awaitUntil(
        () =>
          !(
            harness.events
              .flatMap((event) => (event.type === "provider_thread.updated" ? [event] : []))
              .at(-1)?.providerThread.pendingBackgroundTasks ?? []
          ).some((task) => task.taskId === WAKE_TASK_ID),
        "wake task released",
      );

      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeNotification,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          output_file: `/tmp/claude-replay/tasks/${SECOND_TASK_ID}.output`,
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000123",
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000124" }),
      );
      assert.lengthOf(harness.continuationRequests, 2);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("keeps a newer wake latched when a stale continuation request is cleared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const SECOND_TASK_ID = "b2ndwake";
      const SECOND_TOOL_USE_ID = "toolu_second_wake";
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-stale-clear-1"),
          text: "Run two builds in the background.",
          attachments: [],
        }),
      );
      yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          ...wakeTaskStarted,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          description: "Second sleep",
          uuid: "00000000-0000-4000-8000-000000000131",
        }),
      );
      yield* Queue.offer(harness.sdkMessages, turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* harness.offerAndWait(wakeNotification);
      yield* harness.offerAndWait(wakeTurnInit);
      assert.lengthOf(harness.continuationRequests, 1);
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-stale-clear-2"),
          text: "Background task completed.",
          attachments: [],
          providerTurnOrdinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
        }),
      );
      yield* harness.offerAndWait(wakeAssistant);
      yield* harness.offerAndWait(wakeResult);
      yield* harness.awaitTerminal(2);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeNotification,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          output_file: `/tmp/claude-replay/tasks/${SECOND_TASK_ID}.output`,
          uuid: "00000000-0000-4000-8000-000000000133",
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000134" }),
      );
      assert.lengthOf(harness.continuationRequests, 2);

      yield* harness.continuationRequests[0]!.clearIfCurrent!();
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeAssistant, uuid: "00000000-0000-4000-8000-000000000135" }),
      );
      assert.lengthOf(harness.continuationRequests, 2);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
