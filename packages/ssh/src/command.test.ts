import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parseSshResolveOutput, runSshCommand, SshHostAnswered } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import { sshPreparationFailure } from "../../client-runtime/src/connection/sshFailure.ts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

const makeNeverFinishingProcess = () => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const encoder = new TextEncoder();

const makeFailedProcess = (input: {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) => {
  const stdoutStream = Stream.make(encoder.encode(input.stdout));
  const stderrStream = input.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: stderrStream,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

describe("ssh command", () => {
  it.effect("parses resolved ssh config output into a target", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshResolveOutput(
          "devbox",
          ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
        ),
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      );
    }),
  );

  it.effect("passes an option-shaped alias to ssh as the destination", () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const spawner = lazyChildProcessSpawner((command) => {
      if (ChildProcess.isStandardCommand(command)) spawned.push(command.args);
      return Effect.succeed(makeFailedProcess({ stdout: "", stderr: "bad hostname\n" }));
    });
    return runSshCommand(
      { alias: "-oProxyCommand=false", hostname: "devbox", username: null, port: null },
      { remoteCommandArgs: ["sh", "-s"] },
    ).pipe(
      Effect.flip,
      Effect.map(() => {
        assert.deepEqual(spawned[0]?.slice(-4), ["--", "-oProxyCommand=false", "sh", "-s"]);
      }),
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });

  it.live.each([
    { name: "default head", keepErrorOutputTail: undefined, exitCode: 1, stderr: "" },
    {
      name: "opt-in tail",
      keepErrorOutputTail: true,
      exitCode: 1,
      stderr: "stderr failure ".repeat(400),
    },
    { name: "successful output", keepErrorOutputTail: true, exitCode: 0, stderr: "" },
  ])("preserves process output: $name", ({ keepErrorOutputTail, exitCode, stderr }) =>
    Effect.gen(function* () {
      const prefix = `HEAD\n${"verbose-prefix ".repeat(400)}`;
      const secret = "synthetic-secret".repeat(400);
      const diagnostic = "\nPANIC: emulator SDK is broken\n";
      const stdout = `${prefix}{"credential":"${secret}"}${diagnostic}`;
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Replace only the SSH endpoint with a real, deterministic process.
      const spawner = ChildProcessSpawner.make(() =>
        nativeSpawner.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`,
          ]),
        ),
      );
      const command = runSshCommand(
        { alias: "synthetic-fixture", hostname: "synthetic-fixture", username: null, port: null },
        keepErrorOutputTail === undefined ? {} : { keepErrorOutputTail },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (exitCode === 0) {
        assert.deepEqual(yield* command, { stdout, stderr });
        return;
      }
      const failure = yield* Effect.flip(command);
      assert.instanceOf(failure, SshCommandError);
      assert.equal(failure.exitCode, 1);
      assert.equal(failure.stderr, stderr);
      assert.equal(failure.message, stderr.trim() || failure.stdout?.trim());
      const redacted = `${prefix}{"credential":"[redacted]"}${diagnostic}`;
      assert.equal(
        failure.stdout,
        keepErrorOutputTail
          ? `[truncated]\n${redacted.slice(-4_000)}`
          : `${redacted.slice(0, 4_000)}\n[truncated]`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("redacts credentials from stdout in non-zero command failures", () => {
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed(makeFailedProcess({ stdout: '{"credential":"pairing-secret"}\n' })),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { remoteCommandArgs: ["sh", "-s"] },
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, '{"credential":"[redacted]"}');
        assert.equal(result.failure.stdout, '{"credential":"[redacted]"}\n');
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each([
    ['Authenticated to fixture using "publickey".\n', 1],
    ["debug1: mux_client_request_session: master session id: 2\n", 1],
    ["debug1: Connection established.\n", 0],
    ['Authenticated to jump using "publickey".\n', 0],
    [
      'debug1: Executing proxy command: exec ssh -W fixture:22 jump\nAuthenticated to jump using "publickey".\n',
      0,
    ],
    [
      'debug1: Executing proxy command: exec ssh -W fixture:22 jump\nAuthenticated to jump using "publickey".\ndebug1: Authenticating to fixture:22 as "owner"\nAuthenticated to fixture using "publickey".\n',
      1,
    ],
  ] as const)("reports only the final host's authenticated answer: %s", (diagnostic) =>
    Effect.gen(function* () {
      const [stderr, expected] = diagnostic;
      const drained = yield* Deferred.make<void>();
      let answered = 0;
      const spawner = lazyChildProcessSpawner(() =>
        Effect.succeed({
          ...makeNeverFinishingProcess(),
          stderr: Stream.make(encoder.encode(stderr)).pipe(
            Stream.ensuring(Deferred.succeed(drained, undefined)),
          ),
        }),
      );
      const fiber = yield* runSshCommand({
        alias: "fixture",
        hostname: "fixture",
        username: null,
        port: null,
      }).pipe(
        Effect.provideService(SshHostAnswered, () => {
          answered += 1;
        }),
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(drained);
      assert.equal(answered, expected);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("preserves binary stdin bytes", () => {
    const bytes = new Uint8Array([0, 128, 255]);
    const captured: number[] = [];
    const spawner = lazyChildProcessSpawner((command) =>
      Effect.gen(function* () {
        assert.equal(command._tag, "StandardCommand");
        if (command._tag === "StandardCommand") {
          const stdin = command.options.stdin;
          assert.isDefined(stdin);
          if (
            stdin !== undefined &&
            typeof stdin === "object" &&
            "stream" in stdin &&
            Stream.isStream(stdin.stream)
          ) {
            yield* stdin.stream.pipe(
              Stream.runForEach((chunk) => Effect.sync(() => captured.push(...chunk))),
            );
            assert.isTrue(stdin.endOnDone);
          }
        }
        return {
          ...makeFailedProcess({ stdout: "ok" }),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        };
      }),
    );
    return runSshCommand(
      { alias: "fixture", hostname: "fixture", username: null, port: null },
      { stdin: bytes },
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
      Effect.andThen(Effect.sync(() => assert.deepEqual(captured, [0, 128, 255]))),
    );
  });

  it.live.each([false, true])(
    "reports consumed binary stdin chunks with a real child (observer throws: %s)",
    (observerThrows) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const bytes = new Uint8Array(2 * 1024 * 1024 + 17).fill(251);
        const progress: number[] = [];
        const ready = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
        const transport = lazyChildProcessSpawner((command) => {
          assert.isTrue(ChildProcess.isStandardCommand(command));
          if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
          return Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  "-e",
                  `let received = 0;
let valid = true;
require('node:fs').createReadStream('', { fd: 3 }).once('data', () => {
  process.stdin.on('data', (chunk) => {
    received += chunk.length;
    valid &&= chunk.every((byte) => byte === 251);
  });
  process.stdin.on('end', () => process.stdout.write(JSON.stringify({ received, valid })));
});
process.stderr.write('reader waiting');`,
                ],
                { ...command.options, additionalFds: { fd3: { type: "input" } } },
              ),
            );
            return {
              ...child,
              stderr: child.stderr.pipe(Stream.tap(() => Deferred.succeed(ready, child))),
            };
          });
        });
        const upload = yield* runSshCommand(
          { alias: "fixture", hostname: "fixture", username: null, port: null },
          {
            stdin: bytes,
            onStdinProgress: (sentBytes) => {
              progress.push(sentBytes);
              if (observerThrows) throw new Error("view disposed");
            },
          },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport),
          Effect.forkChild,
        );
        const child = yield* Deferred.await(ready);
        assert.deepEqual(progress, []);
        yield* Stream.make(encoder.encode("read")).pipe(Stream.run(child.getInputFd(3)));
        const result = yield* Fiber.join(upload);
        assert.deepEqual(JSON.parse(result.stdout), { received: bytes.byteLength, valid: true });
        assert.deepEqual(progress, [1024 * 1024, 2 * 1024 * 1024, bytes.byteLength]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([
    [
      "ssh: connect to host 100.127.141.108 port 22: Operation timed out",
      "Cannot reach devbox over SSH (100.127.141.108:22: Operation timed out). Check the network or VPN connection to that host.",
    ],
    [
      "ssh: Could not resolve hostname devbox.example.com: nodename nor servname provided, or not known",
      "Cannot reach devbox over SSH (could not resolve devbox.example.com: nodename nor servname provided, or not known). Check the network or VPN connection to that host.",
    ],
  ] as const)("names the host when ssh cannot connect: %s", ([stderr, message]) => {
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed(
        makeFailedProcess({
          stdout: "",
          stderr: `Warning: Permanently added 'devbox'.\n${stderr}\n`,
          exitCode: 255,
        }),
      ),
    );
    const layerProcess = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand(
          { alias: "devbox", hostname: "devbox.example.com", username: null, port: 2222 },
          { remoteCommandArgs: ["sh", "-s"] },
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(result.failure.message, message);
        assert.include(result.failure.stderr, stderr);
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each([
    ["Tailscale is stopped.", "Start Tailscale"],
    ["Logged out.", "Sign in to Tailscale"],
    ["Machine is not yet approved by tailnet admin.", "approve this machine"],
  ] as const)("preserves local proxy banner status: %s", ([banner, fix]) => {
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed(
        makeFailedProcess({
          stdout: "",
          exitCode: 255,
          stderr: `debug1: kex_exchange_identification: banner line 0: ${banner}\ndebug1: kex_exchange_identification: banner line 1: Log in at: https://login.invalid/private\nConnection closed by UNKNOWN port 65535\n`,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* runSshCommand({
        alias: "fixture",
        hostname: "fixture",
        username: null,
        port: null,
      }).pipe(Effect.flip);
      assert.include(sshPreparationFailure(error).detail ?? "", fix);
      assert.equal(sshPreparationFailure(error)._tag, "ConnectionBlockedError");
      assert.notInclude(error.message, "https://login.invalid/private");
      if (error instanceof SshCommandError) assert.notInclude(error.stderr, "debug1:");
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });

  it.effect("keeps a remote command's own exit-255 output", () => {
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed(makeFailedProcess({ stdout: "", stderr: "runner failed\n", exitCode: 255 })),
    );
    const layerProcess = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        runSshCommand({ alias: "devbox", hostname: "devbox", username: null, port: null }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.message, "runner failed");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each([
    [
      "debug1: Connection established.\n",
      {},
      "SSH connection to devbox (devbox.example.com:2222) timed out after 1ms before authentication began. Check the network or SSH ProxyCommand.",
      "host-unreachable",
    ],
    [
      "debug1: Connection established.\ndebug1: SSH2_MSG_SERVICE_ACCEPT received\n",
      {},
      "SSH authentication timed out for devbox (devbox.example.com:2222) after 1ms. Unlock your SSH key or ssh-agent, then reconnect.",
      "authentication",
    ],
    [
      'Authenticated to jump using "publickey".\ndebug1: channel_connect_stdio_fwd: devbox.example.com:2222\n',
      {},
      "SSH connection to devbox (devbox.example.com:2222) timed out after 1ms before authentication began. Check the network or SSH ProxyCommand.",
      "host-unreachable",
    ],
    [
      'Authenticated to jump using "publickey".\ndebug1: Authenticating to devbox.example.com:2222 as "julius"\n',
      {},
      "SSH connection to devbox (devbox.example.com:2222) timed out after 1ms before authentication began. Check the network or SSH ProxyCommand.",
      "host-unreachable",
    ],
    [
      'Authenticated to jump using "publickey".\ndebug1: channel_connect_stdio_fwd: devbox.example.com:2222\ndebug1: Authenticating to devbox.example.com:2222 as "julius"\ndebug1: SSH2_MSG_SERVICE_ACCEPT received\n',
      {},
      "SSH authentication timed out for devbox (devbox.example.com:2222) after 1ms. Unlock your SSH key or ssh-agent, then reconnect.",
      "authentication",
    ],
    [
      'debug1: Setting implicit ProxyCommand from ProxyJump: ssh -W %h:%p jump\nAuthenticated to jump ([192.0.2.2]:22) using "publickey".\n',
      {},
      "SSH connection to devbox (devbox.example.com:2222) timed out after 1ms before authentication began. Check the network or SSH ProxyCommand.",
      "host-unreachable",
    ],
    [
      'debug1: Executing proxy command: exec ssh -W target:22 jump\nAuthenticated to jump ([192.0.2.2]:22) using "publickey".\n',
      {},
      "SSH connection to devbox (devbox.example.com:2222) timed out after 1ms before authentication began. Check the network or SSH ProxyCommand.",
      "host-unreachable",
    ],
    [
      'debug1: Executing proxy command: exec ssh -W target:22 jump\nAuthenticated to jump using "publickey".\ndebug1: Authenticating to target:22 as "fixture"\ndebug1: SSH2_MSG_SERVICE_ACCEPT received\n',
      {},
      "SSH authentication timed out for devbox (devbox.example.com:2222) after 1ms. Unlock your SSH key or ssh-agent, then reconnect.",
      "authentication",
    ],
    [
      'debug1: Executing proxy command: exec ssh -W target:22 jump\nAuthenticated to jump using "publickey".\ndebug1: Authenticating to target:22 as "fixture"\nAuthenticated to target using "publickey".\n',
      {},
      "Remote SSH command on devbox (devbox.example.com:2222) timed out after 1ms.",
      "remote-unavailable",
    ],
    [
      "debug1: mux_client_request_session: master session id: 2\n",
      {},
      "Remote SSH command on devbox (devbox.example.com:2222) timed out after 1ms.",
      "remote-unavailable",
    ],
    [
      'Authenticated to fixture using "publickey".\n',
      {},
      "Remote SSH command on devbox (devbox.example.com:2222) timed out after 1ms.",
      "remote-unavailable",
    ],
    [
      'Authenticated to fixture using "publickey".\n',
      { timeoutStage: "runtime-install" as const },
      "GOAT runtime install/download on devbox (devbox.example.com:2222) timed out after 1ms.",
      "remote-unavailable",
    ],
    [
      'Authenticated to fixture using "publickey".\n',
      { timeoutStage: "runtime-launch" as const },
      "GOAT runtime launch on devbox (devbox.example.com:2222) timed out after 1ms.",
      "remote-unavailable",
    ],
    [
      'Authenticated to fixture using "publickey".\n',
      { timeoutStage: "pairing" as const },
      "GOAT pairing on devbox (devbox.example.com:2222) timed out after 1ms.",
      "remote-unavailable",
    ],
  ] as const)(
    "times out at the observed SSH stage: %s %s",
    ([stderr, options, message, reason]) => {
      return Effect.gen(function* () {
        const stderrRead = yield* Deferred.make<void>();
        const spawner = lazyChildProcessSpawner(() =>
          Effect.succeed({
            ...makeNeverFinishingProcess(),
            stderr: Stream.make(encoder.encode(stderr)).pipe(
              Stream.ensuring(Deferred.succeed(stderrRead, undefined)),
            ),
          }),
        );
        const fiber = yield* Effect.forkChild(
          Effect.result(
            runSshCommand(
              {
                alias: "devbox",
                hostname: "devbox.example.com",
                username: "julius",
                port: 2222,
              },
              { timeoutMs: 1, ...options },
            ),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        );
        yield* Deferred.await(stderrRead);
        yield* TestClock.adjust(Duration.millis(1));

        const result = yield* Fiber.join(fiber);

        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.message, message);
          assert.equal(sshPreparationFailure(result.failure).reason, reason);
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer())));
    },
  );
});
