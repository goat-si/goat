import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { turnOneResult } from "./ClaudeWakeFrames.testkit.ts";
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

it.effect("cancels an elicitation after the turn ended without creating an approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("idle-elicitation"),
          text: "Hello",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(turnOneResult);
      yield* harness.awaitTerminal(1);
      const elicit = harness.getOpenedOptions()?.onElicitation;
      assert.isDefined(elicit);
      if (elicit === undefined) return;
      const result = yield* Effect.promise(() =>
        elicit(
          {
            serverName: "test",
            message: "Allow?",
            mode: "form",
            requestedSchema: { type: "object", properties: {} },
          },
          { signal: new AbortController().signal, requestId: "idle" },
        ),
      );
      assert.deepEqual(result, { action: "cancel" });
      assert.isEmpty(harness.events.filter((event) => event.type === "runtime_request.updated"));
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
