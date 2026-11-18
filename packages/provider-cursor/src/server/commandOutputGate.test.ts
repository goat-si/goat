import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { ProviderDriverKind, ThreadId, TurnItemId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeCommandOutputGate } from "./commandOutputGate.ts";

const driver = ProviderDriverKind.make("cursor");
const threadId = ThreadId.make("thread-output-gate");
const delta = (chunk: string) => ({
  type: "command_output.delta" as const,
  driver,
  threadId,
  itemId: TurnItemId.make("item-output-gate"),
  chunk,
});
const completion = {
  type: "turn.terminal",
  driver,
  providerThreadId: "provider-thread-output-gate",
  providerTurnId: "provider-turn-output-gate",
  runOrdinal: 1,
  status: "interrupted",
  failure: null,
  threadDisposition: "reusable",
} as unknown as ProviderAdapter.ProviderAdapterV2Event;

const setup = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const gate = yield* makeCommandOutputGate(10);
  return { queue, gate };
});

it.live.each(["command", "shell"])(
  "releases the oversized input behind a queued %s tail",
  (queue) =>
    Effect.gen(function* () {
      const fixture = NodeURL.fileURLToPath(
        new URL("./test/cursorOutputStorage.mjs", import.meta.url),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["--expose-gc", fixture, queue], { stderr: "inherit" }),
      );
      assert.equal(yield* child.exitCode, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a flood waits for the reader and the count is back at zero after a drain", () =>
  Effect.gen(function* () {
    const { queue, gate } = yield* setup;
    const producer = yield* Effect.forEach(["aaaa", "bbbb", "cccc", "dddd"], (chunk) =>
      gate.offer(queue, delta(chunk), () => false),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    assert.equal(gate.queued(), 8);
    assert.isUndefined(producer.pollUnsafe());
    const taken: Array<string> = [];
    for (let index = 0; index < 4; index++) {
      const event = yield* gate.take(queue);
      if (event.type === "command_output.delta") taken.push(event.chunk);
    }
    assert.deepEqual(yield* Fiber.join(producer), [true, true, true, true]);
    assert.deepEqual(taken, ["aaaa", "bbbb", "cccc", "dddd"]);
    assert.equal(gate.queued(), 0);
  }).pipe(Effect.scoped),
);

it.effect.each(["stop", "close"] as const)(
  "%s releases a delta waiting at the bound and drops it",
  (how) =>
    Effect.gen(function* () {
      const { queue, gate } = yield* setup;
      let stopped = false;
      yield* gate.offer(queue, delta("aaaaaaaa"), () => stopped);
      const waiting = yield* gate
        .offer(queue, delta("bbbb"), () => stopped)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      assert.isUndefined(waiting.pollUnsafe());
      if (how === "stop") {
        stopped = true;
        yield* gate.wakeAll;
      } else {
        yield* gate.close;
      }
      assert.isFalse(yield* Fiber.join(waiting));
      assert.equal(yield* Queue.size(queue), 1);
    }).pipe(Effect.scoped),
);

it.effect("a waiting delta never reaches the reader after its turn's completion", () =>
  Effect.gen(function* () {
    const { queue, gate } = yield* setup;
    let finalized = false;
    yield* gate.offer(queue, delta("aaaaaaaa"), () => finalized);
    const waiting = yield* gate
      .offer(queue, delta("late"), () => finalized)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    finalized = true;
    yield* gate.wakeAll;
    yield* Queue.offer(queue, completion);
    assert.isFalse(yield* Fiber.join(waiting));
    const first = yield* gate.take(queue);
    const second = yield* gate.take(queue);
    assert.equal(first.type, "command_output.delta");
    assert.equal(second.type, "turn.terminal");
    assert.equal(yield* Queue.size(queue), 0);
    assert.equal(gate.queued(), 0);
  }).pipe(Effect.scoped),
);

it.effect("a stalled reader bounds the number of tiny deltas independently of their size", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const gate = yield* makeCommandOutputGate();
    const event = delta("x");
    for (let index = 0; index < 1024; index++) {
      yield* gate.offer(queue, event, () => false);
    }
    const producer = yield* gate
      .offer(queue, event, () => false)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    assert.equal(yield* Queue.size(queue), 1024);
    assert.isUndefined(producer.pollUnsafe());
    yield* gate.take(queue);
    yield* Fiber.join(producer);
    assert.equal(yield* Queue.size(queue), 1024);
  }).pipe(Effect.scoped),
);

it.effect(
  "bounds an oversized delta to the queue's character budget and charges its queued length",
  () =>
    Effect.gen(function* () {
      const { queue, gate } = yield* setup;
      const oversized = "prefix:01234567\ud8009";
      assert.isTrue(yield* gate.offer(queue, delta(oversized), () => false));
      const next = yield* gate
        .offer(queue, delta("x"), () => false)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      assert.isUndefined(next.pollUnsafe());
      const charged = gate.queued();
      const event = yield* gate.take(queue);
      assert.equal(event.type === "command_output.delta" ? event.chunk : null, "01234567\ud8009");
      assert.equal(charged, 10);
      assert.isTrue(yield* Fiber.join(next));
      yield* gate.take(queue);
      assert.equal(gate.queued(), 0);
    }).pipe(Effect.scoped),
);
