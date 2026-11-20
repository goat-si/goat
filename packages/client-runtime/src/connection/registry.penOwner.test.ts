import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";

import {
  BearerConnectionProfile,
  PenConnectionProfile,
  PenConnectionRegistration,
} from "./catalog.ts";
import { BearerConnectionTarget, PenConnectionTarget } from "./model.ts";
import {
  makePullRequestRoutingPermissions,
  PullRequestRoutingPermissions,
} from "./pullRequestRoutingPermissions.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { makeHarness } from "./registry.testkit.ts";

// The open viewer's case: a closed one refuses every Pen route before this check.
vi.mock("@goat/shared/penViewerGate", () => ({ PEN_VIEWER_ENABLED: true }));

const connectionId = "pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn";
const pin = {
  meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
  nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
  noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
};
const routeOf = (environmentId: EnvironmentId) => ({
  target: new PenConnectionTarget({ environmentId, label: "Box", connectionId }),
  profile: new PenConnectionProfile({ ...pin, environmentId, label: "Box", connectionId }),
});

it.effect("a Pen member's route another environment saved, in any channel, is not taken over", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([], []);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      // Another desktop channel saved the member under its environment after this one loaded.
      const saved = routeOf(EnvironmentId.make("saved"));
      yield* Ref.update(harness.storedTargets, (current) => [...current, saved.target]);
      const answered = EnvironmentId.make("answered");
      expect(yield* registry.register(new PenConnectionRegistration(routeOf(answered)))).toBe(
        false,
      );
      expect((yield* SubscriptionRef.get(registry.entries)).has(answered)).toBe(false);
      expect(yield* Ref.get(harness.storedTargets)).toEqual([saved.target]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("a registration the catalog refuses is not shown or counted as saved", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([], [], [], { refuseRegistration: () => true });
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const answered = EnvironmentId.make("answered");
      expect(yield* registry.register(new PenConnectionRegistration(routeOf(answered)))).toBe(
        false,
      );
      expect((yield* SubscriptionRef.get(registry.entries)).has(answered)).toBe(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("a Pen registration the catalog refuses leaves the trust given to the saved routes", () =>
  Effect.gen(function* () {
    const answered = EnvironmentId.make("answered");
    const bearer = new BearerConnectionTarget({
      environmentId: answered,
      label: "Box",
      connectionId: "bearer-answered",
    });
    const bearerProfile = new BearerConnectionProfile({
      environmentId: answered,
      label: "Box",
      connectionId: bearer.connectionId,
      httpBaseUrl: "https://box.example.test",
      wsBaseUrl: "wss://box.example.test",
    });
    // The newest catalog refuses the write (another channel saved the member meanwhile) while
    // this channel's view still shows no owner.
    const harness = yield* makeHarness([bearer], [bearerProfile], [], {
      refuseRegistration: (registration) => registration._tag === "PenConnectionRegistration",
    });
    const permissions = yield* makePullRequestRoutingPermissions({
      read: Effect.succeed([]),
      write: () => Effect.void,
    });
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const live = (yield* SubscriptionRef.get(registry.entries)).get(answered);
      if (live === undefined) throw new Error("the bearer environment is not listed");
      yield* permissions.set(live, "read-write");
      expect(yield* registry.register(new PenConnectionRegistration(routeOf(answered)))).toBe(
        false,
      );
      expect(yield* permissions.get(live)).toBe("read-write");
    }).pipe(
      Effect.provide(harness.layer),
      Effect.provideService(PullRequestRoutingPermissions, permissions),
      Effect.scoped,
    );
  }),
);

it.effect(
  "a person's routing change made while a refused Pen registration was pending stands",
  () =>
    Effect.gen(function* () {
      const answered = EnvironmentId.make("answered");
      const bearer = new BearerConnectionTarget({
        environmentId: answered,
        label: "Box",
        connectionId: "bearer-answered",
      });
      const bearerProfile = new BearerConnectionProfile({
        environmentId: answered,
        label: "Box",
        connectionId: bearer.connectionId,
        httpBaseUrl: "https://box.example.test",
        wsBaseUrl: "wss://box.example.test",
      });
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const listed = { target: bearer, profile: Option.some(bearerProfile), enabled: true };
      yield* permissions.set(listed, "read-write");
      const harness = yield* makeHarness([bearer], [bearerProfile], [], {
        // While the catalog write is pending the person turns routing off; the catalog refuses.
        beforeRegistrationRegister: () => permissions.set(listed, "off").pipe(Effect.orDie),
        refuseRegistration: (registration) => registration._tag === "PenConnectionRegistration",
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        expect(yield* registry.register(new PenConnectionRegistration(routeOf(answered)))).toBe(
          false,
        );
        expect(yield* permissions.get(listed)).toBe("off");
      }).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(PullRequestRoutingPermissions, permissions),
        Effect.scoped,
      );
    }),
);
