import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageId, RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
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

// regression: #23948 Claude holds a steer behind a running foreground tool
// call and goes silent, so each steer stays pending until Claude starts it.
it.effect("keeps a steer pending until Claude starts it", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attemptId = RunAttemptId.make("attempt-steer-waiting");
    const input = makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId,
      text: "Run the slow build.",
      attachments: [],
    });
    yield* harness.runtime.startTurn(input);
    const steer = (id: string) =>
      harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        }),
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(id),
          text: `Steer ${id}`,
          attachments: [],
        },
      });
    yield* steer("message-steer-read");
    yield* steer("message-steer-unread");
    const steerStatuses = () => {
      const latest = new Map<string, string>();
      for (const event of harness.events) {
        if (event.type === "steer.updated") latest.set(event.messageId, event.status);
      }
      return Object.fromEntries(latest);
    };
    const expectSteers = (expected: Record<string, string>) =>
      harness
        .awaitUntil(
          () => JSON.stringify(steerStatuses()) === JSON.stringify(expected),
          "steer statuses recorded",
        )
        .pipe(Effect.andThen(Effect.sync(() => assert.deepEqual(steerStatuses(), expected))));

    // Claude keeps streaming the foreground tool's turn; once its text is
    // recorded, anything the steers emitted before it is recorded too.
    yield* harness.offerAndWait(
      makeAssistantTextFrame({
        uuid: "00000000-0000-4000-8000-000000002392",
        text: "Still building.",
      }),
    );
    yield* harness.awaitUntil(
      () =>
        harness.events.some(
          (event) => event.type === "message.updated" && event.message.text === "Still building.",
        ),
      "foreground text recorded",
    );
    assert.deepEqual(steerStatuses(), {
      "message-steer-read": "pending",
      "message-steer-unread": "pending",
    });

    const lifecycle = (index: number, state: string, uuid: string) =>
      harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(index),
          state,
          uuid,
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
    // Claude completes prompts it never started, so completed alone is not
    // proof it read one.
    yield* lifecycle(2, "completed", "00000000-0000-4000-8000-000000002393");
    yield* lifecycle(1, "started", "00000000-0000-4000-8000-000000002394");
    yield* expectSteers({
      "message-steer-read": "completed",
      "message-steer-unread": "pending",
    });

    yield* harness.offerAndWait(
      claudeSdkFrame({
        ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002395", result: "Built." }),
        user_message_uuid: harness.promptUuid(0),
      }),
    );
    yield* harness.awaitTerminal(1);
    yield* expectSteers({
      "message-steer-read": "completed",
      "message-steer-unread": "completed",
    });
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

// Claude can answer a steer while its offer is still being logged.
it.effect("settles a turn whose result echoes only a steer before the offer returns", () =>
  Effect.gen(function* () {
    let settleDuringOffer: (message: SDKUserMessage) => Effect.Effect<void> = () => Effect.void;
    const harness = yield* makeWakeHarnessWithOptions({
      offer: (message) =>
        message.priority === "now" ? Effect.suspend(() => settleDuringOffer(message)) : Effect.void,
    });
    settleDuringOffer = (message) =>
      harness
        .offerAndWait(
          claudeSdkFrame({
            ...makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000002396",
              result: "Built.",
            }),
            user_message_uuid: message.uuid,
          }),
        )
        .pipe(Effect.andThen(harness.awaitTerminal(1)));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attemptId = RunAttemptId.make("attempt-steer-result");
    const input = makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId,
      text: "Run the slow build.",
      attachments: [],
    });
    yield* harness.runtime.startTurn(input);
    yield* harness.runtime.steerTurn({
      threadId: harness.threadId,
      runId: input.runId,
      providerThread: harness.providerThread,
      providerTurnId: idAllocator.derive.providerTurn({
        driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
        nativeTurnId: `turn:${attemptId}`,
      }),
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message-steer-result"),
        text: "Steer",
        attachments: [],
      },
    });
    assert.deepEqual(
      harness.events.flatMap((event) => (event.type === "steer.updated" ? [event.status] : [])),
      ["pending", "completed"],
    );
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

// regression: #15708 Stop must not silently drop a steer Claude queued behind a foreground task
it.effect.each([
  {
    readBy: "none",
    echoes: true,
    title: "warns that a steer Claude never read before Stop was not delivered",
  },
  {
    readBy: "none",
    echoes: false,
    title: "does not warn about a steer on a CLI that never echoes prompt uuids",
  },
  {
    readBy: "assistant",
    echoes: true,
    title: "does not warn about a steer Claude read before Stop",
  },
] as const)("$title", ({ readBy, echoes }) =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions({
      close: (sdkMessages) => Queue.shutdown(sdkMessages),
      freshQueueOnReopen: true,
    });
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const firstInput = makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-unread-steer-1"),
      text: "Run the slow curl in the foreground.",
      attachments: [],
    });
    yield* harness.runtime.startTurn(firstInput);
    const providerTurnId = idAllocator.derive.providerTurn({
      driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
      nativeTurnId: `turn:${firstInput.attemptId}`,
    });
    yield* harness.offerAndWait(
      claudeSdkFrame({
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000015701",
        session_id: WAKE_NATIVE_SESSION,
        parent_tool_use_id: null,
        ...(echoes ? { user_message_uuids: [harness.promptUuid(0)] } : {}),
        message: {
          id: "msg_unread_steer_bash",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu-unread-steer-bash",
              name: "Bash",
              input: { command: "curl http://127.0.0.1:9/hang" },
            },
          ],
        },
      }),
    );
    // Past task_started the CLI queues a "now" steer until the call returns.
    yield* harness.offerAndWait(
      claudeSdkFrame({
        type: "system",
        subtype: "task_started",
        task_id: "task-unread-steer-bash",
        tool_use_id: "toolu-unread-steer-bash",
        description: "Slow curl",
        is_backgrounded: false,
        task_type: "local_bash",
        uuid: "00000000-0000-4000-8000-000000015702",
        session_id: WAKE_NATIVE_SESSION,
      }),
    );
    const steerText = "Codeword: PELICAN. Remember it, I will ask for it later.";
    yield* harness.runtime.steerTurn({
      threadId: harness.threadId,
      runId: firstInput.runId,
      providerThread: harness.providerThread,
      providerTurnId,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("unread-steer"),
        text: steerText,
        attachments: [],
      },
    });
    const steerUuid = harness.offeredMessages.at(-1)?.uuid;
    assert.isDefined(steerUuid);
    if (readBy === "assistant") {
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          uuid: "00000000-0000-4000-8000-000000015703",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          user_message_uuids: [steerUuid],
          message: {
            id: "msg_unread_steer_reply",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Noted." }],
          },
        }),
      );
    }
    const noticesBefore = harness.events.length;
    yield* harness.runtime.interruptTurn({
      providerThread: harness.providerThread,
      providerTurnId,
    });
    assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");

    const notices = harness.events
      .slice(noticesBefore)
      .flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem.message]
          : [],
      );
    const undelivered = notices.find((message) =>
      /not (have )?(been )?delivered|never (reached|delivered)/i.test(message ?? ""),
    );
    if (readBy !== "none" || !echoes) {
      assert.isUndefined(undelivered);
      return;
    }
    assert.isDefined(
      undelivered,
      `expected an undelivered-steer notice, got ${JSON.stringify(notices)}`,
    );
    assert.match(undelivered ?? "", /resend|send it again|re-send/i);
    assert.include(undelivered, "PELICAN");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
