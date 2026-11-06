import { assert } from "@effect/vitest";
import { CommandId, type ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type * as Orchestrator from "../Orchestrator.ts";

export const assertPinSettled = Effect.fn("test.assertPinSettled")(function* (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
) {
  const before = yield* orchestrator.getThreadProjection(threadId);
  const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
    (thread) => thread.id === threadId,
  );
  assert.deepEqual(shell?.unsettledAt, before.thread.unsettledAt);
  yield* orchestrator.dispatch({
    type: "thread.settle",
    commandId: CommandId.make("runtime-layer-lifecycle-resettle"),
    threadId,
  });
  yield* TestClock.adjust("1 minute");
  yield* orchestrator.dispatch({
    type: "thread.pin",
    commandId: CommandId.make("runtime-layer-lifecycle-pin-settled"),
    threadId,
  });
  const pinned = yield* orchestrator.getThreadProjection(threadId);
  assert.equal(pinned.thread.settledOverride, "active");
  if (pinned.thread.unsettledAt === null || before.thread.unsettledAt === null)
    return yield* Effect.die("missing unsettled timestamp");
  assert.isAbove(
    DateTime.toEpochMillis(pinned.thread.unsettledAt),
    DateTime.toEpochMillis(before.thread.unsettledAt),
  );
});
