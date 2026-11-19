import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import * as Onboarding from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as ConnectionWakeups from "./wakeups.ts";

function layerPairingOnboarding(
  _options: undefined,
  _calls: never[],
  sshGateway: Layer.Layer<ClientCapabilities.SshEnvironmentGateway>,
  credentialWrites: string[],
) {
  const dependencies = Layer.mergeAll(
    Layer.mock(ClientCapabilities.ClientPresentation)({}),
    Layer.mock(HttpClient.HttpClient)({}),
    Layer.mock(Persistence.ConnectionTargetStore)({
      list: Effect.succeed([]),
      listDisabled: Effect.succeed([]),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      register: (registration) =>
        Effect.sync(() => {
          if (registration._tag === "SshConnectionRegistration")
            credentialWrites.push(registration.target.connectionId);
        }),
      setEnabled: () => Effect.void,
      setRoutes: () => Effect.void,
    }),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({}),
    Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({
      get: () => Effect.succeedNone,
      put: () => Effect.void,
    }),
    sshGateway,
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.mock(ConnectionDriver.ConnectionDriver)({ connect: () => Effect.never }),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
  );
  return Onboarding.layer.pipe(
    Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
  );
}

describe("SSH onboarding route trust", () => {
  it.effect("rejects an unsolicited address claiming a saved SSH identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-ssh");
      const target = { alias: "known", hostname: "known.example.test", username: "dev", port: 22 };
      const writes: string[] = [];
      const gateway = Layer.mock(ClientCapabilities.SshEnvironmentGateway)({
        provision: (requested) =>
          Effect.succeed({
            environmentId,
            label: "SSH environment",
            bootstrap: {
              target: requested,
              httpBaseUrl: "http://localhost:1234",
              wsBaseUrl: "ws://localhost:1234",
              pairingToken: null,
            },
            bearerToken: "token",
          }),
      });
      yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* onboarding.registerSsh({ target, expectedEnvironmentId: environmentId });
        const before = [...writes];
        const failure = yield* onboarding
          .registerSsh({ target: { ...target, hostname: "other.example.test" } })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
        expect(writes).toEqual(before);
        const mismatch = yield* onboarding
          .registerSsh({ target, expectedEnvironmentId: EnvironmentId.make("different-machine") })
          .pipe(Effect.flip);
        expect(mismatch.message).toContain("different machine");
        expect(writes).toEqual(before);
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, [], gateway, writes)));
    }),
  );

  it.effect("combines the known-address and Pen same-address guards", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-ssh");
      const target = { alias: "known", hostname: "known.example.test", username: "dev", port: 22 };
      const writes: string[] = [];
      const gateway = Layer.mock(ClientCapabilities.SshEnvironmentGateway)({
        provision: (requested) =>
          Effect.succeed({
            environmentId,
            label: "SSH environment",
            bootstrap: {
              target: requested,
              httpBaseUrl: "http://localhost:1234",
              wsBaseUrl: "ws://localhost:1234",
              pairingToken: null,
            },
            bearerToken: "token",
          }),
      });
      yield* Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* onboarding.registerSsh({ target, expectedEnvironmentId: environmentId });
        const before = [...writes];
        yield* onboarding.registerSsh({ target, pen: { meshId: "mesh", nodeId: "node" } });
        expect(writes).toEqual(before);
        const failure = yield* onboarding
          .registerSsh({
            target: { ...target, hostname: "other.example.test" },
            pen: { meshId: "mesh", nodeId: "node" },
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
        expect(writes).toEqual(before);
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, [], gateway, writes)));
    }),
  );
});
