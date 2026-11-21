import { RunAttemptId } from "@goat/contracts";
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
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
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

it.effect.each(["other lifecycle", "unrelated status"] as const)(
  "keeps the unanswered watchdog armed after %s",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions();
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`unanswered-${kind}`),
            text: "Hello",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state: "started",
            uuid: "00000000-0000-4000-8000-000000000801",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const frame =
          kind === "other lifecycle"
            ? {
                type: "command_lifecycle",
                command_uuid: "00000000-0000-4000-8000-000000000999",
                state: "completed",
                uuid: "00000000-0000-4000-8000-000000000802",
                session_id: WAKE_NATIVE_SESSION,
              }
            : {
                type: "system",
                subtype: "status",
                status: null,
                uuid: "00000000-0000-4000-8000-000000000803",
                session_id: WAKE_NATIVE_SESSION,
              };
        yield* harness.offerAndWait(claudeSdkFrame(frame));
        yield* TestClock.adjust("11 minutes");
        const terminal = harness.terminalEvents();
        assert.equal(terminal.length, 1);
        if (terminal[0]?.status !== "failed")
          throw new Error("Expected unanswered request failure");
        assert.equal(terminal[0].failure.code, "claude_request_unanswered");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect("clears the unanswered watchdog for the current prompt's answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("unanswered-answer"),
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(0),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000000811",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000812",
            text: "Working.",
          }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* TestClock.adjust("11 minutes");
      assert.isEmpty(harness.terminalEvents());
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("keeps the watchdog armed for an answer explicitly tied to another prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("foreign-answer"),
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(0),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000000821",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000822",
            text: "First answer",
          }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: "00000000-0000-4000-8000-000000000823",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000824",
            text: "Other answer",
          }),
          user_message_uuid: "00000000-0000-4000-8000-000000000999",
        }),
      );
      yield* TestClock.adjust("11 minutes");
      const terminal = harness.terminalEvents();
      assert.equal(terminal.length, 1);
      if (terminal[0]?.status !== "failed") throw new Error("Expected unanswered request failure");
      assert.equal(terminal[0].failure.code, "claude_request_unanswered");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
