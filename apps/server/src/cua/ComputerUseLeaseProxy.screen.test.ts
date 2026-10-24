import { assert, it } from "@effect/vitest";
import type { ComputerUseLeaseUpdate, ComputerUseOverlayCommand } from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";

const call = (id: number, name: string, args: object) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const active: ComputerUseLeaseUpdate = {
  state: "active",
  controlId: "control:one",
  expiresAt: "1970-01-01T00:30:00.000Z",
};
const window = { pid: 4, window_id: 9 };

/**
 * A proxy on every app over in-memory queues; `push` returns once it acted on the update, and
 * `overlay` holds what the helper was told to draw.
 */
const harness = Effect.fn(function* (onTarget?: () => Effect.Effect<boolean>) {
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Queue.unbounded<string>();
  const toDriver = yield* Queue.unbounded<string>();
  const fromDriver = yield* Queue.unbounded<string, Cause.Done>();
  const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate>();
  // The proxy asks for the next update only once it has acted on the one before.
  const pulls = yield* Queue.unbounded<void>();
  const overlay: Array<ComputerUseOverlayCommand> = [];
  yield* runLeaseProxy({
    controlId: "control:one",
    expiresAt: DateTime.makeUnsafe("1970-01-01T00:30:00.000Z"),
    input: Stream.fromQueue(input),
    output: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
    leaseUpdates: Stream.fromEffectRepeat(
      Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(updates))),
    ),
    startDriver: Effect.succeed({
      send: (line: string) => Queue.offer(toDriver, line).pipe(Effect.asVoid),
      lines: Stream.fromQueue(fromDriver),
      kill: Queue.end(fromDriver),
      overlay: (command: ComputerUseOverlayCommand) =>
        Effect.sync(() => void overlay.push(command)),
    }),
    revokeSessions: () => Effect.void,
    ...(onTarget === undefined ? {} : { onTarget }),
  }).pipe(Effect.scoped, Effect.forkChild);
  yield* Queue.take(pulls);
  return {
    send: (line: string) => Queue.offer(input, line),
    push: (update: ComputerUseLeaseUpdate) =>
      Queue.offer(updates, update).pipe(Effect.andThen(Queue.take(pulls))),
    answer: Queue.take(output).pipe(
      Effect.map(
        (line) =>
          JSON.parse(line) as {
            readonly id: number;
            readonly result: { readonly structuredContent: object };
          },
      ),
    ),
    sentToDriver: Queue.take(toDriver).pipe(
      Effect.map((line) => (JSON.parse(line) as { readonly id: number }).id),
    ),
    driverQueued: Queue.size(toDriver),
    overlay,
  };
});

it.effect(
  "refuses calls that take the screen while another thread holds apps, and forwards background input",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      // Even a control on every app shares the screen with another thread's grant.
      yield* h.push({ ...active, shared: true });
      const screenTaking = [
        call(1, "bring_to_front", window),
        call(2, "click", { ...window, x: 5, y: 5, delivery_mode: "foreground" }),
        call(3, "move_cursor", { ...window, x: 5, y: 5 }),
      ];
      for (const [index, line] of screenTaking.entries()) {
        yield* h.send(line);
        const answer = yield* h.answer;
        assert.equal(answer.id, index + 1);
        assert.deepInclude(answer.result.structuredContent, {
          refused: "targetRefused",
          detail: "screen_shared",
        });
      }
      assert.equal(yield* h.driverQueued, 0);
      yield* h.send(call(4, "click", { ...window, x: 5, y: 5 }));
      assert.equal(yield* h.sentToDriver, 4);
    }),
);

it.effect(
  "refuses a foreground call when another thread's grant arrived while it waited to be sent",
  () =>
    Effect.gen(function* () {
      const reporting = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      // The proxy reports the call's window to the server and waits for the answer.
      const h = yield* harness(() =>
        Deferred.succeed(reporting, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(true),
        ),
      );
      yield* h.push(active);
      yield* h.send(call(1, "click", { ...window, x: 5, y: 5, delivery_mode: "foreground" }));
      yield* Deferred.await(reporting);
      yield* h.push({ ...active, shared: true });
      yield* Deferred.succeed(gate, undefined);
      const answer = yield* h.answer;
      assert.equal(answer.id, 1);
      assert.deepInclude(answer.result.structuredContent, { detail: "screen_shared" });
      assert.equal(yield* h.driverQueued, 0);
      // The cursor drew it as acting; the refusal settles that, as a reply would.
      assert.deepInclude(h.overlay.at(0), { op: "show", phase: "acting" });
      assert.deepInclude(h.overlay.at(-1), { op: "show", phase: "resting" });
    }),
);
