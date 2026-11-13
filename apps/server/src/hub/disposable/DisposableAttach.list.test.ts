import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as Attach from "./DisposableAttach.ts";
import { attach, world } from "./DisposableAttach.testkit.ts";

const list = (input: { readonly attachId?: string } = {}) =>
  Effect.flatMap(Attach.DisposableAttach, (service) => service.list(input));

it.effect("a list answers from stored records after a bounded wait while Pen is wedged", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      pen.control.statusGate = yield* Deferred.make<void>();
      const reading = yield* list().pipe(Effect.forkChild);
      yield* TestClock.adjust(Attach.LIST_WAIT);
      const answered = yield* Fiber.join(reading);
      expect(answered.machines.map((machine) => [machine.attachId, machine.state])).toEqual([
        [first.attachId, "invited"],
      ]);
    }),
  ),
);

it.effect("lists that arrive while a pass runs share it, so Pen is asked once", () =>
  world((pen) =>
    Effect.gen(function* () {
      yield* attach(1);
      pen.control.statusGate = yield* Deferred.make<void>();
      pen.control.statusStarted = yield* Deferred.make<void>();
      const a = yield* list().pipe(Effect.forkChild);
      yield* Deferred.await(pen.control.statusStarted);
      const b = yield* list().pipe(Effect.forkChild);
      yield* TestClock.adjust(Attach.LIST_WAIT);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      pen.control.statusStarted = undefined;
      yield* Deferred.succeed(pen.control.statusGate, undefined);
      yield* Attach.DisposableAttach.pipe(Effect.flatMap((service) => service.reconcile));
      // The reconcile above starts a fresh pass once the shared one ends: two asks in all.
      expect(pen.control.statusAsked).toHaveLength(2);
    }),
  ),
);

it.effect("a list of one attach settles only that record", () =>
  world((pen) =>
    Effect.gen(function* () {
      const first = yield* attach(1);
      yield* attach(2);
      pen.control.statusAsked.length = 0;
      yield* list({ attachId: first.attachId });
      expect(pen.control.statusAsked).toEqual([first.attachId + ".1"].map((id) => "inv-" + id));
    }),
  ),
);
