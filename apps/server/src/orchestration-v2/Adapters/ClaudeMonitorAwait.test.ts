import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { monitorFrames } from "./ClaudeMonitorFrames.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { claudeSdkFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";
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

it.effect("does not re-await a monitor that was explicitly released when its roster repeats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const now = yield* DateTime.now;
      let n = 0;
      const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("monitor-unawait"),
          text: "Watch",
          attachments: [],
        }),
      );
      const monitor = monitorFrames(0, uuid);
      for (const frame of monitor.start) yield* harness.offerAndWait(frame);
      const awaitTasks = harness.runtime.awaitBackgroundTasks;
      assert.isDefined(awaitTasks);
      if (awaitTasks === undefined) return;
      const released = yield* awaitTasks({
        providerThread: harness.providerThread,
        taskIds: [monitor.taskId],
        awaited: false,
      });
      assert.deepEqual(released.matched, [monitor.taskId]);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: monitor.taskId, task_type: "local_bash", description: "Monitor 0" }],
          uuid: uuid(),
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const roster = harness.events
        .filter((event) => event.type === "provider_thread.updated")
        .at(-1)?.providerThread.pendingBackgroundTasks;
      assert.isUndefined(roster?.find((task) => task.taskId === monitor.taskId)?.awaited);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
