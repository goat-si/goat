import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, afterEach, vi } from "@effect/vitest";
import { cliArchiveFileName } from "@goat/shared/cliRelease";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { SshCommandError, SshLaunchError } from "./errors.ts";
import { prepareRemoteRuntime } from "./tunnel.ts";
import { ARCHIVE, makeSuccessfulProcess, uploadTarget } from "./tunnel.fixture.ts";

const ARCHIVE_ADVICE = "Supply the requested runtime archive";
afterEach(() => vi.unstubAllGlobals());

const makeExitedProcess = (exitCode: number, stderr: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.make(new TextEncoder().encode(stderr)),
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const prepareWithProbe = (probe: () => ChildProcessSpawner.ChildProcessHandle) =>
  Effect.result(
    prepareRemoteRuntime(uploadTarget, {}, ARCHIVE).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(probe())),
      ),
    ),
  );

describe("SSH runtime preparation errors", () => {
  it.effect("records only the bundle branch when its checksum sidecar is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bundle = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bundle-error-" });
      yield* fs.writeFile(
        `${bundle}/${cliArchiveFileName(ARCHIVE.archiveVersion, "linux-x64")}`,
        new Uint8Array(64),
      );
      const result = yield* Effect.result(
        prepareRemoteRuntime(
          uploadTarget,
          {},
          {
            ...ARCHIVE,
            bundledArchiveDirectory: bundle,
            archiveDirectory: `${bundle}/unused-cache`,
          },
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeSuccessfulProcess('{"platform":"linux","arch":"x64","ready":false}'),
              ),
            ),
          ),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshLaunchError);
        if (result.failure instanceof SshLaunchError) {
          assert.equal(result.failure.reason, "archive-unavailable");
          assert.include(
            result.failure.message,
            "Bundled SSH runtime archive is missing its SHA-256 sidecar",
          );
          assert.deepEqual(result.failure.acquisition?.sourcesTried, ["bundle"]);
          assert.equal(result.failure.acquisition?.requestedVersion, ARCHIVE.archiveVersion);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("preserves the executed bundle/cache/HTTPS/gh acquisition chain through wrappers", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-supply-error-" });
      const result = yield* Effect.result(
        prepareRemoteRuntime(
          uploadTarget,
          {},
          {
            ...ARCHIVE,
            bundledArchiveDirectory: `${root}/bundle`,
            archiveDirectory: `${root}/cache`,
          },
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.succeed(
                command._tag === "StandardCommand" && command.command === "gh"
                  ? makeExitedProcess(1, "release not found")
                  : makeSuccessfulProcess('{"platform":"linux","arch":"x64","ready":false}'),
              ),
            ),
          ),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result) && result.failure instanceof SshLaunchError) {
        assert.equal(result.failure.reason, "archive-unavailable");
        assert.deepEqual(result.failure.acquisition, {
          requestedVersion: ARCHIVE.archiveVersion,
          platformKey: "linux-x64",
          sourcesTried: ["bundle", "cache", "https", "gh"],
        });
      } else assert.fail("Expected an archive acquisition failure");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports an unreachable host as an SSH connection error", () =>
    Effect.gen(function* () {
      const result = yield* prepareWithProbe(() =>
        makeExitedProcess(
          255,
          "ssh: connect to host 100.127.141.108 port 22: Operation timed out\n",
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.equal(
          result.failure.message,
          "Cannot reach devbox over SSH (100.127.141.108:22: Operation timed out). Check the network or VPN connection to that host.",
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the cause of a non-archive failure and gives no archive advice", () =>
    Effect.gen(function* () {
      const result = yield* prepareWithProbe(() => makeSuccessfulProcess("not json"));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshLaunchError);
        assert.match(
          result.failure.message,
          /^Cannot prepare GOAT 1\.2\.3-preview\.20260911\.4 on devbox: Failed to prepare the SSH runtime archive: \S/,
        );
        assert.notInclude(result.failure.message, ARCHIVE_ADVICE);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives archive advice only when no source can supply the archive", () =>
    Effect.gen(function* () {
      const result = yield* prepareWithProbe(() =>
        makeSuccessfulProcess('{"platform":"linux","arch":"x64","ready":false}'),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshLaunchError);
        assert.equal(result.failure.reason, "archive-unavailable");
        assert.deepEqual(result.failure.acquisition, {
          requestedVersion: ARCHIVE.archiveVersion,
          platformKey: "linux-x64",
          sourcesTried: [],
        });
        assert.include(result.failure.message, "no writable user archive cache");
        assert.include(result.failure.message, ARCHIVE_ADVICE);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retained fallback keeps the failed acquisition alongside the actual selection", () =>
    Effect.gen(function* () {
      const selected = yield* prepareRemoteRuntime(uploadTarget, {}, ARCHIVE, "runtime", true).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeSuccessfulProcess(
                JSON.stringify({
                  platform: "linux",
                  arch: "x64",
                  ready: false,
                  liveStatus: "none",
                  retained: "ready",
                  retainedVersion: "1.2.2",
                  retainedRunnerSha256: "a".repeat(64),
                  retainedSignals: {
                    serverVersion: "1.2.2",
                    sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
                    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                  },
                }),
              ),
            ),
          ),
        ),
      );
      assert.equal(selected.version, "1.2.2");
      assert.equal(selected.source, "retained");
      assert.equal(selected.upgradeFailure?.reason, "archive_unavailable");
      assert.deepEqual(selected.upgradeFailure?.archive, {
        requestedVersion: ARCHIVE.archiveVersion,
        platformKey: "linux-x64",
        sourcesTried: [],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // The archive is found locally, then the upload command exits with `exitCode`.
  const prepareWithFailedUpload = (exitCode: number, stderr: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const archiveDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-upload-" });
      // Without a sidecar the file is trusted as a user-supplied local build.
      yield* fs.writeFile(
        `${archiveDirectory}/${cliArchiveFileName(ARCHIVE.archiveVersion, "linux-x64")}`,
        new Uint8Array(64),
      );
      return yield* Effect.result(
        prepareRemoteRuntime(uploadTarget, {}, { ...ARCHIVE, archiveDirectory }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.succeed(
                command._tag === "StandardCommand" && command.args.includes("-c")
                  ? makeExitedProcess(exitCode, stderr)
                  : makeSuccessfulProcess('{"platform":"linux","arch":"x64","ready":false}'),
              ),
            ),
          ),
        ),
      );
    });

  it.effect("reports an upload the remote stopped reading as a failed upload", () =>
    Effect.gen(function* () {
      const result = yield* prepareWithFailedUpload(
        1,
        "tar: write error: No space left on device\n",
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshLaunchError);
        assert.isUndefined(result.failure.reason);
        assert.include(result.failure.message, "Uploading the runtime archive failed (exit 1)");
        assert.include(result.failure.message, "No space left on device");
        assert.notInclude(result.failure.message, ARCHIVE_ADVICE);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a connection lost during upload as an SSH connection error", () =>
    Effect.gen(function* () {
      const result = yield* prepareWithFailedUpload(
        255,
        "ssh: connect to host 100.127.141.108 port 22: Connection refused\n",
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.include(result.failure.message, "Cannot reach devbox over SSH");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
