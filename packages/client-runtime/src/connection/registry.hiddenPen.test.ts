import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { PenConnectionProfile } from "./catalog.ts";
import { PenConnectionTarget } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRouteId } from "./routes.ts";
import { BEARER_PROFILE, BEARER_TARGET, makeHarness, routesOf } from "./registry.testkit.ts";

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
