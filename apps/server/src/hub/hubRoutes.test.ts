import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import type { Caller } from "./HubMembership.ts";
import { scope } from "./HubMembership.testkit.ts";
import type { HubOcx, OcxOutput } from "./HubOcx.ts";
import { makeRoutes } from "./hubRoutes.ts";

const LINK = "lnk_0123456789abcdef";
const change = {
  deviceAlias: "mini",
  change: { op: "add" as const, route: "pen-mini" },
  decisionId: "decision-1",
};
const caller = { actor: "agent", profile: "hub-admin", owner: false } as unknown as Caller;
const stored: OcxOutput = {
  code: 0,
  stdout: JSON.stringify({ linkId: LINK, pin: "mini", routes: ["pen-mini", "mini"] }),
};

// An approved change, where the test controls the ocx run and the recording of the approval.
const routesWith = (
  run: (admit: Effect.Effect<boolean>) => Effect.Effect<OcxOutput>,
  used: Effect.Effect<void>,
) =>
  makeRoutes({
    ocx: {
      home: () => run(Effect.succeed(true)),
      homeAdmitted: (
        _args: ReadonlyArray<string>,
        _timeoutMs: number,
        admit: Effect.Effect<boolean>,
      ) => run(admit),
    } as unknown as HubOcx["Service"],
    authorize: () => Effect.succeed(caller),
    permitHost: () => Effect.void,
    readHomeLinks: () =>
      Effect.succeed({
        status: { role: "home" as const, links: [{ id: LINK, alias: "mini" }] },
        forbidden: false,
      }),
    request: () => Effect.die("an approved change asks nobody"),
    approved: () => Effect.void,
    used: (_caller, decisionId) => (decisionId === undefined ? Effect.void : used),
    audit: () => Effect.void,
  });

it.effect(
  "an interruption while the approval is being recorded, after the Home answered, still records it",
  () =>
    Effect.gen(function* () {
      const recording = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const recorded = yield* Ref.make(false);
      const routes = routesWith(
        (admit) => admit.pipe(Effect.as(stored)),
        Deferred.succeed(recording, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(Ref.set(recorded, true)),
        ),
      );
      const fiber = yield* routes.update(scope, change).pipe(Effect.forkChild);
      yield* Deferred.await(recording);
      yield* Effect.sync(() => fiber.interruptUnsafe());
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      expect(yield* Ref.get(recorded)).toBe(true);
    }),
);

it.effect("an interruption before ocx starts leaves the approval unspent", () =>
  Effect.gen(function* () {
    const preparing = yield* Deferred.make<void>();
    const spent = yield* Ref.make(false);
    // The run stops while ocx is still being found, before it would admit and start.
    const routes = routesWith(
      () => Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never)),
      Ref.set(spent, true),
    );
    const fiber = yield* routes.update(scope, change).pipe(Effect.forkChild);
    yield* Deferred.await(preparing);
    yield* Fiber.interrupt(fiber);
    expect(yield* Ref.get(spent)).toBe(false);
  }),
);
