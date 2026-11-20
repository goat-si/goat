import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { CLAUDE_PROVIDER } from "./ClaudeAdapterV2.ts";
import * as Ref from "effect/Ref";
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

it.effect("fails a turn when its started request never receives a response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("unanswered"),
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(0),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000000100",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* TestClock.adjust("11 minutes");
      const terminal = harness.terminalEvents();
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.status, "failed");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect.each([
  { task: "earlier-progress", forked: false },
  { task: "forked-skill", forked: true },
])("preserves timeout ownership for $task", ({ forked }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`unanswered-${forked}`),
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(0),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000000200",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        forked
          ? claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "forked",
              description: "Long skill",
              uuid: "00000000-0000-4000-8000-000000000201",
              session_id: WAKE_NATIVE_SESSION,
            })
          : claudeSdkFrame({
              type: "system",
              subtype: "task_progress",
              task_id: "earlier",
              description: "Earlier task",
              usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
              uuid: "00000000-0000-4000-8000-000000000202",
              session_id: WAKE_NATIVE_SESSION,
            }),
      );
      yield* TestClock.adjust("11 minutes");
      assert.equal(harness.terminalEvents().length, forked ? 0 : 1);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("keeps user Stop interrupted while an unanswered request is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* Ref.make<Queue.Queue<SDKMessage> | undefined>(undefined);
      const harness = yield* makeWakeHarnessWithOptions({
        interrupt: Ref.get(queue).pipe(
          Effect.flatMap((current) =>
            current === undefined ? Effect.void : Queue.shutdown(current),
          ),
        ),
      });
      yield* Ref.set(queue, harness.sdkMessages);
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const attemptId = RunAttemptId.make("unanswered-user-stop");
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId,
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(0),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000000300",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: allocator.derive.providerTurn({
          driver: CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        }),
      });
      yield* harness.awaitTerminal(1);
      yield* TestClock.adjust("11 minutes");
      assert.equal(harness.terminalEvents().length, 1);
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
