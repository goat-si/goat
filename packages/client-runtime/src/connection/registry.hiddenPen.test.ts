import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  PenConnectionProfile,
  PenConnectionRegistration,
  PrimaryConnectionRegistration,
} from "./catalog.ts";
import { BearerConnectionTarget, PenConnectionTarget, PrimaryConnectionTarget } from "./model.ts";
import { ConnectionPersistenceError } from "../platform/persistence.ts";
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
  "removing the last route the closed Pen gate shows removes the environment as on dev and keeps only its saved Pen route",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([BEARER_TARGET, pen], [BEARER_PROFILE, penProfile], [], {
        initialDisabled: [environmentId],
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        expect((yield* SubscriptionRef.get(registry.entries)).has(environmentId)).toBe(true);
        yield* registry.removeRoute(environmentId, connectionRouteId(BEARER_TARGET));
        expect((yield* SubscriptionRef.get(registry.entries)).has(environmentId)).toBe(false);
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([pen]);
        expect((yield* Ref.get(harness.storedProfiles)).get(penId)).toEqual(penProfile);
        // Drafts, the outbox, cached data and the off switch go, as when the environment is removed.
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([environmentId]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([environmentId]);
        expect([...(yield* Ref.get(harness.storedDisabled))]).toEqual([]);
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
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([
          pen,
          BEARER_TARGET,
        ]);
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

it.effect(
  "a failed save while removing the last shown route never loses the hidden Pen route",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([BEARER_TARGET, pen], [BEARER_PROFILE, penProfile], [], {
        beforeRegistrationRegister: () =>
          Effect.fail(
            new ConnectionPersistenceError({
              operation: "register-connection",
              message: "disk full",
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRoute(environmentId, connectionRouteId(BEARER_TARGET));
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([pen]);
        expect((yield* Ref.get(harness.storedProfiles)).get(penId)).toEqual(penProfile);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect(
  "an environment whose only usable route is missing keeps its first shown route, as on dev",
  () =>
    Effect.gen(function* () {
      const learned = new BearerConnectionTarget({
        environmentId,
        label: "Learned",
        connectionId: "learned:environment-bearer:http://192.168.1.10:3773",
      });
      const harness = yield* makeHarness([learned, pen], [penProfile]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        expect((yield* SubscriptionRef.get(registry.entries)).get(environmentId)?.target).toEqual(
          learned,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("a failed save leaves the hidden Pen route where the saved routes have it", () =>
  Effect.gen(function* () {
    const second = new BearerConnectionTarget({
      environmentId,
      label: "Second",
      connectionId: "bearer-second",
    });
    const secondProfile = new BearerConnectionProfile({
      ...BEARER_PROFILE,
      connectionId: second.connectionId,
      httpBaseUrl: "https://second.example.test",
      wsBaseUrl: "wss://second.example.test",
    });
    let failures = 1;
    const harness = yield* makeHarness(
      [BEARER_TARGET, second, pen],
      [BEARER_PROFILE, secondProfile, penProfile],
      [],
      {
        beforeRoutesSet: () =>
          failures-- > 0
            ? Effect.fail(
                new ConnectionPersistenceError({
                  operation: "set-connection-routes",
                  message: "disk full",
                }),
              )
            : Effect.void,
      },
    );
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* Effect.exit(registry.removeRoute(environmentId, connectionRouteId(second)));
      yield* registry.reorderRoutes(environmentId, [
        connectionRouteId(second),
        connectionRouteId(BEARER_TARGET),
      ]);
      expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([
        second,
        BEARER_TARGET,
        pen,
      ]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("the registry refuses a Pen route while the gate is closed", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([BEARER_TARGET], [BEARER_PROFILE]);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      expect(
        yield* registry.register(
          new PenConnectionRegistration({ target: pen, profile: penProfile }),
        ),
      ).toBe(false);
      const live = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
      expect(live === undefined ? [] : connectionRoutes(live).map((route) => route.target)).toEqual(
        [BEARER_TARGET],
      );
      expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([
        BEARER_TARGET,
      ]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("reordering keeps a Pen route another channel saved after this one loaded", () =>
  Effect.gen(function* () {
    const second = new BearerConnectionTarget({
      environmentId,
      label: "Second",
      connectionId: "bearer-second",
    });
    const secondProfile = new BearerConnectionProfile({
      ...BEARER_PROFILE,
      connectionId: second.connectionId,
      httpBaseUrl: "https://second.example.test",
      wsBaseUrl: "wss://second.example.test",
    });
    const harness = yield* makeHarness([BEARER_TARGET, second], [BEARER_PROFILE, secondProfile]);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* Ref.update(harness.storedTargets, (current) => [...current, pen]);
      yield* registry.reorderRoutes(environmentId, [
        connectionRouteId(second),
        connectionRouteId(BEARER_TARGET),
      ]);
      expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([
        second,
        BEARER_TARGET,
        pen,
      ]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "an environment whose last route is removed, with no Pen route to keep, is not saved any more",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([BEARER_TARGET], [BEARER_PROFILE]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRoute(environmentId, connectionRouteId(BEARER_TARGET));
        // Another desktop channel pairs the environment again.
        yield* Ref.update(harness.storedTargets, (current) => [...current, BEARER_TARGET]);
        // A local backend with the same id must not take that pairing for one this channel saved.
        yield* registry.registerPlatform(
          new PrimaryConnectionRegistration({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Local",
              httpBaseUrl: "http://127.0.0.1:3773",
              wsBaseUrl: "ws://127.0.0.1:3773",
            }),
          }),
        );
        expect(routesOf(yield* Ref.get(harness.storedTargets), environmentId)).toEqual([
          BEARER_TARGET,
        ]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);
