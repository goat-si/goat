import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { BearerConnectionRegistration, PenConnectionProfile } from "./catalog.ts";
import { PenConnectionTarget } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRouteId, connectionRoutes } from "./routes.ts";
import {
  BEARER_CREDENTIAL,
  BEARER_PROFILE,
  BEARER_TARGET,
  makeHarness,
  routesOf,
} from "./registry.testkit.ts";

const environmentId = BEARER_TARGET.environmentId;
const penId = "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn";
const pen = new PenConnectionTarget({ environmentId, label: "Pen", connectionId: penId });
const penProfile = new PenConnectionProfile({
  environmentId,
  label: "Pen",
  connectionId: penId,
  meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
  nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
  noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
});

it.effect(
  "removing the last route the closed Pen gate shows takes the environment off the list and keeps its saved Pen route and data",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([BEARER_TARGET, pen], [BEARER_PROFILE, penProfile]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        expect((yield* SubscriptionRef.get(registry.entries)).has(environmentId)).toBe(true);
        yield* registry.removeRoute(environmentId, connectionRouteId(BEARER_TARGET));
        expect((yield* SubscriptionRef.get(registry.entries)).has(environmentId)).toBe(false);
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([pen]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect(
  "an environment saved with only Pen routes stays saved but off the list while the gate is closed",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([pen], [penProfile]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        expect((yield* SubscriptionRef.get(registry.entries)).has(environmentId)).toBe(false);
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([pen]);
        expect(
          Option.isSome(Option.fromNullishOr((yield* Ref.get(harness.storedProfiles)).get(penId))),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

const bearerAgain = new BearerConnectionRegistration({
  target: BEARER_TARGET,
  profile: BEARER_PROFILE,
  credential: BEARER_CREDENTIAL,
});

it.effect.each(["after its last shown route is removed", "after a restart"] as const)(
  "registering the environment again keeps its hidden Pen route %s",
  (when) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        when === "after a restart" ? [pen] : [BEARER_TARGET, pen],
        when === "after a restart" ? [penProfile] : [BEARER_PROFILE, penProfile],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        if (when !== "after a restart")
          yield* registry.removeRoute(environmentId, connectionRouteId(BEARER_TARGET));
        yield* registry.register(bearerAgain);
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual(
          when === "after a restart" ? [pen, BEARER_TARGET] : [BEARER_TARGET, pen],
        );
        expect((yield* Ref.get(harness.storedProfiles)).has(penId)).toBe(true);
        const live = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(
          live === undefined ? [] : connectionRoutes(live).map((route) => route.target),
        ).toEqual([BEARER_TARGET]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("a hidden Pen route saved first does not name or stand in for the environment", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([pen, BEARER_TARGET], [penProfile, BEARER_PROFILE]);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const live = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
      expect(live?.target).toEqual(BEARER_TARGET);
      expect(live?.alternateRoutes).toBeUndefined();
      yield* registry.setEnabled(environmentId, false);
      expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([
        pen,
        BEARER_TARGET,
      ]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
