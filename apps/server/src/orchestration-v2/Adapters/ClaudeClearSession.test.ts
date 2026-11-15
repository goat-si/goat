import { type OrchestrationV2ProviderThread, RunAttemptId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { claudeSdkFrame, turnOneResult } from "./ClaudeWakeFrames.testkit.ts";
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

const lastProviderTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const event = events.findLast((candidate) => candidate.type === "provider_turn.updated");
  if (event?.type !== "provider_turn.updated") {
    throw new Error("Expected a provider turn update.");
  }
  return event.providerTurn;
};

it.effect("resumes the session a /clear selected after the Claude process is replaced", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions({
      freshQueueOnReopen: true,
      close: (queue) => Queue.shutdown(queue),
    });
    const turn = (ordinal: number, providerThread: OrchestrationV2ProviderThread) =>
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread,
        now: DateTime.makeUnsafe(0),
        attemptId: RunAttemptId.make(`clear-session-${ordinal}`),
        text: ordinal === 1 ? "/clear" : "Continue the cleared conversation",
        attachments: [],
        providerTurnOrdinal: ordinal,
      });
    yield* harness.runtime.startTurn(turn(1, harness.providerThread));
    // Claude Code reports the session /clear started in its next init frame.
    yield* harness.offerAndWait(
      claudeSdkFrame({
        type: "system",
        subtype: "init",
        session_id: "cleared-native-session",
        uuid: "00000000-0000-4000-8000-000000000501",
      }),
    );
    yield* harness.offerAndWait(turnOneResult);
    yield* Queue.take(harness.terminalReceipts);
    const latest = (): OrchestrationV2ProviderThread => {
      const event = harness.events.findLast(
        (candidate) => candidate.type === "provider_thread.updated",
      );
      return event?.type === "provider_thread.updated"
        ? event.providerThread
        : harness.providerThread;
    };
    assert.equal(latest().nativeThreadRef?.nativeId, "cleared-native-session");
    yield* harness.runtime.interruptTurn({
      providerThread: latest(),
      providerTurnId: lastProviderTurn(harness.events).id,
      requestRuntimeRestart: true,
    });
    yield* harness.runtime.startTurn(turn(2, latest()));
    assert.equal(harness.processQueues.length, 2);
    assert.equal(harness.getOpenedOptions()?.resume, "cleared-native-session");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
