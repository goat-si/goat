import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeChannelTaskChanges, TASK_CHANGES_COALESCE } from "./channelTaskChanges.ts";

/** Revisions an owner's subscriber has seen; the first take is revision 0, once subscribed. */
const watch = (
  changes: Effect.Success<ReturnType<typeof makeChannelTaskChanges>>,
  ownerId: string,
) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<number>();
    yield* changes.revisions(ownerId).pipe(
      Stream.runForEach((revision) => Queue.offer(seen, revision)),
      Effect.forkChild,
    );
    assert.strictEqual(yield* Queue.take(seen), 0);
    return seen;
  });

describe("channel task change revisions", () => {
  it.effect("a burst of changes to one owner is one revision, and other owners hear nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* makeChannelTaskChanges(sql);
      const mine = yield* watch(changes, "owner-a");
      const theirs = yield* watch(changes, "owner-b");
      for (let index = 0; index < 5; index++) yield* changes.announce(["owner-a"]);
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.strictEqual(yield* Queue.take(mine), 1);
      yield* TestClock.adjust(Duration.seconds(5));
      assert.isTrue(Option.isNone(yield* Queue.poll(mine)));
      assert.isTrue(Option.isNone(yield* Queue.poll(theirs)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a write announces after it commits, never from inside a caller's transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* makeChannelTaskChanges(sql);
      const seen = yield* watch(changes, "owner-a");
      const write = changes.afterCommit(Effect.succeed(1), () => ["owner-a"]);
      // Rolled back: the caller's transaction never committed, so nothing is said.
      yield* sql
        .withTransaction(Effect.andThen(write, Effect.fail("rolled back")))
        .pipe(Effect.ignore);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
      // Committed by a caller: still silent; announcing is that caller's, after its commit.
      yield* sql.withTransaction(write);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
      // On its own, the write's own commit is the outermost one.
      yield* write;
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.strictEqual(yield* Queue.take(seen), 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
