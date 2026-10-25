import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.merge(
    database,
    ComputerUseLeases.layer.pipe(Layer.provide(Layer.merge(database, NodeServices.layer))),
  ),
);

// The layer is shared across tests, so each test keeps to its own threads.
const thread = ThreadId.make("thread-person");
const other = ThreadId.make("thread-bot");

layer("ComputerUseLeases person and agent input", (it) => {
  it.effect(
    "another agent's own input seen by a helper pauses nobody, a person's after it does",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.stopAll;
        const mine = yield* leases.control(thread, Option.none());
        const bots = yield* leases.control(other, Option.none());
        const call = (state: "start" | "end", at: number) =>
          leases.agentInput(other, bots.controlId, { call: "7", state, at });
        // Only a live control's own proxy records its calls.
        assert.isFalse(
          yield* leases.agentInput(thread, bots.controlId, { call: "7", state: "start", at: 0 }),
        );
        assert.isTrue(yield* call("start", 1_000));
        // A report dated far from the server's clock is refused and records nothing.
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [
            { at: 10 * 60_000, source: "pointer" },
          ]),
          "refused",
        );
        assert.isFalse(
          yield* leases.agentInput(other, bots.controlId, {
            call: "8",
            state: "start",
            at: 10 * 60_000,
          }),
        );
        // The bot's click, seen by my helper while it runs and just after it answered.
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: 1_100, source: "pointer" }]),
          "agents",
        );
        yield* call("end", 1_200);
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: 1_600, source: "pointer" }]),
          "agents",
        );
        assert.equal((yield* leases.controlState(thread, mine.controlId))._tag, "active");
        // A person, a moment later.
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: 2_000, source: "pointer" }]),
          "paused",
        );
        assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
          _tag: "paused",
          reason: "human_input",
        });
        yield* leases.resume;
        // A call left open by a control that has ended covers nothing.
        yield* call("start", 5_000);
        yield* leases.stop(other);
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: 5_100, source: "pointer" }]),
          "paused",
        );
        assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
          _tag: "paused",
          reason: "human_input",
        });
      }),
  );

  it.effect(
    "a proxy's report of a person's input pauses every agent, from its live control only",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.stopAll;
        const mine = yield* leases.control(thread, Option.none());
        const bots = yield* leases.control(other, Option.none());
        // An old proxy, or another thread's control id, pauses nobody.
        assert.equal(
          yield* leases.humanInput(thread, "control:old", [{ at: 0, source: "pointer" }]),
          "refused",
        );
        assert.equal(
          yield* leases.humanInput(thread, bots.controlId, [{ at: 0, source: "pointer" }]),
          "refused",
        );
        assert.equal((yield* leases.controlState(other, bots.controlId))._tag, "active");

        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: 0, source: "pointer" }]),
          "paused",
        );
        for (const [id, control] of [
          [thread, mine],
          [other, bots],
        ] as const)
          assert.deepEqual(yield* leases.controlState(id, control.controlId), {
            _tag: "paused",
            reason: "human_input",
          });
        yield* leases.resume;
        yield* leases.stop(thread);
        // An ended control's proxy can no longer pause the agents left.
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: 0, source: "pointer" }]),
          "refused",
        );
        assert.equal((yield* leases.controlState(other, bots.controlId))._tag, "active");
      }),
  );
});

/** A service of its own, so agent input recorded by other tests cannot cover these. */
const freshLeases = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(database, NodeServices.layer)),
);

it.effect("a person's key while another agent clicks pauses every agent", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    yield* leases.stopAll;
    const mine = yield* leases.control(thread, Option.none());
    const bots = yield* leases.control(other, Option.none());
    // The bot's click posts pointer events only; a keyboard event during it is a person's.
    yield* TestClock.adjust(30_000);
    assert.isTrue(
      yield* leases.agentInput(other, bots.controlId, {
        call: "7",
        state: "start",
        at: 30_000,
        kinds: ["pointer"],
      }),
    );
    assert.equal(
      yield* leases.humanInput(thread, mine.controlId, [{ at: 30_100, source: "pointer" }]),
      "agents",
    );
    assert.equal(
      yield* leases.humanInput(thread, mine.controlId, [{ at: 30_150, source: "keyboard" }]),
      "paused",
    );
    assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
      _tag: "paused",
      reason: "human_input",
    });
  }).pipe(Effect.provide(freshLeases)),
);

it.effect("back-to-back agent calls hide a person's input for ten seconds at most", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    yield* leases.stopAll;
    const mine = yield* leases.control(thread, Option.none());
    const bots = yield* leases.control(other, Option.none());
    // A click every 400 ms, each answered after 100 ms: its cover never lapses. The server's
    // own clock moves with it, so old calls are forgotten as it goes.
    yield* TestClock.adjust(30_000);
    for (let call = 0; call < 60; call++) {
      const at = 30_000 + call * 400;
      const report = { call: String(call), kinds: ["pointer"] as const };
      yield* leases.agentInput(other, bots.controlId, { ...report, state: "start", at });
      yield* leases.agentInput(other, bots.controlId, { ...report, state: "end", at: at + 100 });
      // The helper reports an event a little after it happened.
      if (call === 10)
        assert.equal(
          yield* leases.humanInput(thread, mine.controlId, [{ at: at - 300, source: "pointer" }]),
          "agents",
        );
      yield* TestClock.adjust(400);
    }
    // Past ten seconds of unbroken cover, pointer input pauses the agents, erring toward a person.
    assert.equal(
      yield* leases.humanInput(thread, mine.controlId, [{ at: 53_300, source: "pointer" }]),
      "paused",
    );
  }).pipe(Effect.provide(freshLeases)),
);

it.effect("a call's tail still covers an event as long as the server admits that event", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    yield* leases.stopAll;
    const mine = yield* leases.control(thread, Option.none());
    const bots = yield* leases.control(other, Option.none());
    yield* TestClock.adjust(30_000);
    const report = { call: "tail", kinds: ["pointer"] as const };
    yield* leases.agentInput(other, bots.controlId, { ...report, state: "start", at: 30_000 });
    yield* TestClock.adjust(1_100);
    yield* leases.agentInput(other, bots.controlId, { ...report, state: "end", at: 31_100 });
    // The event at 31.4 s is inside the call's tail; nearly ten seconds later it is still judged.
    yield* TestClock.adjust(10_100);
    assert.equal(
      yield* leases.humanInput(thread, mine.controlId, [{ at: 31_400, source: "pointer" }]),
      "agents",
    );
  }).pipe(Effect.provide(freshLeases)),
);

it.effect(
  "refuses an input event older than the calls the server remembers, since it cannot be judged",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* leases.stopAll;
      const mine = yield* leases.control(thread, Option.none());
      yield* TestClock.adjust(30_000);
      // An event from 12 s ago: any call that covered it is forgotten by now.
      assert.equal(
        yield* leases.humanInput(thread, mine.controlId, [{ at: 18_000, source: "pointer" }]),
        "refused",
      );
      assert.equal(
        yield* leases.humanInput(thread, mine.controlId, [{ at: 29_900, source: "pointer" }]),
        "paused",
      );
    }).pipe(Effect.provide(freshLeases)),
);

it.effect(
  "two agents taking turns hide a person's input for ten seconds at most between them",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* leases.stopAll;
      const mine = yield* leases.control(thread, Option.none());
      const bots = yield* leases.control(other, Option.none());
      // Each agent clicks every 800 ms, so its own cover lapses between clicks; offset by 400 ms,
      // the two together never lapse.
      yield* TestClock.adjust(30_000);
      for (let call = 0; call < 60; call++) {
        const at = 30_000 + call * 400;
        const [owner, control] = call % 2 === 0 ? [other, bots] : [thread, mine];
        const report = { call: String(call), kinds: ["pointer"] as const };
        yield* leases.agentInput(owner, control.controlId, { ...report, state: "start", at });
        yield* leases.agentInput(owner, control.controlId, {
          ...report,
          state: "end",
          at: at + 100,
        });
        yield* TestClock.adjust(400);
      }
      assert.equal(
        yield* leases.humanInput(thread, mine.controlId, [{ at: 53_300, source: "pointer" }]),
        "paused",
      );
    }).pipe(Effect.provide(freshLeases)),
);

it.effect(
  "a batch of events is judged one by one: the agent's own are dropped, and a person's among them pauses",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* leases.stopAll;
      const mine = yield* leases.control(thread, Option.none());
      const bots = yield* leases.control(other, Option.none());
      yield* TestClock.adjust(30_000);
      yield* leases.agentInput(other, bots.controlId, {
        call: "9",
        state: "start",
        at: 30_000,
        kinds: ["pointer"],
      });
      const moves = Array.from({ length: 30 }, (_, index) => ({
        at: 30_000 + index * 8,
        source: "pointer" as const,
      }));
      // Only the other agent's moves: nobody pauses.
      assert.equal(yield* leases.humanInput(thread, mine.controlId, moves), "agents");
      assert.equal((yield* leases.controlState(thread, mine.controlId))._tag, "active");
      // A batch with nothing the server can judge, all too old, is refused.
      assert.equal(
        yield* leases.humanInput(thread, mine.controlId, [{ at: 18_000, source: "pointer" }]),
        "refused",
      );
      // The same moves with a person's key among them, wherever it sits in the batch.
      const key = { at: 30_050, source: "keyboard" as const };
      assert.equal(yield* leases.humanInput(thread, mine.controlId, [...moves, key]), "paused");
      assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
        _tag: "paused",
        reason: "human_input",
      });
    }).pipe(Effect.provide(freshLeases)),
);
