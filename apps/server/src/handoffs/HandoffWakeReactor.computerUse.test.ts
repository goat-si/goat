import { expect, it } from "@effect/vitest";
import { COMPUTER_USE_GRANT_HANDOFF_PATH } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
        consumed: true,
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

it.effect("consumes an earlier approval and cancels its wake queued behind the asking turn", () =>
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
      const wakeRun = (yield* world.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === sent[0]!.id,
      );
      expect(wakeRun?.status).toBe("queued");
      const answer = yield* world.handoffs.awaitComputerUseAnswer(
        {
          threadId,
          handoffId: summary.handoffId,
          until: DateTime.add(yield* DateTime.now, { minutes: 1 }),
        },
        () => Effect.succeed(true),
      );
      expect(answer).toMatchObject({ handoff: { state: "completed" }, consumed: true });
      for (const deliver of [world.reactor.handle(event), world.reactor.reconcile]) {
        yield* deliver;
        expect(yield* wakes(world)).toHaveLength(1);
        const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs.filter(
          (run) => run.userMessageId === sent[0]!.id,
        );
        expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
      }
    }),
  ),
);

it.effect(
  "an answer whose queued wake cannot be withdrawn still reaches the call and keeps that wake",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
        const sent = yield* wakes(world);
        expect(sent).toHaveLength(1);
        world.outage.failWithdraw = true;
        const answer = yield* world.handoffs.awaitComputerUseAnswer(
          {
            threadId,
            handoffId: summary.handoffId,
            until: DateTime.add(yield* DateTime.now, { minutes: 1 }),
          },
          () => Effect.succeed(true),
        );
        expect(answer).toMatchObject({ handoff: { state: "completed" }, consumed: true });
        // Nothing recorded the answer as taken, so the thread keeps the wake it was sent.
        world.outage.failWithdraw = false;
        yield* world.reactor.reconcile;
        const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs.filter(
          (run) => run.userMessageId === sent[0]!.id,
        );
        expect(runs.map((run) => run.status)).toEqual(["queued"]);
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
      expect(yield* Fiber.join(waiting)).toMatchObject({ consumed: true });
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
          consumed: true,
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
          consumed: false,
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
        consumed: false,
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
        consumed: true,
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
          consumed: true,
        });
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId, "cancelled"));
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(0);
      }),
    ),
);
