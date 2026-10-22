// SSH is a fake process; forwarded HTTP and the stalled carrier use real loopback sockets.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real HTTP server must keep the forwarded response pending.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { assert, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import { closeServer, listenLoopback, makeStallRelay } from "./stallRelay.fixture.ts";
import {
  commandArgs,
  isRemoteLaunch,
  makeProtocolTestSpawner,
  makeRunningProcess,
  makeSuccessfulProcess,
  PROTOCOL_ARCHIVE,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

it.effect(
  "reaps a stalled live forward, rebinds its port, and records one cost per preparation",
  () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_request, response) => response.end("ready"));
      const upstreamPort = yield* Effect.acquireRelease(listenLoopback(server), () =>
        Effect.sync(() => server.closeAllConnections()).pipe(Effect.andThen(closeServer(server))),
      );
      const firstRelay = yield* makeStallRelay(upstreamPort);
      let relay = firstRelay;
      let forwards = 0;
      let kills = 0;
      let stops = 0;
      let spawns = 0;
      const costs: Readonly<Record<string, unknown>>[] = [];
      const logger = Logger.make(({ fiber, message }) => {
        if (String(message) === "ssh.reconnect.cost")
          costs.push(fiber.getRef(References.CurrentLogAnnotations));
      });
      const commands = makeProtocolTestSpawner((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
          if (args.includes("-N")) {
            if (forwards++ > 0) relay = yield* makeStallRelay(upstreamPort, firstRelay.port);
            const ownedRelay = relay;
            const child = makeRunningProcess(() => {
              kills++;
            });
            return {
              ...child,
              stderr: Stream.make(
                new TextEncoder().encode(
                  'Authenticated to devbox ([127.0.0.1]:22) using "publickey".\n',
                ),
              ),
              kill: () => child.kill().pipe(Effect.andThen(ownedRelay.close)),
            };
          }
          if (isRemoteLaunch(args))
            return makeSuccessfulProcess(
              '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}',
            );
          if (args.includes("sh")) {
            stops++;
            return makeSuccessfulProcess('{"stopped":true}');
          }
          return makeSuccessfulProcess("");
        }),
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          spawns++;
          return commands.spawn(command);
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeHttpClient.layerNodeHttp,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, {
          ...testNetService,
          reserveLoopbackPort: () => Effect.succeed(firstRelay.port),
        }),
        SshAuth.SshPasswordPrompt.disabledLayer,
        Logger.layer([logger], { mergeWithExisting: false }),
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          leaveRemoteServerRunning: true,
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget);
        assert.lengthOf(costs, 1);
        assert.equal(costs[0]?.spawns, spawns - 1);
        assert.equal(spawns, 4);
        const firstRequestSpawns = spawns;
        assert.equal(costs[0]?.authentications, 1);
        assert.isAtLeast(Number(costs[0]?.wallMs), 0);
        assert.containsAllKeys(costs[0]?.steps, [
          "ssh/command.runSshCommand",
          "ssh/tunnel.startSshTunnel",
        ]);
        yield* manager.revalidateTunnels();
        assert.equal(kills, 0);
        yield* Queue.clear(firstRelay.traffic);
        firstRelay.setMode("stall");
        const revalidation = yield* Effect.forkChild(manager.revalidateTunnels());
        const dropped = yield* Queue.take(firstRelay.traffic);
        assert.isFalse(dropped.forwarded);
        assert.equal(firstRelay.openSockets, 2);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(revalidation);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
        assert.equal(firstRelay.openSockets, 0);
        const second = yield* manager.ensureEnvironment(uploadTarget);
        if ("type" in first || "type" in second)
          return yield* Effect.die("Expected ready environments.");
        assert.equal(second.httpBaseUrl, first.httpBaseUrl);
        assert.equal(relay.port, firstRelay.port);
        assert.equal(forwards, 2);
        assert.lengthOf(costs, 2);
        assert.equal(costs[1]?.spawns, spawns - firstRequestSpawns - 1);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(References.MinimumLogLevel, "Info"),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
);

it.effect("records failed target resolution separately from manager preparation cost", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const costs: Readonly<Record<string, unknown>>[] = [];
    const requestCosts: Readonly<Record<string, unknown>>[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      if (String(message) === "ssh.reconnect.cost")
        costs.push(fiber.getRef(References.CurrentLogAnnotations));
      if (String(message) === "ssh.ensure.request.cost")
        requestCosts.push(fiber.getRef(References.CurrentLogAnnotations));
    });
    const spawner = ChildProcessSpawner.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.as({
          ...makeSuccessfulProcess(""),
          stderr: Stream.make(
            new TextEncoder().encode(
              'Authenticated to target ([127.0.0.1]:22) using "publickey".\n',
            ),
          ),
          exitCode: Deferred.await(finish).pipe(Effect.as(ChildProcessSpawner.ExitCode(255))),
        }),
      ),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerNodeHttp,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshTunnel.SshEnvironmentManager.layer(),
      Logger.layer([logger], { mergeWithExisting: false }),
    );
    yield* Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const preparation = yield* manager
        .ensureEnvironment(uploadTarget)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("7 seconds");
      yield* Deferred.succeed(finish, undefined);
      assert.equal((yield* Fiber.join(preparation))._tag, "Failure");
      assert.lengthOf(costs, 1);
      assert.isString(costs[0]?.operationId);
      assert.equal(costs[0]?.spawns, 0);
      assert.deepEqual(requestCosts, [
        {
          spawns: 1,
          authentications: 1,
          mastersStarted: 0,
          controlCommands: 0,
          wallMs: 7_000,
          steps: { "ssh/command.resolveSshTarget": 7_000 },
        },
      ]);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(References.MinimumLogLevel, "Info"),
      Effect.scoped,
    );
  }),
);
