import { ProviderTurnId, RunAttemptId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { CLAUDE_PROVIDER } from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { makeAssistantTextFrame, makeResultFrame } from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

it.effect("forks at the completed Claude boundary while a later turn streams and completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boundaries: Array<string | undefined> = [];
      const harness = yield* makeWakeHarnessWithOptions({
        forkSession: (input) =>
          Effect.sync(() => {
            boundaries.push(input.options.upToMessageId);
            return { sessionId: "forked-live" };
          }),
      });
      const start = (attempt: string, ordinal: number) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: DateTime.makeUnsafe(0),
            attemptId: RunAttemptId.make(attempt),
            text: "Continue",
            attachments: [],
            providerTurnOrdinal: ordinal,
          }),
        );
      const cursor = "00000000-0000-4000-8000-000000000651";
      yield* start("fork-first", 1);
      yield* Queue.offer(
        harness.sdkMessages,
        makeAssistantTextFrame({ uuid: cursor, text: "Boundary" }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000652", result: "Done" }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      const first = harness.events.findLast((event) => event.type === "provider_turn.updated");
      assert.isDefined(first);
      if (first === undefined || first.type !== "provider_turn.updated") return;
      const completed = {
        ...first.providerTurn,
        status: "completed" as const,
        nativeTurnRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: cursor,
          strength: "weak" as const,
        },
      };
      yield* start("fork-second", 2);
      yield* harness.runtime.forkThread({
        sourceProviderThread: harness.providerThread,
        sourceProviderTurns: [
          completed,
          { ...completed, id: ProviderTurnId.make("later-running"), ordinal: 2, status: "running" },
        ],
        providerTurnId: completed.id,
        targetThreadId: ThreadId.make("fork-target"),
      });
      assert.deepEqual(boundaries, [cursor]);
      yield* Queue.offer(
        harness.sdkMessages,
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000000653",
          text: "Still streaming",
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000654", result: "Finished" }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect(
  "rejects a running Claude fork without a completed boundary and leaves the turn running",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions();
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: DateTime.makeUnsafe(0),
            attemptId: RunAttemptId.make("fork-no-boundary"),
            text: "Continue",
            attachments: [],
          }),
        );
        const result = yield* harness.runtime
          .forkThread({
            sourceProviderThread: harness.providerThread,
            targetThreadId: ThreadId.make("fork-no-boundary-target"),
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000655", result: "Finished" }),
        );
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);
