import { assert, describe, it } from "@effect/vitest";
import type { PenSnapshot, PenWatchStale } from "@goat/pen-protocol/snapshot";
import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PenMembershipWatch from "./PenMembershipWatch.ts";

const id = (letter: string) => letter.repeat(26);
const snapshot = (gen: number, ...letters: string[]): PenSnapshot => ({
  gen,
  mesh: id("m"),
  self: id("s"),
  members: ["s", ...letters].map((letter) => ({
    nodeId: id(letter),
    noisePub: letter.repeat(43),
    name: `box-${letter}`,
    online: true,
  })),
  revoked: [],
});

const harness = Effect.gen(function* () {
  const watches: Array<{
    readonly onSnapshot: (snapshot: PenSnapshot) => void;
    readonly onStale: (reason: PenWatchStale) => void;
    stopped: boolean;
  }> = [];
  const state = { left: false };
  const watch = yield* PenMembershipWatch.make({
    stateDir: "/pen",
    stateDirExists: () => Effect.succeed(true),
    leftMesh: () => Effect.sync(() => state.left),
    watch: (input) => {
      const entry = { onSnapshot: input.onSnapshot, onStale: input.onStale, stopped: false };
      watches.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  });
  yield* TestClock.adjust(0);
  return { watch, watches, state };
});

const kinds = (views: ReadonlyArray<PenMembershipView>) =>
  views.map((view) =>
    view.kind === "ready"
      ? view.snapshot.members.map((member) => member.name).join(",")
      : view.kind,
  );

describe("PenMembershipWatch", () => {
  it.effect("every reader follows the same single watch on Pen", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const read = () => h.watch.changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const first = yield* read();
      const second = yield* read();
      yield* TestClock.adjust(0);
      h.watches[0]?.onSnapshot(snapshot(1, "a"));
      assert.deepEqual(kinds([yield* h.watch.current]), ["box-s,box-a"]);
      for (const reader of [first, second])
        assert.deepEqual(kinds([...(yield* Fiber.join(reader))]), ["unavailable", "box-s,box-a"]);
      assert.equal(h.watches.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a dead watch is unavailable at once and a departure only with Pen's left marker", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.watches[0]?.onSnapshot(snapshot(1, "a"));
      yield* TestClock.adjust(0);
      h.watches[0]?.onStale("closed");
      assert.deepEqual(yield* h.watch.current, { kind: "unavailable", reason: "stale" });
      h.state.left = true;
      yield* TestClock.adjust("1 second");
      assert.equal(h.watches.length, 2);
      h.watches[1]?.onStale("connect");
      yield* TestClock.adjust(0);
      assert.deepEqual(yield* h.watch.current, { kind: "not-member" });
    }).pipe(Effect.scoped),
  );

  it.effect("closing the scope closes the watch socket", () =>
    Effect.gen(function* () {
      const watches = yield* Effect.scoped(Effect.map(harness, (h) => h.watches));
      yield* TestClock.adjust(0);
      assert.deepEqual(
        watches.map((entry) => entry.stopped),
        [true],
      );
    }),
  );
});
