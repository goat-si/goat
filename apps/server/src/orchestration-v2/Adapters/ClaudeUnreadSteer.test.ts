import { assert, describe, it } from "@effect/vitest";
import { MessageId, RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  makeAssistantTextFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
const makeWakeHarness = makeWakeHarnessWithOptions();
describe("Claude unread steers", () => {
  // A steer Claude starts after holding the result answers in this turn, so dropping another
  // steer then must not end the turn under it.
  it.effect("keeps the turn open for a started steer when Claude drops another", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attemptId = RunAttemptId.make("attempt-steer-dropped");
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId,
        text: "Run the build.",
        attachments: [],
      });
      yield* harness.runtime.startTurn(input);
      for (const id of ["message-steer-started", "message-steer-dropped"]) {
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
            messageId: MessageId.make(id),
            text: `Steer ${id}`,
            attachments: [],
          },
        });
      }
      const lifecycle = (index: number, state: string, uuid: string) =>
        Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(index),
            state,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002500", result: "Built." }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* lifecycle(1, "started", "00000000-0000-4000-8000-000000002501");
      yield* lifecycle(2, "cancelled", "00000000-0000-4000-8000-000000002502");
      yield* Queue.offer(
        harness.sdkMessages,
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000002503",
          text: "Steer reply.",
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002504", result: "Done." }),
          user_message_uuid: harness.promptUuid(1),
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const reply = harness.events.find(
        (event) => event.type === "message.updated" && event.message.text === "Steer reply.",
      );
      assert.equal(reply?.type === "message.updated" ? reply.message.runId : null, input.runId);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "steer.updated" ? [[event.messageId, event.status]] : [],
        ),
        [
          ["message-steer-started", "pending"],
          ["message-steer-dropped", "pending"],
          ["message-steer-started", "completed"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
  );

  it.effect("keeps both result-only replies of a steered turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attemptId = RunAttemptId.make("attempt-steer-result-only");
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId,
        text: "Run the build.",
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
          messageId: MessageId.make("message-steer-result-only"),
          text: "Steer",
          attachments: [],
        },
      });
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002510", result: "Built." }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(1),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000002511",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002512", result: "Done." }),
          user_message_uuid: harness.promptUuid(1),
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const replies = harness.events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [event.message.text]
          : [],
      );
      assert.equal(replies.at(-1), "Built.\n\nDone.");
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
  );
});
