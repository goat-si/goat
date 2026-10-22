// @effect-diagnostics nodeBuiltinImport:off -- Bind the actual OpenSSH temporary socket path on the host OS.
import * as NodeNet from "node:net";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { SshReconnectCost, hasUserSshSharing } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import { SshEnvironmentManager } from "./tunnel.ts";
import {
  commandArgs,
  isRemoteLaunch,
  makeProtocolTestSpawner,
  makeRunningProcess,
  makeSuccessfulProcess,
  PROTOCOL_ARCHIVE,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

const fixture = (
  mode:
    | "healthy"
    | "stop-runtime"
    | "password"
    | "start-fails"
    | "forward-fails"
    | "user-path"
    | "user-master"
    | "windows" = "healthy",
) =>
  Effect.sync(() => {
    const commands: ChildProcess.Command[] = [];
    const events: string[] = [];
    let prompts = 0;
    let currentDie = Effect.void;
    const die = Effect.suspend(() => currentDie);
    const commandStarted = Deferred.makeUnsafe<void>();
    let holdCommand = false;
    let masterExit = Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>;
    const holdNextCommand = Effect.sync(() => {
      holdCommand = true;
    });
    let identity = "/fixture/id";
    const changeIdentity = Effect.sync(() => {
      identity = "/fixture/other-id";
    });
    const newMasterProcess = () => {
      const exit = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
      masterExit = Deferred.await(exit);
      let running = true;
      const stop = Effect.sync(() => {
        running = false;
      }).pipe(
        Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(255))),
        Effect.asVoid,
      );
      currentDie = stop;
      return {
        ...makeRunningProcess(() => {}),
        isRunning: Effect.sync(() => running),
        exitCode: Deferred.await(exit),
        stderr: Stream.make(
          new TextEncoder().encode(
            'Authenticated to devbox using "password".\ndebug1: Entering interactive session.\n',
          ),
        ),
        kill: () =>
          Effect.sync(() => {
            events.push("kill-master");
          }).pipe(Effect.andThen(stop)),
      };
    };
    const failedAuth = () => ({
      ...makeSuccessfulProcess(""),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
      stderr: Stream.make(new TextEncoder().encode("Permission denied (publickey,password).\n")),
    });
    const spawner = makeProtocolTestSpawner((command) =>
      Effect.sync(() => {
        commands.push(command);
        const args = commandArgs(command);
        if (args.includes("-G"))
          return makeSuccessfulProcess(
            `hostname devbox.example.com\nuser julius\nport 2222\ncontrolmaster ${mode === "user-master" ? "auto" : "false"}\n${mode === "user-path" ? "controlpath /private/user/socket\n" : ""}proxycommand cloudflared access ssh --hostname %h\nidentityfile ${identity}\n`,
          );
        if (args.includes("-M")) {
          events.push("master");
          if (mode === "start-fails") return makeSuccessfulProcess("");
          if (
            mode === "password" &&
            command._tag === "StandardCommand" &&
            command.options.env?.GOAT_SSH_AUTH_SECRET !== "fixture-password"
          )
            return failedAuth();
          return newMasterProcess();
        }
        if (args.includes("-O")) {
          const operation = args[args.indexOf("-O") + 1]!;
          events.push(operation);
          return mode === "forward-fails" && operation === "forward"
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
              }
            : makeSuccessfulProcess("");
        }
        if (args.includes("-N")) {
          events.push("standalone-forward");
          return makeRunningProcess(() => events.push("kill-forward"));
        }
        if (holdCommand && args.includes("sh")) {
          holdCommand = false;
          return {
            ...makeSuccessfulProcess(""),
            stderr: Stream.make(
              new TextEncoder().encode("mux_client_read_packet: read header failed: Broken pipe\n"),
            ),
            exitCode: Deferred.succeed(commandStarted, undefined).pipe(Effect.andThen(masterExit)),
          };
        }
        if (mode === "password" && prompts === 0) return failedAuth();
        if (isRemoteLaunch(args))
          return makeSuccessfulProcess(
            '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773}\n',
          );
        if (mode === "stop-runtime") events.push("stop-runtime");
        return makeSuccessfulProcess('{"stopped":true}\n');
      }),
    );
    const platform = mode === "windows" ? "win32" : "linux";
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      Layer.succeed(SshAuth.SshPasswordPrompt, {
        isAvailable: mode === "password",
        request: () =>
          Effect.sync(() => {
            prompts++;
            return "fixture-password";
          }),
      }),
      SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        leaveRemoteServerRunning: mode !== "stop-runtime",
      }),
    );
    return {
      commands,
      events,
      die,
      changeIdentity,
      layer,
      platform,
      holdNextCommand,
      commandStarted,
      prompts: () => prompts,
    };
  });

const run = <A, E>(
  mode: Parameters<typeof fixture>[0],
  body: (
    f: Effect.Success<ReturnType<typeof fixture>>,
    manager: SshEnvironmentManager["Service"],
  ) => Effect.Effect<
    A,
    E,
    Effect.Services<ReturnType<SshEnvironmentManager["Service"]["ensureEnvironment"]>>
  >,
  tempDirectory?: string,
) =>
  Effect.gen(function* () {
    const f = yield* fixture(mode);
    return yield* Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      return yield* body(f, manager);
    }).pipe(
      Effect.updateService(FileSystem.FileSystem, (fs) =>
        tempDirectory === undefined
          ? fs
          : {
              ...fs,
              makeTempDirectoryScoped: (options) =>
                fs.makeTempDirectoryScoped({
                  ...options,
                  directory: options?.directory ?? tempDirectory,
                }),
            },
      ),
      Effect.scoped,
      Effect.provide(f.layer),
      Effect.provideService(HostProcess.Platform, f.platform),
    );
  });

describe("scoped SSH master", () => {
  it.effect("binds the OpenSSH temporary control socket within the macOS sun_path limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const longTemp = yield* fs.makeTempDirectoryScoped({
        directory: "/tmp",
        prefix: `goat-macos-tmp-${"x".repeat(25)}`,
      });
      return yield* run(
        "healthy",
        (f, manager) =>
          Effect.gen(function* () {
            yield* manager.ensureEnvironment(uploadTarget);
            const args = commandArgs(f.commands.find((c) => commandArgs(c).includes("-M"))!);
            const socket = args[args.indexOf("-S") + 1]!;
            const temporary = `${socket}.${"a".repeat(16)}`;
            yield* Effect.tryPromise(
              () =>
                new Promise<void>((resolve, reject) => {
                  const server = NodeNet.createServer();
                  server.once("error", reject);
                  server.listen(temporary, () =>
                    server.close((error) => (error ? reject(error) : resolve())),
                  );
                }),
            );
            assert.isBelow(Buffer.byteLength(temporary), 104);
            assert.equal(Buffer.byteLength(temporary) - Buffer.byteLength(socket), 17);
            yield* manager.disconnectEnvironment(uploadTarget);
          }),
        longTemp,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns a typed error for an in-flight command when its master dies, then falls back",
    () =>
      run("healthy", (f, manager) =>
        Effect.gen(function* () {
          yield* manager.ensureEnvironment(uploadTarget);
          yield* f.holdNextCommand;
          const pending = yield* manager
            .runRemoteScript(uploadTarget, { script: "echo interrupted" })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(f.commandStarted);
          assert.include(commandArgs(f.commands.at(-1)!), "-S");
          yield* f.die;
          const result = yield* Fiber.join(pending);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.instanceOf(result.failure, SshCommandError);
            if (result.failure instanceof SshCommandError) {
              assert.equal(result.failure.exitCode, 255);
              assert.include(result.failure.stderr, "Broken pipe");
            }
          }
          yield* manager.runRemoteScript(uploadTarget, { script: "echo fallback" });
          assert.notInclude(commandArgs(f.commands.at(-1)!), "-S");
          yield* manager.revalidateTunnels();
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.events.filter((event) => event === "master").length, 2);
          yield* manager.disconnectEnvironment(uploadTarget);
        }),
      ),
  );

  it.effect(
    "shares preparation and commands, cancels the forward before killing its master, and passes askpass to the master",
    () =>
      run("healthy", (f, manager) =>
        Effect.gen(function* () {
          const cost = {
            active: true,
            spawns: 0,
            authentications: 0,
            mastersStarted: 0,
            controlCommands: 0,
            steps: {},
          };
          const workerCosts: Readonly<Record<string, unknown>>[] = [];
          const logger = Logger.make(({ fiber, message }) => {
            if (String(message) === "ssh.reconnect.cost")
              workerCosts.push(fiber.getRef(References.CurrentLogAnnotations));
          });
          yield* manager
            .ensureEnvironment(uploadTarget)
            .pipe(
              Effect.provideService(SshReconnectCost, cost),
              Effect.provideService(References.MinimumLogLevel, "Info"),
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            );
          const resolve = f.commands.find((c) => commandArgs(c).includes("-G"))!;
          assert.includeMembers([...commandArgs(resolve)], ["-p", "2222", "julius@devbox"]);
          const master = f.commands.find((c) => commandArgs(c).includes("-M"))!;
          const args = commandArgs(master);
          const socket = args[args.indexOf("-S") + 1]!;
          assert.isBelow(new TextEncoder().encode(socket).length, 104);
          assert.match(socket, /\/goat-ssh-runtime-[^/]+\/[a-f0-9]{12}$/u);
          assert.include(args, "ControlPersist=no");
          assert.include(args, "ServerAliveInterval=15");
          assert.include(args, "ServerAliveCountMax=3");
          assert.include(args, "BatchMode=no");
          assert.equal(master._tag, "StandardCommand");
          if (master._tag === "StandardCommand") {
            assert.equal(master.options.env?.SSH_ASKPASS_REQUIRE, "force");
            assert.include(master.options.env?.SSH_ASKPASS, "/t3code-ssh-askpass/");
            const fs = yield* FileSystem.FileSystem;
            assert.equal(
              (yield* fs.stat(socket.slice(0, socket.lastIndexOf("/")))).mode! & 0o777,
              0o700,
            );
          }
          const remote = f.commands.filter((c) => commandArgs(c).includes("sh"));
          assert.isAtLeast(remote.length, 1);
          for (const command of remote) {
            assert.includeMembers([...commandArgs(command)], ["-S", socket, "ControlMaster=no"]);
            assert.includeMembers(
              [...commandArgs(command)],
              ["ServerAliveInterval=15", "ServerAliveCountMax=3"],
            );
          }
          assert.lengthOf(workerCosts, 1);
          assert.isString(workerCosts[0]?.operationId);
          assert.equal(workerCosts[0]?.mastersStarted, 1);
          assert.equal(workerCosts[0]?.controlCommands, 2);
          assert.equal(workerCosts[0]?.authentications, 1);
          assert.equal(cost.mastersStarted, 0);
          assert.equal(cost.controlCommands, 0);
          assert.equal(cost.authentications, 0);
          yield* manager.runRemoteScript(uploadTarget, { script: "echo test" });
          assert.includeMembers([...commandArgs(f.commands.at(-1)!)], ["-S", socket]);
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.deepEqual(f.events, ["master", "check", "forward", "cancel", "kill-master"]);
          assert.includeMembers(
            [...commandArgs(f.commands.find((c) => commandArgs(c).includes("cancel"))!)],
            ["-L", "41773:127.0.0.1:3773"],
          );
          assert.isFalse(
            yield* (yield* FileSystem.FileSystem).exists(socket.slice(0, socket.lastIndexOf("/"))),
          );
        }),
      ),
  );

  it.effect(
    "falls back for commands when the master dies and replaces the dead forward on reconnect",
    () =>
      run("healthy", (f, manager) =>
        Effect.gen(function* () {
          yield* manager.ensureEnvironment(uploadTarget);
          yield* f.die;
          yield* manager.runRemoteScript(uploadTarget, { script: "echo fallback" });
          const args = commandArgs(f.commands.at(-1)!);
          assert.notInclude(args, "-S");
          assert.include(args, "ServerAliveInterval=15");
          yield* manager.revalidateTunnels();
          assert.include(f.events, "cancel");
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.events.filter((e) => e === "master").length, 2);
          yield* manager.disconnectEnvironment(uploadTarget);
        }),
      ),
  );

  it.effect("prompts once and authenticates the master with the askpass secret", () =>
    run("password", (f, manager) =>
      Effect.gen(function* () {
        yield* manager.ensureEnvironment(uploadTarget);
        yield* manager.runRemoteScript(uploadTarget, { script: "echo shared" });
        assert.equal(f.prompts(), 1);
        const master = f.commands.findLast((c) => commandArgs(c).includes("-M"))!;
        if (master._tag === "StandardCommand") {
          assert.equal(master.options.env?.GOAT_SSH_AUTH_SECRET, "fixture-password");
          assert.equal(master.options.env?.SSH_ASKPASS_REQUIRE, "force");
          assert.include(commandArgs(master), "BatchMode=no");
        }
        assert.include(commandArgs(f.commands.at(-1)!), "-S");
        yield* manager.disconnectEnvironment(uploadTarget);
      }),
    ),
  );

  it.effect("cancels before killing the master when the manager scope ends", () =>
    Effect.gen(function* () {
      const events = yield* run("healthy", (f, manager) =>
        manager.ensureEnvironment(uploadTarget).pipe(Effect.as(f.events)),
      );
      assert.deepEqual(events, ["master", "check", "forward", "cancel", "kill-master"]);
    }),
  );

  it.effect("uses the live master for the shutdown command before cancelling and killing it", () =>
    Effect.gen(function* () {
      const f = yield* run("stop-runtime", (f, manager) =>
        manager.ensureEnvironment(uploadTarget).pipe(Effect.as(f)),
      );
      assert.deepEqual(f.events, [
        "master",
        "check",
        "forward",
        "stop-runtime",
        "cancel",
        "kill-master",
      ]);
      const stop = f.commands.findLast((c) => commandArgs(c).includes("sh"))!;
      assert.include(commandArgs(stop), "-S");
    }),
  );

  it.effect("does not reuse a master after effective identity settings change", () =>
    run("healthy", (f, manager) =>
      Effect.gen(function* () {
        yield* manager.ensureEnvironment(uploadTarget);
        yield* f.changeIdentity;
        yield* manager.runRemoteScript(uploadTarget, { script: "echo new identity" });
        assert.notInclude(commandArgs(f.commands.at(-1)!), "-S");
        yield* f.die;
        yield* manager.ensureEnvironment(uploadTarget);
        const sockets = f.commands
          .filter((c) => commandArgs(c).includes("-M"))
          .map((c) => {
            const args = commandArgs(c);
            return args[args.indexOf("-S") + 1]!.split("/").at(-1);
          });
        assert.equal(sockets.length, 2);
        assert.notEqual(sockets[0], sockets[1]);
        yield* manager.disconnectEnvironment(uploadTarget);
      }),
    ),
  );

  it.effect.each(["start-fails", "forward-fails", "user-path", "user-master", "windows"] as const)(
    "uses standalone forwards for %s",
    (mode) =>
      run(mode, (f, manager) =>
        Effect.gen(function* () {
          yield* manager.ensureEnvironment(uploadTarget);
          assert.include(f.events, "standalone-forward");
          if (mode === "user-path" || mode === "user-master" || mode === "windows") {
            assert.notInclude(f.events, "master");
            for (const command of f.commands) assert.notInclude(commandArgs(command), "-S");
          }
          const forward = f.commands.find(
            (c) => commandArgs(c).includes("-N") && !commandArgs(c).includes("-M"),
          )!;
          assert.includeMembers(
            [...commandArgs(forward)],
            ["ControlPath=none", "ControlMaster=no", "ControlPersist=no"],
          );
          assert.notInclude(commandArgs(forward), "-S");
          if (mode === "user-path" || mode === "user-master") {
            const remote = f.commands.find((c) => commandArgs(c).includes("sh"))!;
            assert.notInclude(commandArgs(remote), "ControlPath=none");
            assert.equal(forward._tag, "StandardCommand");
            if (forward._tag === "StandardCommand") {
              assert.equal(forward.command, "/bin/sh");
              assert.isTrue(forward.options.detached);
            }
          }
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.include(f.events, "kill-forward");
        }),
      ),
  );

  it("recognizes user sharing while ignoring OpenSSH defaults", () => {
    assert.isFalse(hasUserSshSharing("controlmaster false\ncontrolpath none\n"));
    assert.isTrue(hasUserSshSharing("controlmaster auto\n"));
    assert.isTrue(hasUserSshSharing("controlmaster no\ncontrolpath ~/.ssh/%C\n"));
  });
});
