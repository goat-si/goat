import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { EnvironmentId } from "@goat/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { assert, it } from "@effect/vitest";
import * as RelayClient from "@goat/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { acquireRelayClientForLink, disconnectCloud } from "./connect.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

/** Captures console lines from a successful local disconnect report. */

it.effect(
  "logout clears local authorization when remote revocation cannot reach Clerk or the relay",
  () =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>([
        ["cloud-cli-desired-link", new TextEncoder().encode("managed")],
        [CLOUD_LINKED_USER_ID, new TextEncoder().encode("user-1")],
      ]);
      let cleared = false;
      yield* disconnectCloud({ clearAuthorization: true }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, {
          get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
          set: (name, value) =>
            Effect.sync(() => {
              values.set(name, value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              values.delete(name);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
        Effect.provideService(CliTokenManager.CloudCliTokenManager, {
          approveLink: () => Effect.die("logout must not request approval"),
          get: Effect.die("unused"),
          getExisting: Effect.fail(
            new CliTokenManager.CloudCliCredentialRefreshError({ cause: "provider unavailable" }),
          ),
          hasCredential: Effect.succeed(true),
          store: () => Effect.die("unused"),
          clear: Effect.sync(() => {
            cleared = true;
          }),
        }),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
        }),
        Effect.provide(Layer.mock(EnvironmentAuth.EnvironmentAuth, {})),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("logout must not request a fresh token")),
        ),
      );
      assert.isTrue(cleared);
      assert.equal(values.size, 0);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/", { prefix: "goat-connect-logout-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);
