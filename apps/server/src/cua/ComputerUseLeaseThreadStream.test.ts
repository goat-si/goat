import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
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

it.effect("holds a claim bind until the matching authority revision is sent", () =>
  Effect.gen(function* () {
    const states = yield* Queue.unbounded<{ state: "active"; browserClaimVersion: number }>();
    const primitives =
      yield* Queue.unbounded<import("@goat/contracts").ComputerUsePrimitiveRequest>();
    const output = yield* Queue.unbounded<unknown>();
    yield* withPrimitiveRequests(Stream.fromQueue(states), Stream.fromQueue(primitives)).pipe(
      Stream.runForEach((value) => Queue.offer(output, value)),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Queue.offer(states, { state: "active", browserClaimVersion: 1 });
    assert.deepEqual(yield* Queue.take(output), { state: "active", browserClaimVersion: 1 });
    yield* Queue.offer(primitives, {
      state: "primitive-request",
      requestId: "bind",
      registrationId: "registration",
      controlId,
      connectionGeneration: "driver:1",
      runId: "run:bind",
      turnId: "turn:bind",
      callId: 0,
      deadlineMillis: 600_000,
      tool: "get_browser_state",
      authority: "claimBind",
      bindingVersion: 2,
      args: {},
    });
    const result = yield* Queue.take(output).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Queue.offer(states, { state: "active", browserClaimVersion: 2 });
    assert.deepEqual(yield* Fiber.join(result), { state: "active", browserClaimVersion: 2 });
    const next = yield* Queue.take(output);
    assert.equal(
      typeof next === "object" && next !== null && "state" in next ? next.state : undefined,
      "primitive-request",
    );
  }),
);

it.effect("a held bind can be cancelled before its authority snapshot arrives", () =>
  Effect.gen(function* () {
    const states = yield* Queue.unbounded<{ state: "active"; browserClaimVersion: number }>();
    const consumed = yield* Deferred.make<void>();
    const cancellations =
      yield* Queue.unbounded<import("@goat/contracts").ComputerUsePrimitiveCancel>();
    const output = yield* Queue.unbounded<unknown>();
    const request: import("@goat/contracts").ComputerUsePrimitiveRequest = {
      state: "primitive-request",
      requestId: "bind:cancel",
      registrationId: "registration",
      controlId,
      connectionGeneration: "driver:1",
      runId: "run:bind",
      turnId: "turn:bind",
      callId: 0,
      deadlineMillis: 600_000,
      tool: "get_browser_state",
      authority: "claimBind",
      bindingVersion: 2,
      args: {},
    };
    const primitives = Stream.merge(
      Stream.concat(
        Stream.make(request),
        Stream.drain(Stream.fromEffect(Deferred.succeed(consumed, undefined))),
      ),
      Stream.fromQueue(cancellations),
    );
    yield* withPrimitiveRequests(Stream.fromQueue(states), primitives).pipe(
      Stream.runForEach((value) => Queue.offer(output, value)),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Queue.offer(states, { state: "active", browserClaimVersion: 1 });
    assert.deepEqual(yield* Queue.take(output), { state: "active", browserClaimVersion: 1 });
    yield* Deferred.await(consumed);
    assert.isTrue(Option.isNone(yield* Queue.poll(output)));
    yield* Queue.offer(cancellations, { state: "primitive-cancel", requestId: request.requestId });
    assert.deepEqual(yield* Queue.take(output), {
      state: "primitive-cancel",
      requestId: request.requestId,
    });
    yield* Queue.offer(states, { state: "active", browserClaimVersion: 2 });
    assert.deepEqual(yield* Queue.take(output), { state: "active", browserClaimVersion: 2 });
    assert.isTrue(Option.isNone(yield* Queue.poll(output)));
  }),
);
