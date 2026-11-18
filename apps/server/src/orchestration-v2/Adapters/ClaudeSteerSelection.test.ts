import { assert, it } from "@effect/vitest";
import { MessageId, type ModelSelection, RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";

import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { turnOneResult } from "./ClaudeWakeFrames.testkit.ts";
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

const opus = {
  instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
  model: "claude-opus-5-5",
} satisfies ModelSelection;

// regression: #34549 a model change sent with a steer was shown but never applied to the turn.
it.effect("applies a model change sent with a steer to the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-steer-model-change"),
        text: "Run the slow build.",
        attachments: [],
        modelSelection: opus,
      });
      yield* harness.runtime.startTurn(input);
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${input.attemptId}`,
        }),
        modelSelection: { ...opus, model: "claude-sonnet-4-6" },
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("steer-model-change"),
          text: "Which model are you?",
          attachments: [],
        },
      });
      assert.deepEqual(harness.liveSelectionChanges, [
        { model: "claude-sonnet-4-6" },
        { effortLevel: "high", fastMode: null, ultracode: null },
      ]);
      assert.lengthOf(harness.offeredMessages, 2);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("fails a model-changing steer when the turn ends during the selection change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let duringFlags: Effect.Effect<void> = Effect.void;
      const harness = yield* makeWakeHarnessWithOptions({
        applyFlagSettings: () => Effect.suspend(() => duringFlags),
      });
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-steer-model-change-race"),
        text: "Run the slow build.",
        attachments: [],
        modelSelection: opus,
      });
      yield* harness.runtime.startTurn(input);
      duringFlags = harness
        .offerAndWait(turnOneResult)
        .pipe(Effect.andThen(Queue.take(harness.terminalReceipts)), Effect.asVoid);
      const steer = yield* harness.runtime
        .steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          modelSelection: { ...opus, model: "claude-sonnet-4-6" },
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("steer-model-change-race"),
            text: "Which model are you?",
            attachments: [],
          },
        })
        .pipe(Effect.result);
      assert.equal(steer._tag, "Failure");
      assert.lengthOf(harness.offeredMessages, 1);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
