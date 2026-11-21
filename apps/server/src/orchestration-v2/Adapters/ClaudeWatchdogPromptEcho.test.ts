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
import { claudeSdkFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";
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

it.effect.each(["echo", "text_blocks", "tool_result", "replay"] as const)(
  "watchdog treats a user %s frame as progress only for tool results",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions();
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`watchdog-${kind}`),
            text: "Hello",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state: "started",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content:
                kind === "echo"
                  ? "Hello"
                  : kind === "text_blocks"
                    ? [{ type: "text", text: "Hello" }]
                    : [{ type: "tool_result", tool_use_id: "toolu_active", content: "Done" }],
            },
            uuid: harness.promptUuid(0),
            parent_tool_use_id: null,
            session_id: WAKE_NATIVE_SESSION,
            ...(kind === "replay" ? { isReplay: true } : {}),
          }),
        );
        yield* TestClock.adjust("11 minutes");
        const terminal = harness.terminalEvents();
        if (kind !== "tool_result") {
          assert.equal(terminal[0]?.status, "failed");
          if (terminal[0]?.status === "failed")
            assert.equal(terminal[0].failure.code, "claude_request_unanswered");
        } else assert.isEmpty(terminal);
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);
