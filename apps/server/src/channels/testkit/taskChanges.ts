import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelBotMembers from "../ChannelBotMembers.ts";
import { TASK_CHANGES_COALESCE } from "../channelTaskChanges.ts";

/** Revisions this owner's subscriber has seen; the first take is revision 0, once subscribed. */
export const watchTaskChanges = Effect.fn("watchTaskChanges")(function* (who: {
  readonly ownerId: string;
}) {
  const members = yield* ChannelBotMembers.ChannelBotMembers;
  const seen = yield* Queue.unbounded<number>();
  yield* members.taskChanges(who).pipe(
    Stream.runForEach((revision) => Queue.offer(seen, revision)),
    Effect.forkChild,
  );
  assert.strictEqual(yield* Queue.take(seen), 0);
  return seen;
});

/** The next revision, once the coalescing window has passed. */
export const nextTaskChange = Effect.fn("nextTaskChange")(function* (seen: Queue.Queue<number>) {
  yield* TestClock.adjust(TASK_CHANGES_COALESCE);
  return yield* Queue.take(seen);
});
