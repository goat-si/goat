import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";

import { PenConnectionProfile, PenConnectionRegistration } from "./catalog.ts";
import { PenConnectionTarget } from "./model.ts";
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
