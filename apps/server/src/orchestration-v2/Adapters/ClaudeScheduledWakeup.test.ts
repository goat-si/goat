import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { RunAttemptId } from "@goat/contracts";
import { backgroundWorkHoldsCompletion } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
  wakeAssistant,
  wakeNotification,
  wakeResult,
  turnOneResult,
  wakeTaskStarted,
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
const providerThreadRosterEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<
      ProviderAdapter.ProviderAdapterV2Event,
      { type: "provider_thread.updated" }
    > => event.type === "provider_thread.updated",
  );

const scheduleWakeupFrames = (input: {
  readonly toolUseId: string;
  readonly uuids: readonly [string, string];
  readonly toolInput: Record<string, unknown>;
  readonly scheduledFor: number;
}) => [
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.toolUseId}`,
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: input.toolUseId, name: "ScheduleWakeup", input: input.toolInput },
      ],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: input.uuids[0],
    session_id: WAKE_NATIVE_SESSION,
  }),
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "Scheduled." }],
    },
    parent_tool_use_id: null,
    uuid: input.uuids[1],
    session_id: WAKE_NATIVE_SESSION,
    tool_use_result: {
      scheduledFor: input.scheduledFor,
      clampedDelaySeconds: 60,
      wasClamped: false,
    },
  }),
];

const startScheduleWakeupTurn = Effect.fnUntraced(function* (
  harness: Effect.Success<typeof makeWakeHarness>,
  result = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000002103",
    result: "Scheduled.",
  }),
) {
  const now = yield* DateTime.now;
  yield* harness.runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now,
      attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-1"),
      text: "Wake up in a minute.",
      attachments: [],
    }),
  );
  for (const frame of scheduleWakeupFrames({
    toolUseId: "toolu_schedule_wakeup_1",
    uuids: ["00000000-0000-4000-8000-000000002101", "00000000-0000-4000-8000-000000002102"],
    toolInput: { delaySeconds: 60, prompt: "say WOKE", reason: "wake", noop: false },
    scheduledFor: DateTime.toEpochMillis(now) + 60_000,
  })) {
    yield* Queue.offer(harness.sdkMessages, frame);
  }
  yield* Queue.offer(harness.sdkMessages, result);
  yield* harness.awaitTerminal(1);
});

const publishedRoster = (harness: Effect.Success<typeof makeWakeHarness>) =>
  providerThreadRosterEvents(harness.events).at(-1)?.providerThread.pendingBackgroundTasks ?? [];

it.effect.each([
  { rescheduled: false, firedAfter: "60 seconds" },
  { rescheduled: true, firedAfter: "60 seconds" },
  // Claude fires one-shot wakeups early, so the wake init can precede scheduledFor.
  { rescheduled: false, firedAfter: "30 seconds" },
] as const)(
  "a fired ScheduleWakeup holds completion only while its wake turn reschedules (rescheduled=$rescheduled, fired after $firedAfter)",
  ({ rescheduled, firedAfter }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* startScheduleWakeupTurn(harness);
        assert.isTrue(backgroundWorkHoldsCompletion(publishedRoster(harness)));
        assert.isTrue(
          yield* harness.hasPendingBackgroundWork,
          "a wakeup past the idle timeout must keep the session from being released",
        );

        yield* TestClock.adjust(firedAfter);
        yield* harness.offerAndWait(wakeTurnInit);
        yield* harness.awaitUntil(
          () => harness.continuationRequests.length >= 1,
          "continuation requested",
        );
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-2"),
            text: "say WOKE",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        if (rescheduled) {
          for (const frame of scheduleWakeupFrames({
            toolUseId: "toolu_schedule_wakeup_2",
            uuids: ["00000000-0000-4000-8000-000000002201", "00000000-0000-4000-8000-000000002202"],
            toolInput: { delaySeconds: 60, prompt: "say WOKE", reason: "loop", noop: false },
            scheduledFor: DateTime.toEpochMillis(now) + 60_000,
          })) {
            yield* harness.offerAndWait(frame);
          }
        }
        yield* harness.offerAndWait(
          makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000002203", text: "WOKE" }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002204", result: "WOKE" }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.equal(backgroundWorkHoldsCompletion(publishedRoster(harness)), rescheduled);
        assert.equal(yield* harness.hasPendingBackgroundWork, rescheduled);
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect("a user turn before the wakeup fires keeps the pending wakeup's hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* startScheduleWakeupTurn(harness);
      yield* TestClock.adjust("10 seconds");
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-user"),
          text: "What time is it?",
          attachments: [],
          providerTurnOrdinal: 2,
        }),
      );
      yield* harness.offerAndWait(wakeTurnInit);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000002401", text: "Noon." }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002402", result: "Noon." }),
      );
      yield* harness.awaitTerminal(2);
      assert.equal(harness.terminalEvents()[1]?.status, "completed");
      assert.isTrue(backgroundWorkHoldsCompletion(publishedRoster(harness)));
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("a task notification waking Claude just before the wakeup keeps its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-task"),
          text: "Run the build in the background and check back in two minutes.",
          attachments: [],
        }),
      );
      yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
      for (const frame of scheduleWakeupFrames({
        toolUseId: "toolu_schedule_wakeup_fallback",
        uuids: ["00000000-0000-4000-8000-000000002501", "00000000-0000-4000-8000-000000002502"],
        toolInput: { delaySeconds: 120, prompt: "check the build", reason: "fallback" },
        scheduledFor: DateTime.toEpochMillis(now) + 120_000,
      })) {
        yield* Queue.offer(harness.sdkMessages, frame);
      }
      yield* Queue.offer(harness.sdkMessages, turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* TestClock.adjust("60 seconds");
      // Claude runs an empty turn for the notification and opens the real one right after,
      // both before the wake run attaches.
      yield* harness.offerAndWait(wakeNotification);
      yield* Queue.offer(harness.sdkMessages, wakeTurnInit);
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000002503",
          result: "",
          numTurns: 0,
          origin: { kind: "task-notification" },
          terminalReason: null,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000002504" }),
      );
      yield* harness.awaitUntil(
        () => harness.continuationRequests.length >= 1,
        "continuation requested",
      );
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-task-2"),
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
      assert.equal(harness.terminalEvents()[1]?.status, "completed");
      assert.isTrue(
        backgroundWorkHoldsCompletion(publishedRoster(harness)),
        "the wakeup is still pending after the task notification's wake turn",
      );
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect.each([{ emptyResult: true }, { emptyResult: false }])(
  "an early wakeup after an idle task notification releases its hold (empty result: $emptyResult)",
  ({ emptyResult }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-notified"),
            text: "Run the build in the background and check back in two minutes.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        for (const frame of scheduleWakeupFrames({
          toolUseId: "toolu_schedule_wakeup_notified",
          uuids: ["00000000-0000-4000-8000-000000002601", "00000000-0000-4000-8000-000000002602"],
          toolInput: { delaySeconds: 120, prompt: "check the build", reason: "fallback" },
          scheduledFor: DateTime.toEpochMillis(now) + 120_000,
        })) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);

        yield* TestClock.adjust("10 seconds");
        yield* harness.offerAndWait(wakeNotification);
        if (emptyResult) {
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000002603",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );
        }

        yield* TestClock.adjust("80 seconds");
        yield* harness.offerAndWait(wakeTurnInit);
        yield* harness.awaitUntil(
          () => harness.continuationRequests.length >= 1,
          "continuation requested",
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-notified-2"),
            text: "check the build",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000002604",
            text: "Built.",
          }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002605", result: "Built." }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(backgroundWorkHoldsCompletion(publishedRoster(harness)));
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect("a failed turn on a live Claude process keeps the pending wakeup's hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* startScheduleWakeupTurn(
        harness,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000002103",
          result: "API Error: 529 overloaded",
          subtype: "error_during_execution",
          isError: true,
          errors: ["API Error: 529 overloaded"],
          terminalReason: "model_error",
        }),
      );
      assert.equal(harness.terminalEvents()[0]?.status, "failed");
      assert.isTrue(backgroundWorkHoldsCompletion(publishedRoster(harness)));
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("ScheduleWakeup stop:true releases the pending wakeup's hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-schedule-wakeup-stop"),
          text: "Schedule a wakeup, then cancel it.",
          attachments: [],
        }),
      );
      const frames = [
        ...scheduleWakeupFrames({
          toolUseId: "toolu_schedule_wakeup_set",
          uuids: ["00000000-0000-4000-8000-000000002301", "00000000-0000-4000-8000-000000002302"],
          toolInput: { delaySeconds: 60, prompt: "say WOKE", reason: "wake", noop: false },
          scheduledFor: DateTime.toEpochMillis(now) + 60_000,
        }),
        ...scheduleWakeupFrames({
          toolUseId: "toolu_schedule_wakeup_stop",
          uuids: ["00000000-0000-4000-8000-000000002303", "00000000-0000-4000-8000-000000002304"],
          toolInput: { stop: true },
          scheduledFor: 0,
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002305", result: "Cancelled." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      yield* harness.awaitTerminal(1);
      assert.isFalse(backgroundWorkHoldsCompletion(publishedRoster(harness)));
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("Stop on a thread waiting for a ScheduleWakeup closes Claude and drops the hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let closes = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) =>
          Effect.sync(() => {
            closes++;
          }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
      });
      yield* startScheduleWakeupTurn(harness);
      const settledThread = providerThreadRosterEvents(harness.events).at(-1)?.providerThread;
      assert.isTrue(backgroundWorkHoldsCompletion(settledThread?.pendingBackgroundTasks ?? []));
      // The wakeup alone must not refuse a model or mode change.
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWorkForThread!(settledThread!));

      yield* harness.runtime.interruptTurn({
        providerThread: settledThread ?? harness.providerThread,
        providerTurnId: harness.terminalEvents()[0]!.providerTurnId,
        requestRuntimeRestart: true,
      });

      assert.equal(closes, 1, "the wakeup lives in the CLI process, so Stop must close it");
      yield* harness.awaitUntil(() => publishedRoster(harness).length === 0, "roster cleared");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
