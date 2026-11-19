import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { makeResultFrame, WAKE_TASK_ID, wakeTaskStarted } from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

it.effect("retains a live Claude process's background task after its root turn fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("failed-live-background"),
          text: "Run a background task.",
          attachments: [],
        }),
      );
      yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000311",
          result: "API Error: 502 Bad Gateway",
          isError: true,
          apiErrorStatus: 502,
          terminalReason: "api_error",
        }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "failed");
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
      const awaitTasks = harness.runtime.awaitBackgroundTasks;
      assert.isDefined(awaitTasks);
      if (awaitTasks === undefined) return;
      const marked = yield* awaitTasks({
        providerThread: harness.providerThread,
        taskIds: [WAKE_TASK_ID],
        awaited: true,
      });
      assert.deepEqual(marked.matched, [WAKE_TASK_ID]);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("clears background tasks when the live Claude process exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("failed-process-exit"),
          text: "Run a background task.",
          attachments: [],
        }),
      );
      yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
      let roster = yield* Queue.take(harness.providerThreadReceipts);
      while (
        !roster.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === WAKE_TASK_ID)
      ) {
        roster = yield* Queue.take(harness.providerThreadReceipts);
      }
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
      yield* Queue.shutdown(harness.sdkMessages);
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "failed");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
