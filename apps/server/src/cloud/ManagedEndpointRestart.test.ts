import { makeHandle, unusedHttpClient } from "./ManagedEndpointRuntime.testkit.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { EnvironmentId } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import * as RelayClient from "@goat/shared/relayClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const layerRelayClientAvailable = Layer.succeed(
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
);

const emptySecretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
});

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
  httpClient = unusedHttpClient,
  secretStoreLayer = emptySecretStoreLayer,
) =>
  Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-fixture")),
    }),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    relayClientLayer,
    secretStoreLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "goat-managed-endpoint-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
  httpClient = unusedHttpClient,
  secretStoreLayer = emptySecretStoreLayer,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(runtimeDependencies(spawner, relayClientLayer, httpClient, secretStoreLayer)),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

const tunnelConfig = {
  providerKind: "cloudflare_tunnel" as const,
  connectorToken: "token",
  tunnelId: "tunnel-1",
};
const makeTransportSpawner = Effect.fnUntraced(function* (
  options: {
    transport?: string;
    failSpawn?: number;
    isRunning?: Effect.Effect<boolean>;
  } = {},
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.TUNNEL_TRANSPORT_PROTOCOL;
      if (options.transport === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
      else process.env.TUNNEL_TRANSPORT_PROTOCOL = options.transport;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
        else process.env.TUNNEL_TRANSPORT_PROTOCOL = previous;
      }),
  );
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const killed: Array<number> = [];
  const outputs: Array<Queue.Queue<Uint8Array>> = [];
  const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
  const started = yield* Queue.bounded<number>(32);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("Expected standard command.");
      }
      const index = spawned.length;
      spawned.push(command);
      if (index === options.failSpawn) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "cloudflared temporarily unavailable",
        });
      }
      const output = yield* Queue.bounded<Uint8Array>(32);
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      outputs[index] = output;
      exits[index] = exit;
      const handle = ChildProcessSpawner.makeHandle({
        ...makeHandle({
          pid: 800 + index,
          exitCode: Deferred.await(exit),
          output: Stream.fromQueue(output),
          onKill: () => {
            killed.push(800 + index);
            Deferred.doneUnsafe(exit, Exit.succeed(ChildProcessSpawner.ExitCode(143)));
          },
        }),
        isRunning: options.isRunning ?? Effect.succeed(true),
      });
      yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
      yield* Queue.offer(started, index);
      return handle;
    }),
  );
  const emit = (index: number, lines: string) =>
    Queue.offer(outputs[index]!, new TextEncoder().encode(lines));
  const observe = (
    runtime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"],
    index: number,
    lines = "",
  ) =>
    emit(index, lines + "2026-10-16T20:30:00Z INF Registered tunnel connection connIndex=0\n").pipe(
      Effect.andThen(Stream.runHead(runtime.tunnelConnected)),
    );
  return { spawner, spawned, killed, exits, started, emit, observe };
});

it.effect("restarts only the inspected connector and supervises its replacement", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportSpawner();
    const runtime = yield* buildCloudManagedEndpointRuntime(fixture.spawner);
    expect(yield* runtime.restartConnector(800, Effect.succeed(true))).toBe(false);
    yield* runtime.applyConfig(tunnelConfig);
    yield* fixture.observe(runtime, 0);
    expect(yield* runtime.inspectConnector).toMatchObject({ pid: 800 });
    expect(yield* runtime.restartConnector(799, Effect.succeed(true))).toBe(false);
    // A newer check saw the tunnel recover while this one waited for the lock.
    expect(yield* runtime.restartConnector(800, Effect.succeed(false))).toBe(false);
    expect(fixture.killed).toEqual([]);
    expect(yield* runtime.restartConnector(800, Effect.succeed(true))).toBe(true);
    expect(yield* Queue.take(fixture.started)).toBe(0);
    expect(yield* Queue.take(fixture.started)).toBe(1);
    yield* fixture.observe(runtime, 1);
    expect(fixture.killed).toContain(800);
    expect(yield* runtime.restartConnector(800, Effect.succeed(true))).toBe(false);
    expect(yield* runtime.inspectConnector).toMatchObject({ pid: 801 });
  }),
);

it.effect("decides a restart only once it holds the reconcile lock", () =>
  Effect.gen(function* () {
    const checking = yield* Deferred.make<void>();
    const releaseCheck = yield* Deferred.make<void>();
    const fixture = yield* makeTransportSpawner({
      isRunning: Deferred.succeed(checking, undefined).pipe(
        Effect.andThen(Deferred.await(releaseCheck)),
        Effect.as(true),
      ),
    });
    const runtime = yield* buildCloudManagedEndpointRuntime(fixture.spawner);
    yield* runtime.applyConfig(tunnelConfig);
    yield* fixture.observe(runtime, 0);

    // Hold reconciliation in a process probe so the restart waits for the lock.
    const probe = yield* runtime.applyConfig(tunnelConfig).pipe(Effect.forkChild);
    yield* Deferred.await(checking);
    let stillDead = true;
    const restart = yield* runtime
      .restartConnector(
        800,
        Effect.sync(() => stillDead),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    stillDead = false;
    yield* Deferred.succeed(releaseCheck, undefined);
    yield* Fiber.join(probe);

    expect(yield* Fiber.join(restart)).toBe(false);
    expect(fixture.killed).toEqual([]);
  }),
);
