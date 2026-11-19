import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
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

it.effect.each([
  { oldTitle: "New thread", explicit: false, expected: "Generated title" },
  { oldTitle: "My title", explicit: false, expected: undefined },
  { oldTitle: "My title", explicit: true, expected: "Generated title" },
])("projects title changes for $oldTitle explicit=$explicit", ({ oldTitle, explicit, expected }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const turn = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(`title-${explicit}-${oldTitle}`),
        text: explicit ? "/rename Generated title" : "Hello",
        attachments: [],
      });
      yield* harness.runtime.startTurn({
        ...turn,
        appThread: { ...turn.appThread, title: oldTitle },
      });
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "session_title_changed",
          title: "Generated title",
          uuid: "00000000-0000-4000-8000-000000000400",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      if (explicit)
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000401", result: "Renamed" }),
            local_command: "rename",
          }),
        );
      const event = harness.events.findLast((entry) => entry.type === "app_thread.created");
      assert.equal(
        event?.type === "app_thread.created" ? event.appThread.title : undefined,
        expected,
      );
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect("ignores malformed title frames and keeps the turn usable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions();
      const turn = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("malformed-title"),
        text: "Hello",
        attachments: [],
      });
      yield* harness.runtime.startTurn(turn);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "session_title_changed",
          title: 42,
          uuid: "00000000-0000-4000-8000-000000000600",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.isFalse(harness.events.some((event) => event.type === "app_thread.created"));
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000601", result: "Done" }),
      );
      yield* harness.awaitTerminal(1);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
