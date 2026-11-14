import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import {
  BearerConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import { SshConnectionTarget } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { makeHarness, routesOf, SSH_CONNECTION, SSH_PROFILE } from "./registry.testkit.ts";

const credential = new BearerConnectionCredential({ token: "new-token" });
const managed = new SshConnectionTarget({ ...SSH_CONNECTION, connectionId: "ssh:pen:managed" });
const managedProfile = new SshConnectionProfile({
  ...SSH_PROFILE,
  connectionId: managed.connectionId,
});
const registration = (target: SshConnectionTarget, profile: SshConnectionProfile) =>
  new SshConnectionRegistration({ target, profile, credential });

it.effect("does not save a managed route or credential over a person's same-address route", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      expect(
        yield* registry.register(registration(managed, managedProfile), {
          unlessSameAddress: true,
        }),
      ).toBe(false);
      expect(routesOf(yield* Ref.get(harness.storedTargets), managed.environmentId)).toEqual([
        SSH_CONNECTION,
      ]);
      expect((yield* Ref.get(harness.storedProfiles)).has(managed.connectionId)).toBe(false);
      expect((yield* Ref.get(harness.storedCredentials)).has(managed.connectionId)).toBe(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("saves a new managed route and lets a later manual add replace it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([]);
    yield* Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      expect(
        yield* registry.register(registration(managed, managedProfile), {
          unlessSameAddress: true,
        }),
      ).toBe(true);
      expect(routesOf(yield* Ref.get(harness.storedTargets), managed.environmentId)).toEqual([
        managed,
      ]);
      expect(yield* registry.register(registration(SSH_CONNECTION, SSH_PROFILE))).toBe(true);
      expect(routesOf(yield* Ref.get(harness.storedTargets), managed.environmentId)).toEqual([
        SSH_CONNECTION,
      ]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
