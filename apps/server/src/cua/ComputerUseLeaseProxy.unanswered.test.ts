import { assert, describe, it } from "@effect/vitest";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { active, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

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
});
