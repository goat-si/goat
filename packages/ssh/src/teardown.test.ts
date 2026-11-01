import * as NodeNet from "node:net";
import * as Path from "effect/Path";
import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  commandArgs,
  hangingHttpClient,
  isRemoteLaunch,
  makeProtocolTestSpawner,
  makeSuccessfulProcess,
  PROTOCOL_ARCHIVE,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 404 })));
afterEach(() => vi.unstubAllGlobals());

// The listener proves teardown releases a real port; SIGTERM is deliberately ignored.
const fakeSsh = `const net = require("node:net");
process.on("SIGTERM", () => {});
const server = net.createServer(socket => socket.end());
server.listen(0, "127.0.0.1", () => console.log(server.address().port));`;

const makeChildFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fixtureScope = yield* Scope.Scope;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-teardown-" });
  const script = path.join(directory, "ssh.cjs");
  yield* fs.writeFileString(script, fakeSsh);
  const ready = yield* Deferred.make<{
    child: ChildProcessSpawner.ChildProcessHandle;
    port: number;
    askpassDirectory: string;
  }>();
  const spawn = (command: ChildProcess.StandardCommand) =>
    Effect.gen(function* () {
      const child = yield* native.spawn(
        ChildProcess.make(process.execPath, [script], command.options),
      );
      // A failing assertion must still reap only this captured child, even before the fix.
      yield* Scope.addFinalizer(
        fixtureScope,
        child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
      );
      const port = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      );
      const askpass = command.options.env?.SSH_ASKPASS;
      assert.isString(askpass);
      yield* Deferred.succeed(ready, {
        child,
        port: Number(port[0]),
        askpassDirectory: path.dirname(path.dirname(askpass!)),
      });
      // Do not return the handle: interruption must use the spawn scope's own finalizer.
      return yield* Effect.never;
    });
  const spawner = (kind: "command" | "tunnel") =>
    makeProtocolTestSpawner((command) => {
      const args = commandArgs(command);
      if (command._tag === "StandardCommand" && (kind === "command" || args.includes("-N")))
        return spawn(command);
      if (args.includes("-G"))
        return Effect.succeed(
          makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n"),
        );
      if (isRemoteLaunch(args))
        return Effect.succeed(
          makeSuccessfulProcess(
            '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}',
          ),
        );
      return Effect.succeed(makeSuccessfulProcess(""));
    });
  return { fs, ready, spawner };
});

const assertReleased = (input: {
  child: ChildProcessSpawner.ChildProcessHandle;
  port: number;
  askpassDirectory: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    assert.isFalse(yield* input.child.isRunning);
    assert.throws(() => process.kill(Number(input.child.pid), 0), /ESRCH/);
    assert.isFalse(yield* fs.exists(input.askpassDirectory));
    yield* Effect.callback<void>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(input.port, "127.0.0.1", () => server.close(() => resume(Effect.void)));
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH scoped teardown", () => {
  it.live.each(["command", "tunnel"] as const)(
    "reaps a SIGTERM-resistant %s interrupted during spawn and releases auth files and its port",
    (kind) =>
      Effect.gen(function* () {
        const fixture = yield* makeChildFixture;
        const operation =
          kind === "command"
            ? runSshCommand(uploadTarget, { interactiveAuth: true }).pipe(Effect.asVoid)
            : Effect.gen(function* () {
                const manager = yield* SshTunnel.SshEnvironmentManager;
                yield* manager.ensureEnvironment(uploadTarget);
              });
        const layer = Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner(kind)),
          Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            leaveRemoteServerRunning: true,
            resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          }),
        );
        const fiber = yield* operation.pipe(Effect.provide(layer), Effect.scoped, Effect.forkChild);
        const child = yield* Deferred.await(fixture.ready);
        assert.isTrue(yield* fixture.fs.exists(child.askpassDirectory));
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        // A deadline bounds the regression; no delay is used to synchronize the test.
        yield* Fiber.await(interruption).pipe(
          Effect.timeout("5 seconds"),
          Effect.andThen(assertReleased(child)),
          Effect.ensuring(child.child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.live("manager shutdown reaps a tunnel still being established", () =>
    Effect.gen(function* () {
      const fixture = yield* makeChildFixture;
      const managerScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
      const context = yield* Layer.buildWithScope(
        SshTunnel.SshEnvironmentManager.layer({
          leaveRemoteServerRunning: true,
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
        managerScope,
      );
      const manager = Context.get(context, SshTunnel.SshEnvironmentManager);
      const fiber = yield* manager
        .ensureEnvironment(uploadTarget)
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner("tunnel")),
              Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
              Layer.succeed(NetService.NetService, testNetService),
              SshAuth.SshPasswordPrompt.disabledLayer,
            ),
          ),
          Effect.forkChild,
        );
      const child = yield* Deferred.await(fixture.ready);
      yield* Scope.close(managerScope, Exit.void).pipe(
        Effect.andThen(assertReleased(child)),
        Effect.ensuring(child.child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)),
        Effect.ensuring(Fiber.interrupt(fiber)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
