import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ConfigProvider from "effect/ConfigProvider";
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
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import * as FileSystem from "effect/FileSystem";
import * as NetService from "@goat/shared/Net";
import { connectCommand, acquireRelayClientForLink, disconnectCloud } from "./connect.ts";

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

it.effect.each(["credential-failure", "pending-delete"] as const)(
  "logout clears authorization and reports a retry command during %s",
  (mode) =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>([
        ["cloud-cli-desired-link", new TextEncoder().encode("managed")],
        [CLOUD_LINKED_USER_ID, new TextEncoder().encode("user-1")],
      ]);
      let cleared = false;
      const warnings: string[] = [];
      const console = yield* Console.Console;
      const started = yield* Deferred.make<void>();
      const program = disconnectCloud({ clearAuthorization: true }).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          warn: (...args) => {
            warnings.push(args.join(" "));
          },
        }),
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
          getExisting:
            mode === "credential-failure"
              ? Effect.fail(
                  new CliTokenManager.CloudCliCredentialRefreshError({
                    cause: "provider unavailable",
                  }),
                )
              : Effect.succeedSome({
                  accessToken: "cached-oauth",
                  refreshToken: "refresh",
                  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
                }),
          hasCredential: Effect.succeed(true),
          store: () => Effect.die("unused"),
          clear: Effect.sync(() => {
            cleared = true;
          }),
        }),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
        }),
        Effect.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, { setCloudLinkTrust: () => Effect.void }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
      const fiber = yield* program.pipe(Effect.forkChild);
      if (mode === "pending-delete") {
        yield* Deferred.await(started);
        assert.isTrue(cleared);
        assert.equal(values.size, 0);
        yield* TestClock.adjust("5 seconds");
      }
      yield* Fiber.join(fiber);
      assert.include(warnings.join("\n"), "Remote revocation pending");
      assert.include(warnings.join("\n"), "goat connect login, then goat connect unlink");
      assert.isTrue(cleared);
      assert.equal(values.size, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { GOAT_RELAY_URL: "https://relay.example.test" } }),
          ),
          ServerConfig.layerTest("/", { prefix: "goat-connect-logout-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect.each([{ args: ["publish"] }, { args: ["link", "--publish-only"] }])(
  "publishing command %j reports the reachability-only beta without promising startup authorization",
  ({ args }) =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "connect-publishing-",
      });
      yield* Command.runWith(connectCommand, { version: "0.0.0" })([
        ...args,
        "--base-dir",
        directory,
      ]);
      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, "unavailable in the reachability-only Connect beta");
      assert.notInclude(
        (yield* TestConsole.logLines).join("\n"),
        "Restart GOAT to finish authorizing",
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
      Effect.scoped,
    ),
);
