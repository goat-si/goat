import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";

import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { buildRemoteStopScript, buildRemoteGoatRunnerScript } from "./tunnel.ts";

// An absolute default also works in the runner fixture's deliberately minimal PATH.
const remoteShell = process.env.GOAT_SSH_TEST_SHELL ?? "/bin/sh";

const Started = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  args: Schema.Array(Schema.String),
});
const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Started));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote runner process ownership",
  () => {
    it.live("keeps the server PID and graceful shutdown through the node-script runner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runner-" });
        const bin = path.join(fixture, "bin");
        const cliPath = path.join(fixture, "installed cli.mjs");
        yield* fs.makeDirectory(bin);
        yield* fs.symlink(process.execPath, path.join(bin, "node"));
        yield* fs.writeFileString(
          cliPath,
          `#!/usr/bin/env node
import * as net from "node:net";
const server = net.createServer((socket) => {
  socket.end();
  server.close();
});
process.on("SIGTERM", () => server.close(() => {
  process.stdout.write("graceful shutdown\\n");
}));
server.listen(Number(process.env.GOAT_TEST_PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    args: process.argv.slice(2),
  }) + "\\n");
});
`,
        );
        yield* fs.chmod(cliPath, 0o700);

        const runServer = (port = 0) =>
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(remoteShell, ["-s", "--", "serve", "a path with spaces"], {
                cwd: fixture,
                env: {
                  PATH: bin,
                  GOAT_TEST_PORT: String(port),
                },
                detached: false,
                stdin: Stream.make(
                  new TextEncoder().encode(
                    buildRemoteGoatRunnerScript({ nodeScriptPath: cliPath }),
                  ),
                ),
              }),
            );
            const ready = yield* Deferred.make<typeof Started.Type>();
            const stdout: string[] = [];
            const output = yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.gen(function* () {
                  stdout.push(line);
                  if (stdout.length === 1) {
                    yield* Deferred.succeed(ready, decodeStarted(line));
                  }
                }),
              ),
              Effect.forkScoped,
            );
            const stderr = yield* child.stderr.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.forkScoped,
            );
            const receipt = yield* Effect.raceFirst(
              Deferred.await(ready),
              Fiber.join(output).pipe(
                Effect.flatMap(() => Fiber.join(stderr)),
                Effect.flatMap((message) =>
                  Effect.die(new Error(`Runner exited before listening: ${message}`)),
                ),
              ),
            );
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (yield* child.isRunning) {
                  yield* Effect.callback<void>((resume) => {
                    const connection = NodeNet.connect(receipt.port, "127.0.0.1");
                    connection.on("error", () => undefined);
                    connection.once("close", () => resume(Effect.void));
                    return Effect.sync(() => connection.destroy());
                  });
                  yield* child.exitCode;
                }
              }).pipe(Effect.orDie),
            );
            assert.equal(receipt.pid, child.pid);
            assert.deepEqual(receipt.args, ["serve", "a path with spaces"]);
            yield* child.kill({ killSignal: "SIGTERM" });
            assert.equal(yield* child.exitCode, 0);
            yield* Fiber.join(output);
            assert.include(stdout, "graceful shutdown");
            return receipt.port;
          }).pipe(Effect.scoped);

        const port = yield* runServer();
        assert.equal(yield* runServer(port), port);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote stop process ownership",
  () => {
    it.live.each(["graceful", "timeout", "external"] as const)(
      "confirms the stop result for a %s server",
      (mode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "goat-stop-" });
          const home = path.join(fixture, "home");
          const baseDir = path.join(home, ".goat");
          const stateDir = path.join(baseDir, "ssh-launch", REMOTE_RUNTIME_STATE_KEY);
          yield* fs.makeDirectory(stateDir, { recursive: true });
          const signalPath = path.join(fixture, "signals");
          const cliPath = path.join(fixture, "installed cli.mjs");
          // Ownership matches the published port against argv, so the server binds that port.
          const port = yield* NetService.make().reserveLoopbackPort();
          const args = [
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--base-dir",
            baseDir,
          ];
          yield* fs.writeFileString(
            cliPath,
            `import * as fs from "node:fs";
import * as net from "node:net";
const server = net.createServer((socket) => socket.end());
let signals = 0;
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.GOAT_TEST_SIGNAL_PATH, String(++signals));
  if (process.env.GOAT_TEST_STOP_MODE !== "timeout" || signals > 1) process.exit(0);
});
server.listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ pid: process.pid, port: server.address().port, args: process.argv.slice(2) }) + "\\n");
});
`,
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [cliPath, ...args], {
              cwd: fixture,
              env: {
                HOME: home,
                GOAT_TEST_STOP_MODE: mode,
                GOAT_TEST_SIGNAL_PATH: signalPath,
              },
              detached: false,
            }),
          );
          yield* Effect.addFinalizer(() =>
            child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
          );
          const started = decodeStarted(
            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.take(1),
              Stream.mkString,
            ),
          );
          assert.equal(started.pid, child.pid);
          assert.equal(started.port, port);
          assert.deepEqual(started.args, args);
          const savedState = {
            pid: `${child.pid}\n`,
            port: `${started.port}\n`,
            managed: mode === "external" ? "external\n" : "managed\n",
            identity: `${cliPath} ${args.join(" ")}\n`,
          };
          for (const [name, contents] of Object.entries(savedState)) {
            yield* fs.writeFileString(path.join(stateDir, name), contents);
          }
          // Stop signals only a server that reports itself idle through the runner.
          const runnerPath = path.join(stateDir, "run-t3.sh");
          yield* fs.writeFileString(
            runnerPath,
            '#!/bin/sh\n[ "$1 $2" = "__ssh-helper activity" ] && { echo idle; exit 0; }\nexit 2\n',
          );
          yield* fs.chmod(runnerPath, 0o700);
          // Interval 0 follows the process instead of a wall-clock window. The timeout case
          // fails on the first attempt; the stop that should succeed polls until exit.
          const timingOutScript = buildRemoteStopScript(REMOTE_RUNTIME_STATE_KEY, {
            stopWaitAttempts: 1,
            stopWaitIntervalSeconds: "0",
          });
          const stoppingScript = buildRemoteStopScript(REMOTE_RUNTIME_STATE_KEY, {
            stopWaitAttempts: 100_000,
            stopWaitIntervalSeconds: "0",
          });
          const runStop = Effect.fn("test.remoteStop")(function* (script: string) {
            const stop = yield* spawner.spawn(
              ChildProcess.make(remoteShell, ["-s"], {
                cwd: fixture,
                env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
                stdin: Stream.make(new TextEncoder().encode(script)),
              }),
            );
            return yield* Effect.all(
              {
                stdout: stop.stdout.pipe(Stream.decodeText(), Stream.mkString),
                stderr: stop.stderr.pipe(Stream.decodeText(), Stream.mkString),
                exitCode: stop.exitCode,
              },
              { concurrency: "unbounded" },
            );
          }, Effect.scoped);
          let result = yield* runStop(mode === "timeout" ? timingOutScript : stoppingScript);
          if (mode !== "graceful") {
            assert.isTrue(yield* child.isRunning);
            yield* Effect.callback<void, Error>((resume) => {
              const connection = NodeNet.connect(started.port, "127.0.0.1");
              connection.once("error", (error) => resume(Effect.fail(error)));
              connection.once("close", () => resume(Effect.void));
              return Effect.sync(() => connection.destroy());
            });
          }
          if (mode === "timeout") {
            assert.equal(result.exitCode, 1);
            assert.equal(result.stdout, "");
            assert.include(result.stderr, "did not stop within the stop deadline");
            assert.include(result.stderr, "ownership files were kept");
            assert.equal(yield* fs.readFileString(signalPath), "1");
            for (const [name, contents] of Object.entries(savedState)) {
              assert.equal(yield* fs.readFileString(path.join(stateDir, name)), contents);
            }
            result = yield* runStop(stoppingScript);
          }
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(result.stdout, '{"stopped":true}\n');
          assert.equal(result.stderr, "");
          for (const name of Object.keys(savedState)) {
            assert.isFalse(yield* fs.exists(path.join(stateDir, name)));
          }
          if (mode === "external") {
            assert.isFalse(yield* fs.exists(signalPath));
          } else {
            assert.equal(yield* child.exitCode, 0);
            assert.equal(yield* fs.readFileString(signalPath), mode === "timeout" ? "2" : "1");
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
