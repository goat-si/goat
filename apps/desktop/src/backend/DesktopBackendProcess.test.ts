import * as NodeNet from "node:net";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import { ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopBackendProcess from "./DesktopBackendProcess.ts";

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

const childShutdown = (exitOnTerm: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const scope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const ready = yield* Deferred.make<void>();
      const chunks: string[] = [];
      const script = `process.on('SIGTERM', () => { console.log('shutdown line'); ${exitOnTerm ? "process.exit(0)" : ""} }); console.log('ready'); setInterval(() => {}, 1000)`;
      const run = yield* DesktopBackendProcess.runBackendProcess({
        executablePath: process.execPath,
        entryPath: "fixture",
        args: ["-e", script],
        cwd: process.cwd(),
        env: {},
        extendEnv: true,
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 3773,
          goatHome: "/tmp/t3",
          host: "127.0.0.1",
          desktopBootstrapToken: "token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        bootstrapDelivery: "stdin",
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        captureOutput: true,
        preflightFailure: Option.none(),
        desktopTelemetryStream: Stream.empty,
        terminateGrace: Duration.millis(200),
        onOutput: (_stream, chunk) =>
          Effect.gen(function* () {
            const text = new TextDecoder().decode(chunk);
            chunks.push(text);
            if (text.includes("ready")) yield* Deferred.succeed(ready, undefined);
          }),
      }).pipe(Scope.provide(scope), Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.join(run);
      if (platform === "win32") {
        assert.isNotEmpty(exit.reason);
      } else {
        assert.equal(exit.reason, exitOnTerm ? "code=0" : "killed by SIGKILL");
        assert.include(chunks.join(""), "shutdown line");
      }
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, http))),
  );

it.live("retains SIGTERM output from a child that needs SIGKILL", () => childShutdown(false));
it.live("retains SIGTERM output from a child that exits cleanly", () => childShutdown(true));

it.live("keeps shutdown output when the scope closes while onStarted is blocked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const ready = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const allowStarted = yield* Deferred.make<void>();
      const outputSeen = yield* Deferred.make<void>();
      const server = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<import("node:net").Server>((resolve) => {
              const server = NodeNet.createServer((socket) => {
                socket.destroy();
                Deferred.doneUnsafe(ready, Effect.void);
              });
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP address");
      const scope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      let output = "";
      const script = `process.on('SIGTERM', () => { console.log('shutdown line'); process.exit(0); }); require('node:net').connect(${address.port}, '127.0.0.1'); setInterval(() => {}, 1000)`;
      const run = yield* DesktopBackendProcess.runBackendProcess({
        executablePath: process.execPath,
        entryPath: "fixture",
        args: ["-e", script],
        cwd: process.cwd(),
        env: {},
        extendEnv: true,
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 3773,
          goatHome: "/tmp/t3",
          host: "127.0.0.1",
          desktopBootstrapToken: "token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        bootstrapDelivery: "stdin",
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        captureOutput: true,
        preflightFailure: Option.none(),
        desktopTelemetryStream: Stream.empty,
        terminateGrace: Duration.millis(200),
        onStarted: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(allowStarted))),
        onOutput: (_stream, chunk) =>
          Effect.gen(function* () {
            output += new TextDecoder().decode(chunk);
            if (output.includes("shutdown line")) yield* Deferred.succeed(outputSeen, undefined);
          }),
      }).pipe(Scope.provide(scope), Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(ready);
      yield* Scope.close(scope, Exit.void);
      if (platform !== "win32") yield* Deferred.await(outputSeen);
      const captured = output;
      yield* Deferred.succeed(allowStarted, undefined);
      const exit = yield* Fiber.join(run);
      assert.isNotEmpty(exit.reason);
      if (platform !== "win32") assert.include(captured, "shutdown line");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, http))),
  ),
);

it.effect("interrupts detached output drains when exit observation defects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const drainStarted = yield* Deferred.make<void>();
      const drainStopped = yield* Deferred.make<void>();
      const stdout = Stream.fromEffect(
        Deferred.succeed(drainStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(drainStopped, undefined)),
        ),
      );
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout,
              stderr: Stream.empty,
              all: stdout,
              exitCode: Deferred.await(drainStarted).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        ),
      );
      const exit = yield* DesktopBackendProcess.runBackendProcess({
        executablePath: "/node",
        entryPath: "fixture",
        args: [],
        cwd: "/tmp",
        env: {},
        extendEnv: true,
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 3773,
          goatHome: "/tmp/t3",
          host: "127.0.0.1",
          desktopBootstrapToken: "token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        bootstrapDelivery: "stdin",
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        captureOutput: true,
        preflightFailure: Option.none(),
        desktopTelemetryStream: Stream.empty,
        onExitObserved: () => Effect.die("observation failed"),
      }).pipe(Effect.provide(Layer.merge(spawner, http)), Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Deferred.isDone(drainStopped));
    }),
  ),
);
