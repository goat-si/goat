import { makeHandle, unusedHttpClient } from "./ManagedEndpointRuntime.testkit.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { EnvironmentId } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import * as RelayClient from "@goat/shared/relayClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Runtime from "./ManagedEndpointRuntime.ts";

it.effect("restarts a relay client that ignores SIGTERM within a bounded time", () => {
  const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
  return Effect.gen(function* () {
    const started = yield* Queue.unbounded<number>();
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const pid = 900 + exits.length;
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        exits.push(exit);
        const handle = ChildProcessSpawner.makeHandle({
          ...makeHandle({ pid, exitCode: Deferred.await(exit), onKill: () => {} }),
          kill: (options) =>
            options?.forceKillAfter === undefined
              ? Deferred.await(exit).pipe(Effect.asVoid)
              : Effect.sleep(options.forceKillAfter).pipe(
                  Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(137))),
                  Effect.asVoid,
                ),
        });
        yield* Queue.offer(started, pid);
        return handle;
      }),
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-fixture")),
      }),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, unusedHttpClient),
      Layer.succeed(
        RelayClient.RelayClient,
        RelayClient.RelayClient.of({
          resolve: Effect.succeed({
            status: "available",
            executablePath: "cloudflared",
            source: "path",
            version: RelayClient.CLOUDFLARED_VERSION,
          }),
          install: Effect.die("unused"),
          installWithProgress: () => Effect.die("unused"),
          pruneManagedVersions: Effect.void,
        }),
      ),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-managed-endpoint-" }),
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
    const context = yield* Layer.build(Runtime.layer.pipe(Layer.provide(dependencies)));
    const runtime = yield* Effect.service(Runtime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
    yield* runtime.applyConfig({
      providerKind: "cloudflare_tunnel",
      connectorToken: "token",
      tunnelId: "tunnel-1",
    });
    expect(yield* Queue.take(started)).toBe(900);
    const restart = yield* runtime
      .restartConnector(900, Effect.succeed(true))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(Duration.minutes(1));
    expect(restart.pollUnsafe()).toEqual(Exit.succeed(true));
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Effect.forEach(exits, (exit) => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143)), {
          discard: true,
        }),
      ),
    ),
  );
});
