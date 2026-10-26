import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import {
  ARCHIVE,
  arch,
  platform,
  isRemoteLaunch,
  makeProtocolTestSpawner,
  makeRunningProcess,
  makeSuccessfulProcess,
  PROTOCOL_ARCHIVE,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { SshEnvironmentManager } from "./tunnel.ts";

const pending = {
  reason: "busy",
  replacement: "incompatible",
  requestedVersion: PROTOCOL_ARCHIVE.archiveVersion,
  liveVersion: "1.2.2",
} as const;

const memoryFileSystem = FileSystem.makeNoop({
  makeTempDirectoryScoped: () => Effect.succeed("/goat-shutdown-test"),
  makeDirectory: () => Effect.void,
  exists: () => Effect.succeed(false),
  writeFileString: () => Effect.void,
  chmod: () => Effect.void,
});

describe("SSH manager shutdown ownership", () => {
  it.effect.each([
    {
      name: "stops a ready runtime before shutdown completes when its launch response was pending",
      response: "ready",
      leaveRemoteServerRunning: false,
      duringLaunch: true,
      stops: 1,
    },
    {
      name: "preserves a busy pending runtime during shutdown with its launch response pending",
      response: "pending",
      leaveRemoteServerRunning: false,
      duringLaunch: true,
      stops: 0,
    },
    {
      name: "preserves an attached runtime awaiting replacement during shutdown with its launch response pending",
      response: "ready-pending",
      leaveRemoteServerRunning: false,
      duringLaunch: true,
      stops: 0,
    },
    {
      name: "leaves a ready runtime running when requested during shutdown with its launch response pending",
      response: "ready",
      leaveRemoteServerRunning: true,
      duringLaunch: true,
      stops: 0,
    },
    {
      name: "stops a ready runtime exactly once on normal shutdown",
      response: "ready",
      leaveRemoteServerRunning: false,
      duringLaunch: false,
      stops: 1,
    },
  ] as const)("$name", ({ response, leaveRemoteServerRunning, duringLaunch, stops }) =>
    Effect.gen(function* () {
      const launchEntered = yield* Deferred.make<void>();
      const releaseLaunch = yield* Deferred.make<void>();
      const count = { launches: 0, stops: 0, interrupted: false };
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
          if (command.args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n");
          if (command.args.includes("-N")) return makeRunningProcess(() => {});
          if (isRemoteLaunch(command.args)) {
            count.launches++;
            const value =
              response === "pending"
                ? { status: "pending", pending }
                : {
                    status: "ready",
                    selectedVersion: PROTOCOL_ARCHIVE.archiveVersion,
                    remotePort: 3773,
                    serverKind: "managed",
                    ...(response === "ready-pending" ? { pending } : {}),
                  };
            return {
              ...makeSuccessfulProcess(JSON.stringify(value)),
              exitCode: Deferred.succeed(launchEntered, undefined).pipe(
                Effect.andThen(duringLaunch ? Deferred.await(releaseLaunch) : Effect.void),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    count.interrupted = true;
                  }),
                ),
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }
          const stdin = command.options.stdin;
          const script =
            stdin !== undefined &&
            typeof stdin === "object" &&
            "stream" in stdin &&
            Stream.isStream(stdin.stream)
              ? yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString)
              : "";
          if (script.includes('"stopped":true')) {
            count.stops++;
            return makeSuccessfulProcess('{"stopped":true}');
          }
          return makeSuccessfulProcess("");
        }),
      );
      const scope = yield* Scope.make();
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(FileSystem.FileSystem, memoryFileSystem),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          leaveRemoteServerRunning,
        }),
      );
      const services = yield* Layer.buildWithScope(layer, scope);
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const ensure = yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.forkChild);
        yield* Deferred.await(launchEntered);
        if (!duringLaunch) yield* Fiber.join(ensure);
        // Start scope closure through its first suspension, so worker interruption precedes the response.
        const shutdown = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseLaunch, undefined);
        yield* Fiber.join(shutdown);
        assert.deepEqual(count, { launches: 1, stops, interrupted: false });
        yield* Fiber.await(ensure);
      }).pipe(
        Effect.provideContext(services),
        Effect.ensuring(Deferred.succeed(releaseLaunch, undefined)),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
    }),
  );

  it.effect.each([
    {
      name: "shutdown cancels a preparation that has not launched a runtime",
      shutdown: true,
      delayedInstall: false,
    },
    {
      name: "preparation stops by its 15-minute deadline before launching a runtime",
      shutdown: false,
      delayedInstall: false,
    },
    {
      name: "shutdown finishes by the flight deadline without waiting for a later launch timeout",
      shutdown: true,
      delayedInstall: true,
    },
  ])("$name", ({ shutdown, delayedInstall }) =>
    Effect.gen(function* () {
      const probeEntered = yield* Deferred.make<void>();
      const releaseProbe = yield* Deferred.make<void>();
      const count = { launches: 0, stops: 0, probeInterrupted: false };
      // The protocol fixture answers probes itself; observe the real preparation boundary here.
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
          if (command.args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n");
          if (command.args.includes("-N")) return makeRunningProcess(() => {});
          const stdin = command.options.stdin;
          const script =
            stdin !== undefined &&
            typeof stdin === "object" &&
            "stream" in stdin &&
            Stream.isStream(stdin.stream)
              ? yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString)
              : command.args.join(" ");
          if (script.includes('"stopped":true')) {
            count.stops++;
            return makeSuccessfulProcess('{"stopped":true}');
          }
          if (delayedInstall && script.includes("installedCandidates"))
            return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: false }));
          if (
            script.includes("installedCandidates") ||
            (delayedInstall && script.startsWith("set -- --version\n"))
          ) {
            // The probe never answers; the slow install would leave one minute before the deadline.
            return {
              ...makeSuccessfulProcess(""),
              exitCode: Deferred.succeed(probeEntered, undefined).pipe(
                Effect.andThen(
                  delayedInstall ? Effect.sleep(840_000) : Deferred.await(releaseProbe),
                ),
                Effect.as(ChildProcessSpawner.ExitCode(0)),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    count.probeInterrupted = true;
                  }),
                ),
              ),
            };
          }
          if (isRemoteLaunch(command.args)) {
            count.launches++;
            return {
              ...makeSuccessfulProcess(
                JSON.stringify({
                  status: "ready",
                  remotePort: 3773,
                  serverKind: "managed",
                  selectedVersion: ARCHIVE.archiveVersion,
                }),
              ),
              exitCode: Deferred.await(releaseProbe).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }
          return makeSuccessfulProcess("");
        }),
      );
      const scope = yield* Scope.make();
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(FileSystem.FileSystem, memoryFileSystem),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({ ...ARCHIVE, hostDownload: delayedInstall }),
          leaveRemoteServerRunning: false,
        }),
      );
      const services = yield* Layer.buildWithScope(layer, scope);
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const ensure = yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.forkChild);
        const reached = yield* Effect.raceFirst(
          Deferred.await(probeEntered).pipe(Effect.as("probe")),
          Fiber.await(ensure).pipe(Effect.as("ensure ended before the probe")),
        );
        assert.equal(reached, "probe");
        const completion = shutdown
          ? yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
          : ensure;
        yield* TestClock.adjust(shutdown && !delayedInstall ? 0 : 900_000);
        assert.isDefined(
          completion.pollUnsafe(),
          `Worker unfinished after ${count.launches} launches`,
        );
        assert.deepEqual(count, { launches: 0, stops: 0, probeInterrupted: true });
        yield* Fiber.await(ensure);
      }).pipe(
        Effect.provideContext(services),
        Effect.ensuring(Deferred.succeed(releaseProbe, undefined)),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
    }),
  );
});
