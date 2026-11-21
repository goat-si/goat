import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

it.effect("reports zero context after Claude resets its conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const turn = (attempt: string, text: string) =>
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: DateTime.makeUnsafe(0),
          attemptId: RunAttemptId.make(attempt),
          text,
          attachments: [],
        });
      const usage = {
        input_tokens: 166_000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      yield* harness.runtime.startTurn(turn("before-reset", "Continue"));
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: "before",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Working" }],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000800",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000801", result: "Done." }),
      );
      yield* Queue.take(harness.terminalReceipts);
      yield* harness.runtime.startTurn(turn("reset", "/clear"));
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "conversation_reset",
          trigger: "clear",
          new_conversation_id: "00000000-0000-4000-8000-000000000802",
          uuid: "00000000-0000-4000-8000-000000000803",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000805",
          result: "",
          numTurns: 0,
          usage: { ...usage, input_tokens: 0, output_tokens: 0 },
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const reports = harness.events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
          ? [
              {
                attempt: event.providerTurn.runAttemptId,
                used: event.providerTurn.tokenUsage.usedTokens,
              },
            ]
          : [],
      );
      assert.deepEqual(reports.at(-1), { attempt: RunAttemptId.make("reset"), used: 0 });
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
