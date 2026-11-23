import { assert, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";

it.effect("uses distinct plan ids when Claude reuses a tool id in a later turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    const now = yield* DateTime.now;
    for (const ordinal of [1, 2]) {
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`plan-turn-${ordinal}`),
          providerTurnOrdinal: ordinal,
          text: "Plan",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          uuid: `00000000-0000-4000-8000-00000000050${ordinal}`,
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: `plan-message-${ordinal}`,
            model: "claude-sonnet-4-6",
            type: "message",
            role: "assistant",
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            content: [
              {
                type: "tool_use",
                id: "same-tool",
                name: "TodoWrite",
                input: { todos: [{ content: "work", status: "in_progress" }] },
              },
            ],
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "user",
          uuid: `00000000-0000-4000-8000-00000000051${ordinal}`,
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "same-tool", content: "ok" }],
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: `00000000-0000-4000-8000-00000000052${ordinal}`, result: "Done" }),
      );
      yield* Queue.take(harness.terminalReceipts);
    }
    const ids = harness.events.flatMap((event) =>
      event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan.id] : [],
    );
    assert.lengthOf(new Set(ids), 2);
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
