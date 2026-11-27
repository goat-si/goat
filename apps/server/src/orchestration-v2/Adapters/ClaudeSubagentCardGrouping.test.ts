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
  makeSubagentNotificationFrame,
  makeSubagentTaskStartedFrame,
  WAKE_NATIVE_SESSION,
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

it.effect("keeps a background subagent's card on the turn that launched it", () =>
  Effect.gen(function* () {
    const FIRST_TASK = "task-card-turn-a";
    const FIRST_TOOL = "toolu-card-turn-a";
    const SECOND_TASK = "task-card-turn-b";
    const SECOND_TOOL = "toolu-card-turn-b";
    const harness = yield* makeWakeHarnessWithOptions();
    const now = yield* DateTime.now;
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-card-turn-1"),
        text: "Audit in the background.",
        attachments: [],
      }),
    );
    for (const frame of [
      makeSubagentTaskStartedFrame({
        taskId: FIRST_TASK,
        toolUseId: FIRST_TOOL,
        uuid: "00000000-0000-4000-8000-000000000a51",
      }),
      makeSubagentTaskStartedFrame({
        taskId: SECOND_TASK,
        toolUseId: SECOND_TOOL,
        uuid: "00000000-0000-4000-8000-000000000a52",
      }),
      claudeSdkFrame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: FIRST_TASK, task_type: "local_agent", description: "Audit" },
          { task_id: SECOND_TASK, task_type: "local_agent", description: "Audit" },
        ],
        uuid: "00000000-0000-4000-8000-000000000a53",
        session_id: WAKE_NATIVE_SESSION,
      }),
      makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000a54",
        result: "Auditing in the background.",
      }),
    ]) {
      yield* Queue.offer(harness.sdkMessages, frame);
    }
    yield* harness.awaitTerminal(1);

    yield* Queue.offer(
      harness.sdkMessages,
      makeSubagentNotificationFrame({
        taskId: FIRST_TASK,
        toolUseId: FIRST_TOOL,
        summary: "Audit done.",
        uuid: "00000000-0000-4000-8000-000000000a55",
      }),
    );
    yield* Queue.take(harness.continuationReceipts);
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-card-turn-2"),
        text: "Background task completed.",
        attachments: [],
        providerTurnOrdinal: 2,
        messageCreatedBy: "agent",
        messageCreationSource: "provider",
      }),
    );
    for (const frame of [
      claudeSdkFrame({
        type: "system",
        subtype: "task_progress",
        task_id: SECOND_TASK,
        description: "Reading the last commits",
        uuid: "00000000-0000-4000-8000-000000000a56",
        session_id: WAKE_NATIVE_SESSION,
      }),
      makeSubagentNotificationFrame({
        taskId: SECOND_TASK,
        toolUseId: SECOND_TOOL,
        summary: "Audit done.",
        uuid: "00000000-0000-4000-8000-000000000a57",
      }),
      makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000a58",
        result: "Both auditors finished.",
      }),
    ]) {
      yield* Queue.offer(harness.sdkMessages, frame);
    }
    yield* harness.awaitTerminal(2);

    const cards = harness.events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "subagent"
        ? [event.turnItem]
        : [],
    );
    const turnIds = harness.events.flatMap((event) =>
      event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
    );
    assert.equal(new Set(turnIds).size, 2);
    assert.equal(new Set(cards.map((card) => card.subagentId)).size, 2);
    assert.equal(cards.filter((card) => card.status === "completed").length, 2);
    assert.deepEqual(
      [...new Set(cards.map((card) => card.providerTurnId))],
      [cards[0]?.providerTurnId],
    );
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
