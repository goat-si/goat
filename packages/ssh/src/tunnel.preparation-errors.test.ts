import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, afterEach, vi } from "@effect/vitest";
import { cliArchiveFileName } from "@goat/shared/cliRelease";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Layer from "effect/Layer";
import * as NetService from "@goat/shared/Net";
import { HttpClient } from "effect/http";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { SshCommandError, SshLaunchError } from "./errors.ts";
import { prepareRemoteRuntime } from "./tunnel.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  uploadTarget,
  testHttpClient,
  testNetService,
} from "./tunnel.fixture.ts";

const ARCHIVE_ADVICE = "No GOAT runtime for";
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
  it.effect.each([
    {
      stderr: "Install shasum or sha256sum to verify the retained GOAT runner.",
      instruction: "Install sha256sum (coreutils) on devbox, then try again.",
    },
    {
      stderr: "Remote host needs curl or wget to download the archive.",
      instruction: "Install curl or wget on devbox, then try again.",
    },
    {
      stderr:
        "Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.",
      instruction: "Install Node on devbox for the source runtime, then try again.",
    },
  ])(
    "uses a plain, tool-specific recovery for $stderr without unverified root commands",
    ({ stderr, instruction }) =>
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.succeed(
            command._tag === "StandardCommand" && command.args.includes("-G")
              ? makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n")
              : makeExitedProcess(255, stderr),
          ),
        );
        const managerLayer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(ARCHIVE),
            leaveRemoteServerRunning: true,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const result = yield* manager.status(uploadTarget);
          assert.equal(result.status?.failure?.reason, "missing_tools");
          assert.equal(result.status?.failure?.fix.instruction, instruction);
          assert.isUndefined(result.status?.failure?.fix.command);
        }).pipe(Effect.provide(managerLayer), Effect.scoped);
      }),
  );

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
          // The sidecar detail goes to the log; the person gets the one step that fixes it.
          assert.equal(result.failure.action, "Reinstall this app, then reconnect.");
          assert.match(result.failure.message, /Reinstall this app, then reconnect\.$/);
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
        assert.equal(
          result.failure.message,
          `No GOAT runtime for linux-x64 that works with this app (GOAT ${ARCHIVE.archiveVersion}) could be installed on devbox. Reinstall this app, then reconnect.`,
        );
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
