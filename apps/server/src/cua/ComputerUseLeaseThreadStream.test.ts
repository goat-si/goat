import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { withPrimitiveRequests } from "./ComputerUseLeaseThreadStream.ts";

const controlId = "control:one";

it.effect("lease state overtakes a queued primitive burst", () =>
  Effect.gen(function* () {
    const states = yield* Queue.unbounded<{ state: "active" | "ended" }>();
    const primitives =
      yield* Queue.unbounded<import("@goat/contracts").ComputerUsePrimitiveRequest>();
    yield* Queue.offer(states, { state: "active" });
    yield* Queue.offer(states, { state: "ended" });
    for (let callId = 0; callId < 16; callId++)
      yield* Queue.offer(primitives, {
        state: "primitive-request",
        requestId: `request:${callId}`,
        registrationId: "registration:one",
        controlId,
        connectionGeneration: "driver:zero",
        runId: "run:one",
        turnId: "cell:one",
        callId,
        deadlineMillis: 600_000,
        tool: "click",
        args: {},
      });
    const first = yield* withPrimitiveRequests(
      Stream.fromQueue(states),
      Stream.fromQueue(primitives),
    ).pipe(Stream.take(2), Stream.runCollect);
    assert.deepEqual([...first], [{ state: "active" }, { state: "ended" }]);
  }),
);
