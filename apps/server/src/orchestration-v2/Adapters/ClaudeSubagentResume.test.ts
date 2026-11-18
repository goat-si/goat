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
  makeSubagentAssistantFrames,
  makeSubagentNotificationFrame,
  makeSubagentTaskStartedFrame,
  makeSubagentToolResultFrame,
  subagentRouting,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
  wakeTurnInit,
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
// Claude reports a background subagent `completed` when its turn ends while
// its own background shell still runs. When that shell finishes, Claude
// resumes the subagent with a new task_started for the same task and launch
// tool_use_id while the root is idle. Frame order mirrors a live capture.
it.effect("reopens a completed background subagent that resumes while the root is idle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const TASK_ID = "ae3f32459af762a5f";
      const LAUNCH = "toolu_01LcidmwEK1Y6GC6LpX3kvxX";
      const OWN_SHELL = "toolu_01QAahgijM2KRBBSkWxnui4g";
      const RESUMED_BASH = "toolu_01CkA1juicPNCtQrqKL8h6Rz";
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      let sequence = 0;
      const system = (frame: object) =>
        claudeSdkFrame({
          type: "system",
          ...frame,
          uuid: `00000000-0000-4000-8000-0000000162${String(++sequence).padStart(2, "0")}`,
          session_id: WAKE_NATIVE_SESSION,
        });
      const agentEntry = (runId: string) => ({
        task_id: TASK_ID,
        run_id: runId,
        task_type: "local_agent",
        subagent_type: "general-purpose",
        description: "Audit recent commits",
      });
      const shellEntry = (taskId: string) => ({
        task_id: taskId,
        run_id: `run-${taskId}`,
        task_type: "local_bash",
        description: "Sleep",
        parent_task_id: TASK_ID,
      });
      const roster = (tasks: ReadonlyArray<object>) =>
        system({ subtype: "background_tasks_changed", tasks });
      const shellStarted = (taskId: string, toolUseId: string) =>
        system({
          subtype: "task_started",
          task_id: taskId,
          tool_use_id: toolUseId,
          task_type: "local_bash",
          description: "Sleep",
        });
      const startTurn = (ordinal: number, continuation: boolean) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-claude-self-resume-${ordinal}`),
            text: continuation ? "Background task completed." : "Launch a background agent.",
            attachments: [],
            providerTurnOrdinal: ordinal,
            ...(continuation
              ? {
                  messageCreatedBy: "agent" as const,
                  messageCreationSource: "provider" as const,
                }
              : {}),
          }),
        );
      const subagentUpdates = () =>
        harness.events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent] : [],
        );

      yield* startTurn(1, false);
      for (const frame of [
        roster([agentEntry("run-1")]),
        makeSubagentTaskStartedFrame({
          taskId: TASK_ID,
          toolUseId: LAUNCH,
          uuid: "00000000-0000-4000-8000-000000016101",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000016102", result: "LAUNCHED" }),
      ]) {
        yield* harness.offerAndWait(frame);
      }
      yield* Queue.take(harness.terminalReceipts);

      // The subagent starts its own background shell, ends its turn, and
      // Claude reports it completed; the parent wakes, answers, goes idle.
      for (const frame of [
        ...makeSubagentAssistantFrames({
          parentToolUseId: LAUNCH,
          uuid: "00000000-0000-4000-8000-000000016103",
          bashToolUseId: OWN_SHELL,
        }),
        roster([agentEntry("run-1"), shellEntry("b455x9pq5")]),
        shellStarted("b455x9pq5", OWN_SHELL),
        makeSubagentToolResultFrame({
          parentToolUseId: LAUNCH,
          uuid: "00000000-0000-4000-8000-000000016104",
          toolUseId: OWN_SHELL,
        }),
        makeSubagentNotificationFrame({
          taskId: TASK_ID,
          toolUseId: LAUNCH,
          summary: "WAITING",
          uuid: "00000000-0000-4000-8000-000000016105",
        }),
        roster([shellEntry("b455x9pq5")]),
        wakeTurnInit,
      ]) {
        yield* harness.offerAndWait(frame);
      }
      yield* Queue.take(harness.continuationReceipts);
      yield* startTurn(2, true);
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000016106", result: "Noted." }),
      );
      yield* Queue.take(harness.terminalReceipts);

      // Its shell finishes and Claude resumes it under a new native run.
      for (const frame of [
        system({
          subtype: "task_notification",
          task_id: "b455x9pq5",
          tool_use_id: OWN_SHELL,
          status: "completed",
          summary: "Background command completed (exit code 0)",
          output_file: "/tmp/b455x9pq5.output",
        }),
        roster([]),
        roster([agentEntry("run-2")]),
        makeSubagentTaskStartedFrame({
          taskId: TASK_ID,
          toolUseId: LAUNCH,
          uuid: "00000000-0000-4000-8000-000000016107",
        }),
      ]) {
        yield* harness.offerAndWait(frame);
      }
      // Events reach the app only through a run, and the launching run ended
      // with the interim completion.
      assert.equal(harness.continuationRequests.length, 2);

      yield* Queue.take(harness.continuationReceipts);
      yield* startTurn(3, true);
      // Claude does not wake the root for this, so the root must not stay busy.
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      yield* startTurn(4, false);
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000016110", result: "PONG" }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      for (const frame of [
        ...makeSubagentAssistantFrames({
          parentToolUseId: LAUNCH,
          uuid: "00000000-0000-4000-8000-000000016108",
          bashToolUseId: RESUMED_BASH,
        }),
        shellStarted("beyhxkdpc", RESUMED_BASH),
        roster([agentEntry("run-2"), shellEntry("beyhxkdpc")]),
      ]) {
        yield* harness.offerAndWait(frame);
      }
      // Events are ordered: once this roster is recorded, so is every earlier event.
      yield* harness.awaitUntil(
        () =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.pendingBackgroundTasks?.some(
                (task) => task.taskId === "beyhxkdpc",
              ) === true,
          ),
        "background roster recorded",
      );
      const resumed = subagentUpdates().at(-1);
      assert.equal(resumed?.status, "running");
      assert.isNull(resumed?.completedAt);
      assert.equal(resumed?.runId, "run-attempt-claude-self-resume-3");
      const routing = subagentRouting(harness.events, [RESUMED_BASH]);
      assert.deepEqual(
        [...(routing.toolThreadIds.get(RESUMED_BASH) ?? [])],
        [routing.childThreadId],
      );

      yield* harness.offerAndWait(
        makeSubagentNotificationFrame({
          taskId: TASK_ID,
          toolUseId: LAUNCH,
          summary: "DONE",
          uuid: "00000000-0000-4000-8000-000000016109",
        }),
      );
      yield* harness.awaitUntil(
        () => subagentUpdates().at(-1)?.result === "DONE",
        "subagent result recorded",
      );
      assert.equal(subagentUpdates().at(-1)?.status, "completed");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
