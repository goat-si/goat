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

// The passive row is the frame Claude 2.1.303 emits for a Stop hook returning a systemMessage.
it.effect.each([
  { name: "hides a passive summary", level: "notice", visible: false },
  { name: "shows a blocking notice", level: "notice", preventContinuation: true, visible: true },
  { name: "shows a warning", level: "warning", visible: true },
])("Claude Stop-hook notices: $name", ({ level, preventContinuation, visible }) =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("claude-stop-hook-notice-attempt"),
        text: "Continue.",
        attachments: [],
      }),
    );
    const content = "Stop says: 40 scans, 0 findings";
    yield* Queue.offer(
      harness.sdkMessages,
      claudeSdkFrame({
        type: "system",
        subtype: "informational",
        content,
        level,
        ...(preventContinuation === undefined ? {} : { prevent_continuation: preventContinuation }),
        session_id: WAKE_NATIVE_SESSION,
        uuid: "00000000-0000-4000-8000-000000000820",
      }),
    );
    yield* Queue.offer(
      harness.sdkMessages,
      makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000821", result: content }),
    );
    assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
    assert.deepEqual(
      harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem.message]
          : [],
      ),
      visible ? [content] : [],
    );
    assert.isFalse(
      harness.events.some(
        (event) => event.type === "message.updated" && event.message.role === "assistant",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
