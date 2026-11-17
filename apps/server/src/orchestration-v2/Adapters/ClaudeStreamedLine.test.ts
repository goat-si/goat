import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
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

// regression: upstream #35037 a long reply line showed nothing until it ended
it.effect("streams a long line every 50 ms before it ends", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("long-line-attempt"),
        text: "Write one long paragraph",
        attachments: [],
      }),
    );
    const stream = (event: unknown) =>
      harness.offerAndWait(
        claudeSdkFrame({
          type: "stream_event",
          event,
          parent_tool_use_id: null,
          session_id: WAKE_NATIVE_SESSION,
          uuid: "stream-frame",
        }),
      );
    const delta = (text: string) =>
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    const replies = () =>
      harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem]
          : [],
      );
    yield* stream({ type: "message_start", message: { id: "long-message" } });
    yield* stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    yield* delta("A long line");
    yield* TestClock.adjust("49 millis");
    yield* delta(" keeps going");
    assert.deepEqual(replies(), []);

    yield* TestClock.adjust("1 millis");
    yield* delta(" without a break");
    assert.deepEqual(
      replies().map((item) => [item.text, item.streaming]),
      [["A long line keeps going without a break", true]],
    );
    yield* delta(" and ends.");
    assert.equal(replies().length, 1);

    yield* stream({ type: "content_block_stop", index: 0 });
    yield* Queue.offer(
      harness.sdkMessages,
      claudeSdkFrame({
        type: "assistant",
        uuid: "long-snapshot",
        session_id: WAKE_NATIVE_SESSION,
        parent_tool_use_id: null,
        message: {
          id: "long-message",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "A long line keeps going without a break and ends." }],
        },
      }),
    );
    yield* Queue.offer(harness.sdkMessages, makeResultFrame({ uuid: "long-result", result: "" }));
    yield* Queue.take(harness.terminalReceipts);
    const last = replies().at(-1);
    assert.equal(last?.text, "A long line keeps going without a break and ends.");
    assert.isFalse(last?.streaming);
    assert.equal(last?.status, "completed");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
