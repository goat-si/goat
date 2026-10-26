import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import { CLI_RELEASE_REPOSITORY, cliArchiveFileName } from "@goat/shared/cliRelease";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

import { SshLaunchError } from "./errors.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import * as SshTunnel from "./tunnel.ts";
import { isRemoteLaunch } from "./tunnel.fixture.ts";

const version = "1.2.3-preview.20260911.4";
const asset = cliArchiveFileName(version, "linux-x64");
const bytes = new Uint8Array([0, 128, 255]);
const sha256 = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72";
const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
const encoder = new TextEncoder();

function processHandle(stdout = "", code = 0, stderr = "") {
  const output = Stream.make(encoder.encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: output,
    stderr: Stream.make(encoder.encode(stderr)),
    all: output,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

type Mode = "ok" | "missing-release" | "stderr" | "mismatch" | "missing-checksum" | "missing-asset";
const diagnosticSecret = `ghp_${"x".repeat(36)}`;
const diagnosticStderr =
  "noise ".repeat(1000) + `\x1b[31mauthentication failed\x1b[0m Bearer ${diagnosticSecret}\r\n\x00`;
interface DownloadBarrier {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly secondProbe: Deferred.Deferred<void>;
}
const fixture = Effect.fn("test.ghFixture")(function* (
  mode: Mode = "ok",
  ready = false,
  unsupported = false,
  barrier?: DownloadBarrier,
  ghCommand = "gh",
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-gh-test-" });
  const directory = `${root}/archive cache`;
  yield* fs.makeDirectory(directory);
  const calls: string[] = [];
  const commands: ChildProcess.StandardCommand[] = [];
  const uploads: Uint8Array[] = [];
  const staging: string[] = [];
  const spawner = lazyChildProcessSpawner((command) =>
    Effect.gen(function* () {
      assert.equal(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") return processHandle();
      commands.push(command);
      if (command.command === ghCommand) {
        calls.push("gh");
        const temp = command.args[command.args.indexOf("--dir") + 1];
        assert.isDefined(temp);
        if (temp === undefined) return processHandle("", 1);
        staging.push(temp);
        if (mode === "missing-release") return processHandle("", 1, "release not found");
        if (mode === "stderr") return processHandle("", 1, diagnosticStderr);
        if (barrier !== undefined) {
          yield* fs.writeFile(`${temp}/${asset}`, bytes.slice(0, 1));
          yield* Deferred.succeed(barrier.entered, undefined);
          yield* Deferred.await(barrier.release);
        }
        if (mode !== "missing-asset") yield* fs.writeFile(`${temp}/${asset}`, bytes);
        const digest = mode === "mismatch" ? "0".repeat(64) : sha256.toUpperCase();
        yield* fs.writeFileString(
          `${temp}/SHA256SUMS`,
          mode === "missing-checksum" ? "not a checksum\n" : `${digest} *${asset}\n`,
        );
        return processHandle();
      }
      assert.isTrue(command.command === "ssh" || command.command === "ssh.exe");
      const input = command.options.stdin;
      const chunks =
        input !== undefined &&
        typeof input === "object" &&
        "stream" in input &&
        Stream.isStream(input.stream)
          ? yield* input.stream.pipe(Stream.runCollect)
          : [];
      const data = new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
      if (command.args.includes("-c")) {
        calls.push("upload");
        uploads.push(data);
        return processHandle();
      }
      if (command.args.includes("goat-runtime-cleanup")) {
        calls.push("cleanup");
        return processHandle();
      }
      const script = new TextDecoder().decode(data);
      if (script.includes("ready=false") && !isRemoteLaunch(command.args)) {
        calls.push("probe");
        if (barrier !== undefined && calls.filter((call) => call === "probe").length === 2) {
          yield* Deferred.succeed(barrier.secondProbe, undefined);
        }
        return processHandle(
          JSON.stringify({
            platform: unsupported ? "darwin" : "linux",
            arch: "x64",
            ready,
          }),
        );
      }
      if (script.includes("set -- auth session issue")) {
        calls.push("mcp");
        return processHandle('T3_CEILING=default\n{"token":"fixture-session","expiresAt":null}');
      }
      if (isRemoteLaunch(command.args)) {
        calls.push("launch");
        return processHandle(
          JSON.stringify({
            status: "ready",
            remotePort: 3773,
            serverKind: "managed",
            selectedVersion: version,
          }),
        );
      }
      calls.push("pairing");
      return processHandle('{"credential":"fixture-pairing"}');
    }),
  );
  return { fs, root, directory, calls, commands, uploads, staging, spawner };
});

function assertContext(error: unknown, directory: string, expectedAsset = asset) {
  assert.instanceOf(error, SshLaunchError);
  if (!(error instanceof SshLaunchError)) return;
  // From a launch, the person reads one sentence and one action; the detail rides on the cause.
  if (error.acquisition !== undefined)
    assert.match(error.message, /^(No GOAT runtime for |GOAT has no runtime for )/);
  for (const value of [CLI_RELEASE_REPOSITORY, `v${version}`, expectedAsset, directory]) {
    assert.include(detailOf(error), value);
  }
}

function detailOf(error: unknown): string {
  if (!(error instanceof SshLaunchError)) return String(error);
  return error.acquisition !== undefined && error.cause instanceof SshLaunchError
    ? error.cause.message
    : error.message;
}

const assertCleanStaging = Effect.fn("test.cleanStaging")(function* (
  state: Effect.Success<ReturnType<typeof fixture>>,
) {
  for (const directory of state.staging) assert.isFalse(yield* state.fs.exists(directory));
});

function invoke(entry: "launch" | "pairing" | "mcp", runner: SshTunnel.RemoteGoatRunnerOptions) {
  return entry === "launch"
    ? SshTunnel.launchOrReuseRemoteServer(target, {}, runner).pipe(Effect.asVoid)
    : entry === "pairing"
      ? SshTunnel.issueRemotePairingToken(target, {}, runner).pipe(Effect.asVoid)
      : SshTunnel.issueRemoteMcpClientSession(
          target,
          {
            ttl: "1h",
            label: "fixture",
            runtimeModeCeiling: null,
          },
          {},
          runner,
        ).pipe(Effect.asVoid);
}

describe("SSH archives from locally authenticated gh", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.effect.each(["launch", "pairing", "mcp"] as const)(
    "verified gh archive is uploaded before %s",
    (entry) =>
      Effect.gen(function* () {
        const state = yield* fixture();
        yield* invoke(entry, { archiveVersion: version, archiveDirectory: state.directory }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner),
        );
        assert.deepEqual(state.calls, [
          "probe",
          "gh",
          "upload",
          entry,
          ...(entry === "launch" ? ["cleanup"] : []),
        ]);
        assert.deepEqual(state.uploads, [bytes]);
        assert.deepEqual(yield* state.fs.readFile(`${state.directory}/${asset}`), bytes);
        assert.equal(
          yield* state.fs.readFileString(`${state.directory}/${asset}.sha256`),
          `${sha256}  ${asset}\n`,
        );
        const command = state.commands.find((item) => item.command === "gh");
        const staging = state.staging[0];
        assert.isDefined(staging);
        if (staging === undefined) return;
        assert.deepEqual(command?.args, [
          "release",
          "download",
          `v${version}`,
          "--repo",
          CLI_RELEASE_REPOSITORY,
          "--pattern",
          asset,
          "--pattern",
          "SHA256SUMS",
          "--dir",
          staging,
        ]);
        assert.equal(command?.options.shell, false);
        assert.equal(command?.options.env?.GH_PROMPT_DISABLED, "1");
        assert.equal(command?.options.env?.GOAT_SSH_AUTH_SECRET, undefined);
        yield* assertCleanStaging(state);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["launch", "pairing", "mcp"] as const)(
    "missing release fails %s clearly with no remote acquisition",
    (entry) =>
      Effect.gen(function* () {
        const state = yield* fixture("missing-release");
        const result = yield* Effect.result(
          invoke(entry, {
            archiveVersion: version,
            archiveDirectory: state.directory,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assertContext(result.failure, state.directory);
        assert.deepEqual(state.calls, ["probe", "gh"]);
        assert.isFalse(yield* state.fs.exists(`${state.directory}/${asset}`));
        yield* assertCleanStaging(state);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["mismatch", "missing-checksum", "missing-asset"] as const)(
    "%s never publishes or uploads an unverified archive",
    (mode) =>
      Effect.gen(function* () {
        const state = yield* fixture(mode);
        const result = yield* Effect.result(
          invoke("launch", {
            archiveVersion: version,
            archiveDirectory: state.directory,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assertContext(result.failure, state.directory);
          if (mode === "mismatch") assert.include(detailOf(result.failure), "SHA-256 mismatch");
        }
        assert.deepEqual(state.calls, ["probe", "gh"]);
        assert.deepEqual(state.uploads, []);
        assert.deepEqual(yield* state.fs.readDirectory(state.directory), []);
        yield* assertCleanStaging(state);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("explicit mirror retains remote download and never invokes gh", () =>
    Effect.gen(function* () {
      const state = yield* fixture("missing-release");
      yield* invoke("launch", {
        archiveVersion: version,
        archiveDirectory: state.directory,
        releaseBaseUrl: "https://mirror.example/goat/",
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner));
      assert.deepEqual(state.calls, ["probe", "launch", "cleanup"]);
      assert.deepEqual(state.uploads, []);
      assert.deepEqual(yield* state.fs.readDirectory(state.directory), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["ready", "cached"] as const)("%s skips gh", (mode) =>
    Effect.gen(function* () {
      const state = yield* fixture("missing-release", mode === "ready");
      if (mode === "cached") yield* state.fs.writeFile(`${state.directory}/${asset}`, bytes);
      yield* invoke("launch", { archiveVersion: version, archiveDirectory: state.directory }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner),
      );
      assert.deepEqual(
        state.calls,
        mode === "ready" ? ["probe", "launch"] : ["probe", "upload", "launch", "cleanup"],
      );
      assert.deepEqual(state.uploads, mode === "ready" ? [] : [bytes]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("blank mirror does not authorize anonymous download", () =>
    Effect.gen(function* () {
      const state = yield* fixture("missing-release");
      const result = yield* Effect.result(
        invoke("launch", {
          archiveVersion: version,
          archiveDirectory: state.directory,
          releaseBaseUrl: "  ",
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)),
      );
      assert.isTrue(Result.isFailure(result));
      assert.deepEqual(state.calls, ["probe", "gh"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["directory", "platform"] as const)(
    "missing supported %s fails before launch",
    (mode) =>
      Effect.gen(function* () {
        const state = yield* fixture("ok", false, mode === "platform");
        const result = yield* Effect.result(
          invoke("launch", {
            archiveVersion: version,
            ...(mode === "platform" ? { archiveDirectory: state.directory } : {}),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assertContext(
            result.failure,
            mode === "platform" ? state.directory : "<not configured>",
            mode === "platform" ? "unsupported-darwin-x64" : asset,
          );
        assert.deepEqual(state.calls, ["probe"]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("minimal PATH reports gh not found on PATH with no remote acquisition", () =>
    Effect.gen(function* () {
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const state = yield* fixture();
      const emptyPath = `${state.root}/empty-path`;
      yield* state.fs.makeDirectory(emptyPath);
      const spawner = lazyChildProcessSpawner((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "gh") {
          return state.spawner.spawn(command);
        }
        // Real Node spawn, isolated child environment; never mutate process.env.
        return realSpawner.spawn(
          ChildProcess.make(command.command, command.args, {
            ...command.options,
            extendEnv: false,
            env: { PATH: emptyPath, GH_PROMPT_DISABLED: "1" },
          }),
        );
      });
      const result = yield* Effect.result(
        invoke("launch", {
          archiveVersion: version,
          archiveDirectory: state.directory,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assertContext(result.failure, state.directory);
        assert.include(detailOf(result.failure), "gh not found on PATH");
      }
      assert.deepEqual(state.calls, ["probe"]);
      assert.deepEqual(state.uploads, []);
      assert.deepEqual(yield* state.fs.readDirectory(state.directory), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ghCommand override acquires and uploads from a spaced executable path", () =>
    Effect.gen(function* () {
      const ghCommand = "/fixture tools/gh";
      const state = yield* fixture("ok", false, false, undefined, ghCommand);
      yield* invoke("launch", {
        archiveVersion: version,
        archiveDirectory: state.directory,
        ghCommand,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner));
      assert.deepEqual(state.calls, ["probe", "gh", "upload", "launch", "cleanup"]);
      assert.deepEqual(state.uploads, [bytes]);
      assert.deepEqual(yield* state.fs.readFile(`${state.directory}/${asset}`), bytes);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("gh failure includes bounded sanitized stderr", () =>
    Effect.gen(function* () {
      const state = yield* fixture("stderr");
      const result = yield* Effect.result(
        invoke("launch", {
          archiveVersion: version,
          archiveDirectory: state.directory,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assertContext(result.failure, state.directory);
        assert.include(detailOf(result.failure), "authentication failed");
        assert.include(detailOf(result.failure), "[redacted]");
        assert.notInclude(detailOf(result.failure), diagnosticSecret);
        assert.notMatch(detailOf(result.failure), /[\x00-\x1f\x7f-\x9f]/u);
        const acquisition = result.failure.cause;
        assert.instanceOf(acquisition, SshLaunchError);
        const ghFailure = acquisition instanceof SshLaunchError ? acquisition.cause : undefined;
        assert.instanceOf(ghFailure, SshLaunchError);
        const diagnostic =
          ghFailure instanceof SshLaunchError
            ? / stderr \(last 400 sanitized characters\): (.*)$/u.exec(ghFailure.message)?.[1]
            : undefined;
        assert.isDefined(diagnostic);
        assert.isAtMost(diagnostic?.length ?? Infinity, 400);
      }
      assert.deepEqual(state.calls, ["probe", "gh"]);
      assert.deepEqual(state.uploads, []);
      yield* assertCleanStaging(state);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["valid", "tampered", "malformed"] as const)(
    "cached archive with %s sidecar is checked before upload",
    (mode) =>
      Effect.gen(function* () {
        const state = yield* fixture("missing-release");
        yield* state.fs.writeFile(
          `${state.directory}/${asset}`,
          mode === "tampered" ? new Uint8Array([1, 128, 255]) : bytes,
        );
        yield* state.fs.writeFileString(
          `${state.directory}/${asset}.sha256`,
          mode === "malformed" ? "not a checksum\n" : `${sha256}  ${asset}\n`,
        );
        const result = yield* Effect.result(
          invoke("launch", {
            archiveVersion: version,
            archiveDirectory: state.directory,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)),
        );
        if (mode === "valid") {
          assert.isTrue(Result.isSuccess(result));
          assert.deepEqual(state.calls, ["probe", "upload", "launch", "cleanup"]);
          assert.deepEqual(state.uploads, [bytes]);
        } else {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.instanceOf(result.failure, SshLaunchError);
            assert.include(detailOf(result.failure), "SHA-256 mismatch or malformed sidecar");
          }
          assert.deepEqual(state.calls, ["probe"]);
          assert.deepEqual(state.uploads, []);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("two prepares race with one complete cache publication and no partial visible", () =>
    Effect.gen(function* () {
      const barrier: DownloadBarrier = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
        secondProbe: yield* Deferred.make<void>(),
      };
      const state = yield* fixture("ok", false, false, barrier);
      const archivePath = `${state.directory}/${asset}`;
      const sidecarPath = `${archivePath}.sha256`;
      const observed: string[] = [];
      const observedFs = {
        ...state.fs,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            if (to === archivePath) {
              // Observe the actual filesystem on both sides of the publication.
              assert.isFalse(yield* state.fs.exists(archivePath));
              assert.deepEqual(yield* state.fs.readFile(from), bytes);
              assert.equal(yield* state.fs.readFileString(sidecarPath), `${sha256}  ${asset}\n`);
            }
            yield* state.fs.rename(from, to);
            if (to === archivePath) {
              assert.deepEqual(yield* state.fs.readFile(archivePath), bytes);
              observed.push("archive");
            } else if (to === sidecarPath) {
              assert.isFalse(yield* state.fs.exists(archivePath));
              assert.equal(yield* state.fs.readFileString(sidecarPath), `${sha256}  ${asset}\n`);
              observed.push("sidecar");
            }
          }),
      };
      const prepare = SshTunnel.prepareRemoteRuntime(
        target,
        {},
        {
          archiveVersion: version,
          archiveDirectory: state.directory,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner),
        Effect.provideService(FileSystem.FileSystem, observedFs),
      );
      const first = yield* Effect.forkChild(prepare);
      yield* Deferred.await(barrier.entered);
      const second = yield* Effect.forkChild(prepare);
      yield* Deferred.await(barrier.secondProbe);
      // Download has only partial staging bytes; neither public cache file exists.
      assert.isFalse(yield* state.fs.exists(archivePath));
      assert.isFalse(yield* state.fs.exists(sidecarPath));
      yield* Deferred.succeed(barrier.release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(observed, ["sidecar", "archive"]);
      assert.equal(state.calls.filter((call) => call === "gh").length, 1);
      assert.deepEqual(state.uploads, [bytes, bytes]);
      assert.deepEqual(
        (yield* state.fs.readDirectory(state.directory)).sort(),
        [asset, `${asset}.sha256`].sort(),
      );
      assert.deepEqual(yield* state.fs.readFile(archivePath), bytes);
      assert.equal(yield* state.fs.readFileString(sidecarPath), `${sha256}  ${asset}\n`);
      yield* assertCleanStaging(state);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("timeout closes gh scope and removes staging without publication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const entered = yield* Deferred.make<void>();
      let closed = false;
      const spawner = lazyChildProcessSpawner(() =>
        Effect.gen(function* () {
          yield* Scope.addFinalizer(
            yield* Scope.Scope,
            Effect.sync(() => {
              closed = true;
            }),
          );
          yield* Deferred.succeed(entered, undefined);
          return { ...processHandle(), exitCode: Effect.never };
        }),
      );
      const download = yield* Effect.forkChild(
        Effect.result(
          downloadRuntimeArchiveWithGh(root, version, "linux-x64").pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(Duration.millis(300_001));
      const result = yield* Fiber.join(download);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assertContext(result.failure, root);
        assert.include(detailOf(result.failure), "timed out");
      }
      assert.isTrue(closed);
      assert.deepEqual(yield* fs.readDirectory(root), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
