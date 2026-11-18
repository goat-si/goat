import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
  turnOneResult,
  WAKE_NATIVE_SESSION,
  wakeAssistant,
  wakeNotification,
  wakeResult,
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

it.effect("keeps a newer wake's output when a stale continuation request is cleared", () =>
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

      yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
      yield* harness.offerAndWait(
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000000135",
          text: "Second build done.",
        }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000136",
          result: "Second build done.",
          origin: { kind: "task-notification" },
        }),
      );
      assert.lengthOf(harness.continuationRequests, 2);
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-stale-clear-3"),
          text: "Background task completed.",
          attachments: [],
          providerTurnOrdinal: 3,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
        }),
      );
      yield* harness.awaitTerminal(3);
      assert.isTrue(
        harness.events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "Second build done.",
        ),
        "clearing the first wake's request must not discard the second wake's output",
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("offers the next wake when a cancelled wake's release arrives after it opened", () =>
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
          attemptId: RunAttemptId.make("attempt-claude-wake-late-release"),
          text: "Run two builds in the background.",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(wakeTaskStarted);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeTaskStarted,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000141",
        }),
      );
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* harness.offerAndWait(wakeNotification);
      yield* harness.offerAndWait(wakeTurnInit);
      yield* harness.offerAndWait(wakeAssistant);
      yield* harness.offerAndWait(wakeResult);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeNotification,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000142",
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000143" }),
      );
      assert.lengthOf(harness.continuationRequests, 1);

      yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeAssistant, uuid: "00000000-0000-4000-8000-000000000144" }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000145", result: "Done." }),
      );
      assert.lengthOf(
        harness.continuationRequests,
        2,
        "the wake that opened before the cancelled wake's release must get its own continuation",
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("does not offer a wake again when it is cancelled before its first root frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-early-cancel"),
          text: "Start an agent in the background.",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(claudeSdkFrame({ ...wakeTaskStarted, task_type: "local_agent" }));
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* harness.offerAndWait(wakeNotification);
      assert.lengthOf(harness.continuationRequests, 1);
      yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
      yield* harness.offerAndWait(wakeTurnInit);
      yield* harness.offerAndWait(wakeAssistant);
      yield* harness.offerAndWait(wakeResult);
      assert.lengthOf(
        harness.continuationRequests,
        1,
        "the cancelled wake must not be offered again",
      );

      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000146" }),
      );
      assert.lengthOf(harness.continuationRequests, 2, "the next wake must be offered");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("offers a later task's wake when a cancelled wake never opens", () =>
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
          attemptId: RunAttemptId.make("attempt-claude-wake-never-opens"),
          text: "Start an agent and a build in the background.",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(claudeSdkFrame({ ...wakeTaskStarted, task_type: "local_agent" }));
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeTaskStarted,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000151",
        }),
      );
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);

      // Claude never opens a wake for the agent's notification.
      yield* harness.offerAndWait(wakeNotification);
      assert.lengthOf(harness.continuationRequests, 1);
      yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();

      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeNotification,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          output_file: `/tmp/claude-replay/tasks/${SECOND_TASK_ID}.output`,
          uuid: "00000000-0000-4000-8000-000000000152",
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000153" }),
      );
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000154", text: "Built." }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000155", result: "Built." }),
      );
      assert.lengthOf(
        harness.continuationRequests,
        2,
        "the build's wake must get its own continuation",
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect.each([
  { ending: "notification", cancelled: "after its result" },
  { ending: "tool result", cancelled: "after its result" },
  { ending: "tool result", cancelled: "while the subagent ran" },
] as const)(
  "does not replay a subagent that finished inside a cancelled wake (ended by $ending, cancelled $cancelled)",
  ({ ending, cancelled }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const SECOND_TASK_ID = "b2ndwake";
        const SECOND_TOOL_USE_ID = "toolu_second_wake";
        const SUBAGENT_TASK_ID = "fg-agent";
        const SUBAGENT_TOOL_USE_ID = "toolu-fg-agent";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-finished-subagent"),
            text: "Run two builds in the background.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(wakeTaskStarted);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...wakeTaskStarted,
            task_id: SECOND_TASK_ID,
            tool_use_id: SECOND_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000161",
          }),
        );
        yield* harness.offerAndWait(turnOneResult);
        yield* harness.awaitTerminal(1);

        // The first wake runs a subagent to completion before its result.
        yield* harness.offerAndWait(wakeNotification);
        yield* harness.offerAndWait(wakeTurnInit);
        assert.lengthOf(harness.continuationRequests, 1);
        yield* harness.offerAndWait(wakeAssistant);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Inspect build output",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Inspect the build output.",
            uuid: "00000000-0000-4000-8000-000000000162",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...makeAssistantTextFrame({
              uuid: "00000000-0000-4000-8000-000000000168",
              text: "Reading the build log.",
            }),
            parent_tool_use_id: SUBAGENT_TOOL_USE_ID,
          }),
        );
        if (cancelled === "while the subagent ran") {
          yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
        }
        yield* harness.offerAndWait(
          ending === "notification"
            ? claudeSdkFrame({
                type: "system",
                subtype: "task_notification",
                task_id: SUBAGENT_TASK_ID,
                tool_use_id: SUBAGENT_TOOL_USE_ID,
                status: "completed",
                output_file: "/tmp/fg-agent.output",
                summary: "Inspected",
                uuid: "00000000-0000-4000-8000-000000000163",
                session_id: WAKE_NATIVE_SESSION,
              })
            : claudeSdkFrame({
                type: "user",
                uuid: "00000000-0000-4000-8000-000000000163",
                session_id: WAKE_NATIVE_SESSION,
                parent_tool_use_id: null,
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: SUBAGENT_TOOL_USE_ID,
                      content: "Inspected",
                    },
                  ],
                },
              }),
        );
        yield* harness.offerAndWait(wakeResult);
        if (cancelled === "after its result") {
          yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
        }

        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...wakeNotification,
            task_id: SECOND_TASK_ID,
            tool_use_id: SECOND_TOOL_USE_ID,
            output_file: `/tmp/claude-replay/tasks/${SECOND_TASK_ID}.output`,
            uuid: "00000000-0000-4000-8000-000000000164",
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000165" }),
        );
        assert.lengthOf(harness.continuationRequests, 2);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-finished-subagent-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000166",
            text: "Second build done.",
          }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000167",
            result: "Second build done.",
            origin: { kind: "task-notification" },
          }),
        );
        yield* harness.awaitTerminal(2);

        const subagentStatuses = harness.events.flatMap((event) =>
          event.type === "subagent.updated" &&
          event.subagent.nativeTaskRef?.nativeId === SUBAGENT_TASK_ID
            ? [event.subagent.status]
            : [],
        );
        assert.notInclude(
          subagentStatuses,
          "running",
          "a subagent that finished in the cancelled wake must not be replayed as running",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect("offers a cancelled wake once when an empty lifecycle result precedes its turn", () =>
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
          attemptId: RunAttemptId.make("attempt-claude-wake-empty-lifecycle"),
          text: "Run two builds in the background.",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(wakeTaskStarted);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeTaskStarted,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000171",
        }),
      );
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* harness.offerAndWait(wakeNotification);
      yield* harness.offerAndWait(wakeTurnInit);
      assert.lengthOf(harness.continuationRequests, 1);
      yield* harness.offerAndWait(
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000172",
          result: "",
          numTurns: 0,
          origin: { kind: "task-notification" },
          terminalReason: null,
        }),
      );
      yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000173" }),
      );
      yield* harness.offerAndWait(wakeAssistant);
      yield* harness.offerAndWait(wakeResult);
      assert.lengthOf(
        harness.continuationRequests,
        1,
        "the cancelled wake must not be offered again",
      );

      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...wakeNotification,
          task_id: SECOND_TASK_ID,
          tool_use_id: SECOND_TOOL_USE_ID,
          output_file: `/tmp/claude-replay/tasks/${SECOND_TASK_ID}.output`,
          uuid: "00000000-0000-4000-8000-000000000174",
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000175" }),
      );
      assert.lengthOf(harness.continuationRequests, 2, "the next wake must be offered");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("does not offer a cancelled wake again for its trailing empty lifecycle result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-trailing-lifecycle"),
          text: "Run a build in the background.",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(wakeTaskStarted);
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);

      yield* harness.offerAndWait(wakeNotification);
      yield* harness.offerAndWait(wakeTurnInit);
      yield* harness.offerAndWait(wakeAssistant);
      yield* harness.offerAndWait(wakeResult);
      yield* harness.offerAndWait(
        claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000176" }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000177",
          result: "",
          numTurns: 0,
          origin: { kind: "task-notification" },
          terminalReason: null,
        }),
      );
      assert.lengthOf(harness.continuationRequests, 1);
      yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
      assert.lengthOf(
        harness.continuationRequests,
        1,
        "a lifecycle result after the cancelled wake must not open another continuation",
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect.each([
  "before the cancelled wake's result",
  "after the cancelled wake's result",
] as const)(
  "offers a subagent's wake that arrives behind a cancelled wake (notified %s)",
  (notified) =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "bg-agent";
        const SUBAGENT_TOOL_USE_ID = "toolu-bg-agent";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-later-subagent"),
            text: "Run a build and an agent in the background.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(wakeTaskStarted);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...wakeTaskStarted,
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            task_type: "local_agent",
            uuid: "00000000-0000-4000-8000-000000000181",
          }),
        );
        yield* harness.offerAndWait(turnOneResult);
        yield* harness.awaitTerminal(1);

        const subagentNotification = claudeSdkFrame({
          ...wakeNotification,
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          output_file: `/tmp/claude-replay/tasks/${SUBAGENT_TASK_ID}.output`,
          summary: "Agent finished",
          uuid: "00000000-0000-4000-8000-000000000182",
        });
        yield* harness.offerAndWait(wakeNotification);
        yield* harness.offerAndWait(wakeTurnInit);
        yield* harness.offerAndWait(wakeAssistant);
        assert.lengthOf(harness.continuationRequests, 1);
        if (notified === "before the cancelled wake's result") {
          yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
          yield* harness.offerAndWait(subagentNotification);
          yield* harness.offerAndWait(wakeResult);
        } else {
          yield* harness.offerAndWait(wakeResult);
          yield* harness.offerAndWait(subagentNotification);
          yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
        }
        assert.lengthOf(
          harness.continuationRequests,
          2,
          "the subagent's wake must get its own continuation",
        );
        assert.equal(harness.continuationRequests[1]?.detail, "Agent finished");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect.each(["before", "after"] as const)(
  "offers a later wake when a wake a user turn absorbed is cancelled %s that turn ends",
  (cancelled) =>
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
            attemptId: RunAttemptId.make("attempt-claude-wake-absorbed-cancel-1"),
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
            uuid: "00000000-0000-4000-8000-000000000191",
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        yield* harness.offerAndWait(wakeTurnInit);
        yield* harness.offerAndWait(wakeAssistant);
        yield* harness.awaitUntil(
          () => harness.continuationRequests.length >= 1,
          "continuation request",
        );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-absorbed-cancel-2"),
            text: "Any update on the pull request?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* harness.awaitUntil(() => harness.offeredMessages.length === 2, "wake state");
        if (cancelled === "before") {
          yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
        }
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000192",
            result: "Checks passed and the pull request is up to date.",
          }),
        );
        yield* harness.awaitTerminal(2);
        if (cancelled === "after") {
          yield* harness.continuationRequests[0]!.onRunEndedWithoutStarting!();
        }

        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...wakeNotification,
            task_id: SECOND_TASK_ID,
            tool_use_id: SECOND_TOOL_USE_ID,
            output_file: `/tmp/claude-replay/tasks/${SECOND_TASK_ID}.output`,
            uuid: "00000000-0000-4000-8000-000000000193",
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000194" }),
        );
        assert.lengthOf(harness.continuationRequests, 2, "the later wake must be offered");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);
