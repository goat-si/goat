import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
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

it.effect.each([
  { firstCwd: "/workspace", expected: ["/workspace"] },
  { firstCwd: "/other", expected: [] },
])("reports only the first init for the requested workspace: $firstCwd", ({ firstCwd, expected }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notifications: string[] = [];
      const harness = yield* makeWakeHarnessWithOptions({
        onSessionInit: (cwd) =>
          Effect.sync(() => {
            notifications.push(cwd);
          }),
      });
      const turn = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(`init-${firstCwd}`),
        text: "Hello",
        attachments: [],
      });
      yield* harness.runtime.startTurn(turn);
      for (const [index, cwd] of [firstCwd, "/workspace"].entries())
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "init",
            cwd,
            uuid: `00000000-0000-4000-8000-00000000070${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      assert.deepEqual(notifications, expected);
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
