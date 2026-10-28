import { assert, describe, it } from "@effect/vitest";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  active,
  call,
  CONTROL,
  harness,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

const listApps = (requestId: string, connectionGeneration: string, deadlineMillis: number) => ({
  state: "primitive-request" as const,
  requestId,
  registrationId: "registration:one",
  controlId: CONTROL,
  connectionGeneration,
  runId: "run:one",
  turnId: "cell:one",
  callId: 0,
  deadlineMillis,
  tool: "list_apps",
  args: {},
});
const sentListApps = (log: ReadonlyArray<string>) =>
  log.filter((entry) => entry === "send list_apps").length;

/** A first call the driver leaves unanswered past its 2 s deadline, and a second call after it. */
const overdue = Effect.fn(function* (
  options: Parameters<typeof harness>[0] = {},
  secondDeadline = 60_000,
) {
  const h = yield* harness(options);
  yield* h.push(active());
  const first = yield* h.driverStarted;
  yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
  const stuck = yield* h.nextToDriver;
  yield* TestClock.adjust(2_000);
  yield* h.sendPrimitive(listApps("request:next", first.connectionId, secondDeadline));
  /** Replies by request id, as they settle. */
  const replies = (count: number) =>
    Effect.forEach(Array.from({ length: count }), () => h.primitiveReply).pipe(
      Effect.map(
        (all) =>
          new Map<string, ComputerUsePrimitiveReply>(all.map((reply) => [reply.requestId, reply])),
      ),
    );
  return { h, first, stuck, replies };
});

describe("ComputerUseLeaseProxy holds calls behind an overdue one", () => {
  it.effect("a call made while an earlier call is overdue never reaches the stuck child", () =>
    Effect.gen(function* () {
      const { h, replies } = yield* overdue();
      yield* TestClock.adjust(1_000);
      const settled = yield* replies(2);
      assert.equal(settled.get("request:stuck")?.status, "unknown_outcome");
      assert.equal(settled.get("request:next")?.status, "not_started");
      assert.equal(sentListApps(h.log), 1);
      assert.equal(h.drivers.length, 2);
    }),
  );

  it.effect("a held call goes to the same child when the overdue reply lands in the grace", () =>
    Effect.gen(function* () {
      const { h, stuck } = yield* overdue();
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: stuck.id, result: { content: [] } }));
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
      yield* TestClock.adjust(1_000);
      assert.equal(h.drivers.length, 1);
    }),
  );

  it.effect("a held call is refused, nothing sent, when the replacement fails", () =>
    Effect.gen(function* () {
      const { h, replies } = yield* overdue({ restartFailure: "driver did not start" });
      yield* TestClock.adjust(1_000);
      const settled = yield* replies(2);
      assert.equal(settled.get("request:next")?.status, "not_started");
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect("a held call that reaches its own deadline first is refused, nothing sent", () =>
    Effect.gen(function* () {
      const { h } = yield* overdue({}, 2_500);
      yield* TestClock.adjust(500);
      const reply = yield* h.primitiveReply;
      assert.equal(reply.requestId, "request:next");
      assert.equal(reply.status, "not_started");
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect(
    "a call that passed the hold before an earlier call fell overdue is refused, never sent",
    () =>
      Effect.gen(function* () {
        const reserving = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let reserves = 0;
        const h = yield* harness({
          reservation: (request) =>
            request.action === "reserve" && ++reserves === 2
              ? Deferred.succeed(reserving, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ status: "admitted" as const, reservationId: "ticket:second" }),
                )
              : Effect.succeed(
                  request.action === "reserve"
                    ? { status: "admitted" as const, reservationId: `ticket:${request.callId}` }
                    : request.action === "validate"
                      ? {
                          status: "admitted" as const,
                          reservationId: request.reservationId,
                          permissions: { validUntilMillis: 1_800_000 },
                        }
                      : { status: "released" as const },
                ),
        });
        yield* h.push(active());
        const first = yield* h.driverStarted;
        yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
        yield* h.nextToDriver;
        yield* h.sendPrimitive(listApps("request:next", first.connectionId, 60_000));
        yield* Deferred.await(reserving);
        yield* TestClock.adjust(2_000);
        yield* Deferred.succeed(gate, undefined);
        const reply = yield* h.primitiveReply;
        assert.equal(reply.requestId, "request:next");
        assert.equal(reply.status, "not_started");
        assert.equal(sentListApps(h.log), 1);
      }),
  );

  it.effect("a provider call held across a replacement is refused, not sent to the new child", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      const first = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
      yield* h.nextToDriver;
      yield* TestClock.adjust(2_000);
      yield* h.send(call(7, "list_apps"));
      yield* TestClock.adjust(1_000);
      yield* h.driverStarted;
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 7);
      assert.isTrue(answer.result.isError);
      assert.equal(sentListApps(h.log), 1);
    }),
  );

  it.effect("a new driver that never starts holds back neither a held call nor a pause", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        acquire: (index) => (index === 0 ? Effect.void : Effect.never),
      });
      yield* h.push(active());
      yield* h.applied;
      const first = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 2_000));
      yield* h.nextToDriver;
      yield* TestClock.adjust(2_000);
      yield* h.send(call(7, "list_apps"));
      yield* TestClock.adjust(1_000);
      assert.equal(((yield* h.nextToProvider) as unknown as ToolAnswer).id, 7);
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
      assert.equal(yield* h.applied, "paused");
      assert.equal(sentListApps(h.log), 1);
    }),
  );
});
