import { expect, it } from "@effect/vitest";
import { COMPUTER_USE_GRANT_HANDOFF_PATH, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  threadId,
  instanceId,
  environmentId,
  person,
  withWorld,
  startEpoch,
  ask,
  wakes,
  resolution,
  waitForComputerUse,
} from "./HandoffWakeReactor.testkit.ts";

it.effect("consumes an approval in the waiting turn and keeps later reconciles quiet", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 1 }),
      );
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* Fiber.join(waiting)).toMatchObject({
        handoff: { state: "completed" },
        usable: true,
      });
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      expect(yield* wakes(world)).toHaveLength(0);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect("an approval that lands before the call waits still reaches it and keeps its wake", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      const event = yield* resolution(world, summary.handoffId);
      yield* world.reactor.handle(event);
      const sent = yield* wakes(world);
      expect(sent).toHaveLength(1);
      const answer = yield* world.handoffs.awaitComputerUseAnswer(
        {
          threadId,
          handoffId: summary.handoffId,
          until: DateTime.add(yield* DateTime.now, { minutes: 1 }),
        },
        () => Effect.succeed(true),
      );
      expect(answer).toMatchObject({ handoff: { state: "completed" }, usable: true });
      // The wake went out before the call owned the request; it stays, so nothing is lost.
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(1);
      const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs.filter(
        (run) => run.userMessageId === sent[0]!.id,
      );
      expect(runs.map((run) => run.status)).toEqual(["queued"]);
    }),
  ),
);

it.effect(
  "a call interrupted while it records an answer gives the answer back to the reactor",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const now = yield* DateTime.now;
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(now, { minutes: 1 }),
        );
        const gate = yield* Deferred.make<void>();
        world.outage.storeGate = gate;
        yield* world.handoffs
          .respond({ threadId, handoffId: summary.handoffId, action: "completed" }, person)
          .pipe(Effect.forkChild({ startImmediately: true }));
        // The waiting call is writing its record of the answer when its turn is stopped.
        yield* Deferred.await(world.outage.stored);
        const stopping = yield* Fiber.interrupt(waiting).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        world.outage.storeGate = undefined;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(stopping);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(1);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(1);
      }),
    ),
);

it.effect("a person's Stop right after approving outlasts the waiting call's record of it", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 1 }),
      );
      // Approved, then stopped, before the waiting call reads either answer.
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "cancelled" },
        person,
      );
      const gate = yield* Deferred.make<void>();
      world.outage.storeGate = gate;
      // A call interrupted while recording the answer gives that record back.
      const stopping = yield* Effect.raceFirst(
        Deferred.await(world.outage.stored),
        Fiber.await(waiting),
      ).pipe(
        Effect.andThen(Fiber.interrupt(waiting)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(0);
      world.outage.storeGate = undefined;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(stopping);
      yield* world.reactor.reconcile;
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect("an approval wake checked before a person's Stop is not sent after it", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // The reactor read the approval, then the person stopped it before the wake went out.
      const approved = yield* world.handoffs.read({ threadId, handoffId: summary.handoffId });
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "cancelled" },
        person,
      );
      let sent = 0;
      yield* world.handoffs.deliverComputerUseWake(
        approved,
        Effect.sync(() => {
          sent += 1;
          return true;
        }),
      );
      expect(sent).toBe(0);
    }),
  ),
);

it.effect("a given-back answer whose wake is waiting to retry still wakes the thread once", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 1 }),
      );
      const gate = yield* Deferred.make<void>();
      world.outage.storeGate = gate;
      yield* world.handoffs
        .respond({ threadId, handoffId: summary.handoffId, action: "completed" }, person)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(world.outage.stored);
      world.outage.removeFailing = 1;
      const stopping = yield* Fiber.interrupt(waiting).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      world.outage.storeGate = undefined;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(stopping);
      // The first wake fails, and the next reconcile comes before its retry is due.
      world.outage.failing = 1;
      yield* world.reactor.reconcile;
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
      yield* TestClock.adjust("3 seconds");
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(1);
    }),
  ),
);

it.effect(
  "a call that cannot give its recorded answer back on the first try still wakes the thread once",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const now = yield* DateTime.now;
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(now, { minutes: 1 }),
        );
        const gate = yield* Deferred.make<void>();
        world.outage.storeGate = gate;
        yield* world.handoffs
          .respond({ threadId, handoffId: summary.handoffId, action: "completed" }, person)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(world.outage.stored);
        // Stopped mid-record, and the store cannot remove that record right then.
        world.outage.removeFailing = 1;
        const stopping = yield* Fiber.interrupt(waiting).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        world.outage.storeGate = undefined;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(stopping);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(1);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(1);
      }),
    ),
);

it.effect(
  "a call that fails before it starts waiting leaves the approval's wake to the reactor",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        // Its first read of the request fails, as an outage or a stopped turn would end it.
        const failed = yield* world.handoffs
          .awaitComputerUseAnswer(
            {
              threadId: ThreadId.make("thread:elsewhere"),
              handoffId: summary.handoffId,
              until: DateTime.add(yield* DateTime.now, { minutes: 1 }),
            },
            () => Effect.succeed(true),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
        expect(yield* wakes(world)).toHaveLength(1);
      }),
    ),
);

it.effect("a repeated decline keeps a decline the waiting call already returned quiet", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 1 }),
      );
      const decline = world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      yield* decline;
      expect(yield* Fiber.join(waiting)).toMatchObject({ usable: true });
      // A client retrying the same answer must not clear the record of it.
      yield* decline;
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect.each(["declined", "cancelled"] as const)(
  "consumes a person's %s answer in the waiting turn without waking it",
  (action) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(yield* DateTime.now, { minutes: 1 }),
        );
        yield* world.handoffs.respond({ threadId, handoffId: summary.handoffId, action }, person);
        expect(yield* Fiber.join(waiting)).toMatchObject({
          handoff: { state: action, actor: { type: "client" } },
          usable: true,
        });
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId, action));
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(0);
      }),
    ),
);

it.effect(
  "leaves a request pending when its wait budget ends and wakes once on later approval",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const now = yield* DateTime.now;
        const summary = yield* ask(
          world,
          COMPUTER_USE_GRANT_HANDOFF_PATH,
          DateTime.add(now, { minutes: 5 }),
        );
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(now, { minutes: 1 }),
        );
        yield* TestClock.adjust("2 minutes");
        expect(yield* Fiber.join(waiting)).toMatchObject({
          handoff: { state: "pending" },
          usable: false,
        });
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
        expect(yield* wakes(world)).toHaveLength(1);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(1);
      }),
    ),
);

it.effect("wakes once when the asking turn cannot consume an answer it waited for", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(yield* DateTime.now, { minutes: 1 }),
        false,
      );
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* Fiber.join(waiting)).toMatchObject({
        handoff: { state: "completed" },
        usable: false,
      });
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      expect(yield* wakes(world)).toHaveLength(1);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(1);
    }),
  ),
);

it.effect("consumes expiry before the wait budget without waking another turn", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(
        world,
        COMPUTER_USE_GRANT_HANDOFF_PATH,
        DateTime.add(now, { minutes: 1 }),
      );
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 5 }),
      );
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        handoff: { state: "expired" },
        usable: true,
      });
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId, "expired"));
      expect(yield* wakes(world)).toHaveLength(0);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect("releases an interrupted waiter's answer so a later approval wakes once", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(yield* DateTime.now, { minutes: 1 }),
      );
      yield* Fiber.interrupt(waiting);
      expect((yield* Fiber.await(waiting))._tag).toBe("Failure");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      expect(yield* wakes(world)).toHaveLength(1);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(1);
    }),
  ),
);

it.effect(
  "a different computer use request cancels the older waiting request as the agent without waking",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(yield* DateTime.now, { minutes: 1 }),
        );
        const run = (yield* world.orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const newer = yield* world.handoffs.create({
          kind: "approval",
          title: "Allow a different app?",
          reason: "The agent needs a different app.",
          requestedBy: {
            threadId,
            providerInstanceId: instanceId,
            path: COMPUTER_USE_GRANT_HANDOFF_PATH,
          },
          target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "PRIVATE-INSTRUCTIONS" },
          args: { path: COMPUTER_USE_GRANT_HANDOFF_PATH, apps: ["com.apple.TextEdit"] },
        });
        expect(newer.handoffId).not.toBe(summary.handoffId);
        expect((yield* world.handoffs.read({ threadId, handoffId: newer.handoffId })).state).toBe(
          "pending",
        );
        expect(yield* Fiber.join(waiting)).toMatchObject({
          handoff: { state: "cancelled", actor: { type: "agent" } },
          usable: true,
        });
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId, "cancelled"));
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(0);
      }),
    ),
);
