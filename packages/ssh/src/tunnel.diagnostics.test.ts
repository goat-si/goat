import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  commandArgs,
  hangingHttpClient,
  isRemoteLaunch,
  makeProtocolTestSpawner,
  makeRunningProcess,
  makeSuccessfulProcess,
  PROTOCOL_ARCHIVE,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

// Archive acquisition stays local to these transport doubles.
beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 404 })));
afterEach(() => vi.unstubAllGlobals());

const LAUNCHED =
  '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}';

/** Answers every remote command except the forward, which \`tunnel\` supplies. */
const tunnelSpawner = (
  tunnel: (
    command: ChildProcess.Command,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  >,
) =>
  makeProtocolTestSpawner((command) => {
    const args = commandArgs(command);
    if (args.includes("-G"))
      return Effect.succeed(
        makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n"),
      );
    if (args.includes("-N")) return tunnel(command);
    if (isRemoteLaunch(args)) return Effect.succeed(makeSuccessfulProcess(LAUNCHED));
    if (args.includes("sh")) return Effect.succeed(makeSuccessfulProcess('{"stopped":true}'));
    return Effect.succeed(makeSuccessfulProcess(""));
  });

const managerLayer = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  httpClient: HttpClient.HttpClient,
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(NetService.NetService, testNetService),
    SshAuth.SshPasswordPrompt.disabledLayer,
    SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE) }),
  );

const readyAfter = (started: Deferred.Deferred<void>) =>
  HttpClient.make((request) =>
    Deferred.await(started).pipe(
      Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
    ),
  );

const failedTunnel = (input: {
  readonly exitCode: number;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
}) =>
  Effect.succeed({
    ...makeSuccessfulProcess(""),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode)),
    stderr: input.stderr,
  });

describe("ssh tunnel diagnostics", () => {
  it.effect("keeps the stderr reader alive until disconnect", () =>
    Effect.gen(function* () {
      const readerStarted = yield* Deferred.make<void>();
      let readers = 0;
      let finalized = 0;
      const stderr = Stream.fromEffect(
        Effect.sync(() => {
          readers += 1;
        }).pipe(Effect.andThen(Deferred.succeed(readerStarted, undefined))),
      ).pipe(
        Stream.flatMap(() => Stream.fromEffect(Effect.never)),
        Stream.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      );
      const spawner = tunnelSpawner(() =>
        Effect.succeed({ ...makeRunningProcess(() => undefined), stderr }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        assert.equal(readers, 1);
        assert.equal(finalized, 0, "readiness must not release the stderr reader");
        yield* manager.disconnectEnvironment(uploadTarget);
        assert.equal(finalized, 1, "disconnect must release the stderr reader");
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, managerLayer(spawner, readyAfter(readerStarted))),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = tunnelSpawner(() =>
        failedTunnel({
          exitCode: 1,
          stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        return yield* Effect.result(manager.ensureEnvironment(uploadTarget));
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, managerLayer(spawner, hangingHttpClient))),
        Effect.scoped,
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        if (result.failure instanceof SshCommandError) {
          assert.equal(result.failure.exitCode, 1);
          assert.equal(result.failure.stderr.length, 16_384);
          assert.isTrue(result.failure.stderr.endsWith(diagnostic));
          assert.equal(result.failure.message, result.failure.stderr.trim());
        }
      }
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = tunnelSpawner(() =>
        failedTunnel({
          exitCode: 255,
          stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
            Stream.concat(
              Stream.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "Stream",
                  method: "read",
                  description: "stderr read failed",
                }),
              ),
            ),
          ),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        return yield* Effect.result(manager.ensureEnvironment(uploadTarget));
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, managerLayer(spawner, hangingHttpClient))),
        Effect.scoped,
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        if (result.failure instanceof SshCommandError) {
          assert.equal(result.failure.exitCode, 255);
          assert.equal(result.failure.stderr, diagnostic);
        }
      }
    }),
  );

  it.live("drains diagnostics beyond pipe capacity after readiness", () =>
    Effect.gen(function* () {
      const nodeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const executable = yield* HostProcess.ExecutablePath;
      const input = yield* Queue.unbounded<Uint8Array>();
      const readerStarted = yield* Deferred.make<void>();
      const tunnelSpawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      let finalized = 0;
      const spawner = tunnelSpawner(() =>
        Effect.gen(function* () {
          const child = yield* nodeSpawner.spawn(
            ChildProcess.make(
              executable,
              [
                "-e",
                `process.stdin.once("data", () => {
                process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), () => {
                  process.stdout.write("diagnostics complete\\n");
                });
              });`,
              ],
              { stdin: { stream: Stream.fromQueue(input) } },
            ),
          );
          yield* Deferred.succeed(tunnelSpawned, child);
          return {
            ...child,
            stderr: Stream.fromEffect(Deferred.succeed(readerStarted, undefined)).pipe(
              Stream.flatMap(() => child.stderr),
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            ),
          };
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        const child = yield* Deferred.await(tunnelSpawned);
        const progress = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Queue.offer(input, new TextEncoder().encode("write diagnostics"));
        // The deadline only bounds a blocked subprocess; success waits for its write callback.
        assert.deepEqual(yield* Fiber.join(progress).pipe(Effect.timeout("5 seconds")), [
          "diagnostics complete",
        ]);
        assert.isTrue(yield* child.isRunning);
        yield* manager.disconnectEnvironment(uploadTarget);
        assert.equal(finalized, 1);
        assert.isFalse(yield* child.isRunning);
      }).pipe(Effect.provide(managerLayer(spawner, readyAfter(readerStarted))), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
