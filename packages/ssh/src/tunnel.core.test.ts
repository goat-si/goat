import * as NodeNet from "node:net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it, beforeEach, afterEach, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { SshCommandError, SshLaunchError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
import baseline from "./fixtures/remote-runner-baseline.json" with { type: "json" };
import {
  remoteShell,
  remoteShellCommand,
  TEST_NODE_ENGINE_RANGE,
  makeSuccessfulProcess,
  makeDelayedSuccessfulProcess,
  makeRunningProcess,
  testHttpClient,
  hangingHttpClient,
  testNetService,
  commandArgs,
  ARCHIVE,
  PROTOCOL_ARCHIVE,
  NODE_SCRIPT,
  uploadTarget,
  platform,
  arch,
  encoder,
  makeUploadFixture,
  recordSpans,
  makeProtocolTestSpawner,
  nativeScripts,
  nativeScriptsBatch,
  installArchivePsDouble,
  isRemoteLaunch,
} from "./tunnel.fixture.ts";
import { nextVersion, shell, fixture } from "./tunnel.runnerSwitch.fixture.ts";
import { killGroupWithTestOwner } from "./testParentLifetime.fixture.ts";
import { makeEnsureFlightFixture } from "./tunnel.ensure-flight.fixture.ts";

// Archive acquisition stays local to these transport doubles.
beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 404 })));
afterEach(() => vi.unstubAllGlobals());
const versionEntries = (...versions: string[]) =>
  platform === "linux" ? [".maintenance.lock", ...versions] : versions;

describe("ssh tunnel scripts", () => {
  it.live("generates valid shell syntax with GOAT runtime variables and legacy peer metadata", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const generated = yield* nativeScriptsBatch([{ input: ARCHIVE }, { input: NODE_SCRIPT }]);
      for (const scripts of generated) {
        assert.include(scripts.runner, "GOAT_NODE_SCRIPT_PATH=");
        assert.include(scripts.runner, "T3_NODE_SCRIPT_PATH=");
        assert.notMatch(scripts.runner, /\$[{]?T3_/);
        for (const script of Object.values(scripts)) {
          if (script === null) continue;
          const child = yield* spawner.spawn(
            ChildProcess.make(remoteShell, ["-n"], {
              stdin: { stream: Stream.make(encoder.encode(script)), endOnDone: true },
            }),
          );
          const result = yield* Effect.all({
            code: child.exitCode,
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          });
          assert.equal(result.code, 0, result.stderr);
        }
      }
      assert.include(generated[0]!.runner, `T3_ARCHIVE_VERSION='${ARCHIVE.archiveVersion}'`);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect(
    "preserves runner bytes and keeps cache directories out of launch and pairing scripts",
    () =>
      Effect.gen(function* () {
        const inputs = {
          archive: ARCHIVE,
          mirror: { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror/" },
          node: {
            nodeScriptPath: "/fixture/cli entry.mjs",
            nodeEngineRange: TEST_NODE_ENGINE_RANGE,
          },
        };
        const requests = (["archive", "mirror", "node"] as const).flatMap((key) =>
          [
            inputs[key],
            { ...inputs[key], archiveDirectory: "/fixture/archives" },
            { ...inputs[key], bundledArchiveDirectory: "/fixture/bundle" },
            {
              ...inputs[key],
              archiveDirectory: "/fixture/archives",
              bundledArchiveDirectory: "/fixture/bundle",
            },
          ].map((input) => ({ input })),
        );
        const results = yield* nativeScriptsBatch(requests);
        let index = 0;
        for (const key of ["archive", "mirror", "node"] as const) {
          const first = results[index]!;
          for (let variant = 0; variant < 4; variant++) {
            const actual = results[index++]!;
            assert.equal(actual.runner, baseline[key].runner);
            assert.equal(actual.launch, baseline[key].launch);
            assert.equal(actual.launch, first.launch);
            assert.equal(actual.pairing, first.pairing);
          }
          if (key === "node") continue;
          const ordinary = baseline[key].runner;
          const start = ordinary.indexOf(
            '  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS"',
          );
          const end = ordinary.indexOf("  if command -v sha256sum >/dev/null 2>&1; then");
          const upload = first.upload!;
          assert.equal(upload.slice(0, start), ordinary.slice(0, start));
          assert.equal(
            upload.slice(upload.indexOf("  if command -v sha256sum >/dev/null 2>&1; then")),
            ordinary.slice(end),
          );
          assert.include(upload, `GOAT_EXPECTED='${"a".repeat(64)}'`);
          assert.equal(first.runner, ordinary);
        }
        assert.throws(
          () => SshTunnel.buildRemoteGoatUploadInstallerScript(inputs.node, "a".repeat(64)),
          SshLaunchError,
        );
        assert.throws(
          () => SshTunnel.buildRemoteGoatUploadInstallerScript({}, "a".repeat(64)),
          SshLaunchError,
        );
        assert.throws(
          () => SshTunnel.buildRemoteGoatUploadInstallerScript(ARCHIVE, "no"),
          SshLaunchError,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("preserves literal shell PIDs through every nested script builder", () =>
    Effect.gen(function* () {
      const lockOwner = `printf '%s\\n' "$$" > "$GOAT_LOCK_CANDIDATE/pid"`;
      for (const input of [
        ARCHIVE,
        { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror/" },
        { nodeScriptPath: "/fixture/cli entry.mjs", nodeEngineRange: TEST_NODE_ENGINE_RANGE },
      ]) {
        const generated = yield* nativeScripts(input);
        for (const field of ["runner", "launch", "pairing", "mcp"] as const) {
          assert.include(generated[field], lockOwner, field);
          assert.notInclude(
            generated[field],
            `printf '%s\\n' "$" > "$GOAT_LOCK_CANDIDATE/pid"`,
            field,
          );
        }
        for (const field of ["launch", "pairing", "mcp"] as const) {
          assert.include(generated[field], 'RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"', field);
          const nested = generated[field].split("<<'SH'\n")[1]!.split("\nSH\n")[0]!;
          assert.equal(nested, generated.runner, field);
        }
        if (generated.upload !== null) assert.include(generated.upload, lockOwner);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("inserts dollar metacharacters literally in nested quoted runner paths", () =>
    Effect.gen(function* () {
      const generated = yield* nativeScripts({ nodeScriptPath: "/fixture/dollar $$ $& entry.mjs" });
      for (const field of ["runner", "launch", "pairing", "mcp"] as const) {
        assert.include(generated[field], "GOAT_NODE_SCRIPT_PATH='/fixture/dollar $$ $& entry.mjs'");
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteGoatRunnerScript(ARCHIVE);

    assert.include(script, "GOAT_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "GOAT_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "GOAT_RELEASE_BASE_URL='https://github.com/goat-si/goat-releases/releases/download'",
    );
    assert.include(
      script,
      'GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$GOAT_ARCHIVE_VERSION"',
    );
    assert.include(
      script,
      'GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM-$GOAT_ARCH.tar.gz"',
    );
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$GOAT_RUNTIME_DIR/goat" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    // Concurrent launches serialize on a per-version directory lock and recheck
    // the completion marker after acquiring it.
    assert.include(
      script,
      'GOAT_LOCK="$HOME/.goat/runtime/goat/versions/.$GOAT_ARCHIVE_VERSION.install.lock"',
    );
    // Publish the pid before the atomic move, and pin stale cleanup to a cwd.
    assert.include(script, 'mv "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK"');
    assert.include(script, 'cd "$GOAT_LOCK" 2>/dev/null || exit 0');
    assert.include(script, 'if kill -0 "$GOAT_LOCK_OWNER" 2>/dev/null; then exit 2; fi');
    assert.include(script, 'elif [ "$GOAT_LOCK_UNOWNED" -lt 4 ]; then');
    assert.include(script, 'if [ "$GOAT_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$GOAT_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$GOAT_STAGING/$GOAT_ARCHIVE" 240');
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! goat_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$GOAT_STAGING/goat" --version'),
      script.indexOf('> "$GOAT_STAGING/.install-complete"'),
    );
    // Node discovery is defined for the dev path but only ever invoked inside
    // the node-script branch, which the archive path skips entirely.
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$GOAT_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$GOAT_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("GOAT_ARCHIVE_VERSION="),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/goat/",
    });
    assert.include(launch, "GOAT_ARCHIVE_MODE=1");
    assert.include(launch, "GOAT_RELEASE_BASE_URL='https://mirror.example/goat'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, "__ssh-helper protocol --runtime-file");
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "GOAT_ARCHIVE_MODE=0");
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteGoatRunnerScript(ARCHIVE),
      "GOAT_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it("refuses to build a runner with neither an archive version nor a node script", () => {
    for (const input of [undefined, {}, { archiveVersion: "  " }, { nodeScriptPath: null }]) {
      assert.throws(
        () => SshTunnel.buildRemoteGoatRunnerScript(input),
        SshTunnel.SshMissingRunnerError,
      );
    }
    assert.throws(() => SshTunnel.buildRemoteLaunchScript(), SshTunnel.SshMissingRunnerError);
  });

  it("does not hard-code a remote node engine range", () => {
    const script = SshTunnel.buildRemoteGoatRunnerScript(NODE_SCRIPT);

    assert.include(script, "GOAT_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const stateKey = "711bc738002d72fd";
    const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
    const devLaunch = SshTunnel.buildRemoteLaunchScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(launch, '[ "$LIVE_STATUS" = live ] && valid_positive "$LIVE_PID"');
    assert.include(launch, "RUNNER_CHANGED=1");
    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "ensure_remote_node_path || true");
    assert.include(devLaunch, `GOAT_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(devLaunch, "does not satisfy required range ");
    // A failed cold start still cleans up the child this script launched.
    assert.include(launch, 'server_kill "$REMOTE_PID" || true');
    assert.include(launch, "wait_ready");
    assert.include(launch, '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(launch, "server-home");
    assert.include(launch, "Remote GOAT server did not become ready");
    assert.include(launch, 'wait_ready "60000"');
    assert.include(launch, 'if [ -s "$LOG_FILE" ]; then');
    assert.include(launch, "It wrote nothing to %s");
    assert.include(launch, "GOAT_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"',
    );
    assert.notInclude(SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE), "server-home");
    assert.include(
      SshTunnel.buildRemotePairingScript(stateKey, ARCHIVE),
      "GOAT_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'if [ "$REMOTE_MANAGED" = managed ] && [ -n "$REMOTE_PID" ]; then',
    );
    assert.include(SshTunnel.buildRemoteStopScript(stateKey), 'server_kill "$REMOTE_PID" || true');
    assert.include(
      SshTunnel.buildRemoteStopScript(stateKey),
      'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"',
    );
    assert.include(SshTunnel.buildRemoteStopScript(stateKey), "did not stop within 2 seconds");
    assert.include(SshTunnel.buildRemoteStopScript(stateKey), "STOP_WAIT_INTERVAL=0.1");
    assert.include(SshTunnel.buildRemoteStopScript(stateKey), "STOP_WAIT_ATTEMPTS=20");
    assert.include(
      launch,
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(launch, "check_live_protocol()");
    assert.notInclude(launch, 'kill "$UPGRADE_PID"');
    assert.include(launch, '__ssh-helper drain --port "$UPGRADE_PORT"');
    assert.include(launch, 'nohup "$RUNNER_FILE" __ssh-helper supervise');
    assert.include(launch, 'REMOTE_PORT="$LIVE_PORT"');
    assert.include(launch, 'rm -f "$PID_FILE"');
    assert.include(launch, "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(launch, 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      launch.indexOf("check_live_protocol\n"),
      launch.indexOf('mv "$RUNNER_NEXT" "$RUNNER_FILE"'),
    );
  });

  it("checks for lsof before a runtime replacement can stop the server", () => {
    const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
    assert.include(launch, 'prepend_path_if_dir "/usr/sbin"');
    assert.include(launch, 'prepend_path_if_dir "/sbin"');
    assert.include(launch, "for candidate in /usr/sbin/lsof /sbin/lsof; do");
    const probe = launch.indexOf("if ! listener_probe_available; then");
    const drain = launch.indexOf('__ssh-helper drain --port "$UPGRADE_PORT"');
    const loop = launch.indexOf('while [ -z "$REMOTE_PORT" ]; do');
    assert.isAbove(probe, 0);
    assert.isBelow(probe, drain);
    assert.isBelow(probe, loop);
    assert.equal(launch.indexOf("this host needs /proc or lsof", loop), -1);
    assert.include(
      launch,
      "Cannot verify the launched GOAT listener: this host needs /proc or lsof. The existing server was left running.",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = makeProtocolTestSpawner((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess(
          'loaded nvm default\n{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3774}\n',
        );
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(
        target,
        undefined,
        PROTOCOL_ARCHIVE,
      );
      if (result.status !== "ready") throw new Error("Expected a ready runtime");
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each([
    ["node-script", NODE_SCRIPT, 75_000],
    ["archive", PROTOCOL_ARCHIVE, 800_000],
  ] as const)(
    "allows cold %s launches to exceed the default SSH command timeout",
    ([, runner, delayMs]) =>
      Effect.gen(function* () {
        const target = {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        } as const;
        const started = yield* Deferred.make<void>();
        const child = makeDelayedSuccessfulProcess(
          '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3774}\n',
          delayMs,
        );
        const spawner = makeProtocolTestSpawner(() =>
          Effect.succeed({
            ...child,
            exitCode: Deferred.succeed(started, undefined).pipe(Effect.andThen(child.exitCode)),
          }),
        );
        const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
        const layerProcess = Layer.mergeAll(NodeServices.layer, layerSpawner, TestClock.layer());

        return yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            SshTunnel.launchOrReuseRemoteServer(target, undefined, runner),
          );
          yield* Deferred.await(started);
          yield* TestClock.adjust(Duration.millis(delayMs));

          const result = yield* Fiber.join(fiber);
          if (result.status !== "ready") throw new Error("Expected a ready runtime");
          assert.equal(result.remotePort, 3774);
        }).pipe(Effect.provide(layerProcess));
      }),
  );

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(SshTunnel.REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          SshTunnel.waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      SshTunnel.describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect.each([
    ["from the remote CLI", ""],
    ["after remote shell startup noise", "loaded nvm default\n"],
  ] as const)("accepts pretty-printed pairing JSON %s", ([, prefix]) => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = makeProtocolTestSpawner((command) =>
      Effect.gen(function* () {
        const input = command._tag === "StandardCommand" ? command.options.stdin : undefined;
        const bytes =
          input !== undefined &&
          typeof input === "object" &&
          "stream" in input &&
          Stream.isStream(input.stream)
            ? yield* input.stream.pipe(Stream.runCollect)
            : [];
        const script = new TextDecoder().decode(
          new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
        );
        if (script.includes("ready=false")) {
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: true }));
        }
        return makeSuccessfulProcess(`${prefix}{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`);
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, PROTOCOL_ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.each(["successful reconnect", "failed reconnect"] as const)(
    "stale local forward never stops the remote during %s",
    (mode) =>
      Effect.gen(function* () {
        let forwards = 0;
        let kills = 0;
        let launches = 0;
        let stops = 0;
        let remoteRunning = true;
        let stale = false;
        const probeStarted = yield* Deferred.make<void>();
        const spawner = makeProtocolTestSpawner((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G"))
              return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
            if (args.includes("-N")) {
              forwards++;
              return makeRunningProcess(() => {
                kills++;
              });
            }
            if (isRemoteLaunch(args)) {
              launches++;
              if (launches === 2 && mode === "failed reconnect")
                return {
                  ...makeSuccessfulProcess(""),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                  stderr: Stream.make(encoder.encode("Cannot prepare requested GOAT version")),
                };
              stale = false;
              return makeSuccessfulProcess(
                '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}',
              );
            }
            if (args.includes("sh")) {
              stops++;
              remoteRunning = false;
              return makeSuccessfulProcess('{"stopped":true}');
            }
            return makeSuccessfulProcess("");
          }),
        );
        const client = HttpClient.make((request) =>
          stale
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
              ),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          stale = true;
          const reconnect = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(probeStarted);
          yield* TestClock.adjust(Duration.seconds(2));
          const result = yield* Fiber.join(reconnect);
          assert.equal(kills, 1);
          assert.equal(stops, 0);
          assert.isTrue(remoteRunning);
          assert.equal(forwards, mode === "successful reconnect" ? 2 : 1);
          assert.equal(launches, 2);
          assert.equal(Result.isSuccess(result), mode === "successful reconnect");
          // A failed reconnect is not a remote pending result; explicit disconnect still stops.
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(stops, 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
        assert.equal(stops, 1);
      }),
  );

  it.effect("revalidation after sleep keeps a live forward and closes only a dead one", () =>
    Effect.gen(function* () {
      let forwards = 0;
      let kills = 0;
      let stops = 0;
      let stale = false;
      const probeStarted = yield* Deferred.make<void>();
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
          if (args.includes("-N")) {
            forwards++;
            return makeRunningProcess(() => {
              kills++;
            });
          }
          if (isRemoteLaunch(args)) {
            stale = false;
            return makeSuccessfulProcess(
              '{"status":"ready","selectedVersion":"0.1.0","remotePort":3773,"serverKind":"managed"}',
            );
          }
          if (args.includes("sh")) {
            stops++;
            return makeSuccessfulProcess('{"stopped":true}');
          }
          return makeSuccessfulProcess("");
        }),
      );
      // A forward whose TCP connection died during sleep accepts and never answers.
      const client = HttpClient.make((request) =>
        stale
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);

        yield* manager.revalidateTunnels();
        assert.equal(kills, 0);

        stale = true;
        const revalidation = yield* Effect.forkChild(manager.revalidateTunnels());
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Fiber.join(revalidation);
        assert.equal(kills, 1);
        assert.equal(stops, 0);

        // The next ensure opens a new forward instead of probing the dead one again.
        yield* manager.ensureEnvironment(uploadTarget);
        assert.equal(forwards, 2);
        assert.equal(stops, 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let tunnelKillCount = 0;
      let stopCommandCount = 0;
      const spawner = makeProtocolTestSpawner((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          spawnedCommands.push(args);
          if (args.includes("-N")) {
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            });
          }
          if (args.includes("sh") && isRemoteLaunch(args)) {
            return makeSuccessfulProcess(
              '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773}\n',
            );
          }
          if (args.includes("sh")) {
            stopCommandCount += 1;
            if (mode === "failed stop" && stopCommandCount === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(
                  new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                ),
              };
            }
            return makeSuccessfulProcess('{"stopped":true}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;

        const first = yield* manager.ensureEnvironment(target);
        if ("type" in first) throw new Error("Expected a ready environment");
        assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
        const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
        assert.isDefined(firstTunnelArgs);
        assert.include(firstTunnelArgs, "ControlMaster=no");
        assert.include(firstTunnelArgs, "ControlPath=none");
        assert.include(firstTunnelArgs, "ControlPersist=no");
        assert.deepEqual(firstTunnelArgs?.slice(-2), ["--", "julius@devbox"]);

        const disconnected = yield* Effect.result(manager.disconnectEnvironment(target));
        if (mode === "failed stop") {
          assert.isTrue(Result.isFailure(disconnected));
          if (Result.isFailure(disconnected)) {
            assert.instanceOf(disconnected.failure, SshCommandError);
            assert.equal(
              disconnected.failure.message,
              "Remote T3 server did not stop within 2 seconds.",
            );
          }
        } else {
          assert.isTrue(Result.isSuccess(disconnected));
        }
        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 1);

        if (mode === "failed stop") {
          yield* manager.disconnectEnvironment(target);
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 2);
        }

        yield* manager.ensureEnvironment(target);

        assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
        assert.equal(tunnelKillCount, 1);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(tunnelKillCount, 2);
            assert.equal(stopCommandCount, mode === "failed stop" ? 3 : 2);
          }),
        ),
      );
    },
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let observeReconnects = false;
        let reconnectResolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = makeProtocolTestSpawner((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && observeReconnects && ++reconnectResolutions === 2) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (isRemoteLaunch(args)) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess(
                '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773}\n',
              );
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          observeReconnects = true;
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          if ("type" in first || "type" in second) throw new Error("Expected ready environments");
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// Fake runtime fixtures use extensionless #!/bin/sh scripts and POSIX executable bits.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("runtime preparation", () => {
  it.live.each([
    { entry: "launch", mode: "ready" },
    { entry: "mcp", mode: "ready" },
    { entry: "launch", mode: "missing" },
    { entry: "mcp", mode: "missing" },
    { entry: "launch", mode: "dev" },
    { entry: "mcp", mode: "dev" },
    { entry: "launch", mode: "none" },
    { entry: "mcp", mode: "none" },
    { entry: "launch", mode: "invalid" },
    { entry: "mcp", mode: "invalid" },
    { entry: "pairing", mode: "ready" },
    { entry: "pairing", mode: "missing" },
    { entry: "pairing", mode: "dev" },
    { entry: "pairing", mode: "none" },
    { entry: "pairing", mode: "invalid" },
    { entry: "pairing", mode: "upstream-only" },
    { entry: "pairing", mode: "marker-only" },
    { entry: "pairing", mode: "non-executable" },
    { entry: "pairing", mode: "wrong-marker" },
    { entry: "launch", mode: "upstream-only" },
    { entry: "mcp", mode: "upstream-only" },
    { entry: "launch", mode: "marker-only" },
    { entry: "mcp", mode: "marker-only" },
    { entry: "launch", mode: "non-executable" },
    { entry: "mcp", mode: "non-executable" },
    { entry: "launch", mode: "wrong-marker" },
    { entry: "mcp", mode: "wrong-marker" },
  ] as const)("$entry preparation with retained runtime=$mode", ({ entry, mode }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-retained-preparation-" });
      const stateKey = REMOTE_RUNTIME_STATE_KEY;
      const state = `${root}/.goat/ssh-launch/${stateKey}`;
      const retainedVersion = mode === "invalid" ? "01.2.3" : "1.2.2-preview.20260910.1";
      const retainedScript =
        mode === "dev"
          ? "#!/bin/sh\nT3_NODE_SCRIPT_PATH='/fixture/dev entry.mjs'\n"
          : `#!/bin/sh\nT3_NODE_SCRIPT_PATH=''\nT3_ARCHIVE_VERSION='${retainedVersion}'\n`;
      if (mode !== "none") {
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.writeFileString(`${state}/run-t3.sh`, retainedScript);
        yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
      }
      const upstream = `${root}/.t3/runtime/versions/${retainedVersion}`;
      if (mode === "upstream-only") {
        yield* fs.makeDirectory(upstream, { recursive: true });
        yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n");
        yield* fs.chmod(`${upstream}/t3`, 0o700);
        yield* fs.writeFileString(`${upstream}/.install-complete`, retainedVersion);
      }
      if (
        mode === "ready" ||
        mode === "marker-only" ||
        mode === "non-executable" ||
        mode === "wrong-marker"
      ) {
        const runtime = `${root}/.goat/runtime/goat/versions/${retainedVersion}`;
        yield* fs.makeDirectory(runtime, { recursive: true });
        if (mode !== "marker-only") {
          yield* fs.writeFileString(
            `${runtime}/goat`,
            `#!/bin/sh
if [ "$1" = --version ]; then printf 'goat v${retainedVersion}\\n';
elif [ "$2" = protocol ]; then
  case " $* " in *" --runtime-file "*) printf 'none unknown unknown unknown 0 0\\n';; *) printf '${retainedVersion} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0\\n';; esac
else exit 2; fi
`,
          );
          yield* fs.chmod(`${runtime}/goat`, mode === "non-executable" ? 0o600 : 0o700);
        }
        yield* fs.writeFileString(
          `${runtime}/.install-complete`,
          mode === "wrong-marker" ? ARCHIVE.archiveVersion : retainedVersion,
        );
      }
      const archiveDirectory = `${root}/missing-cache`;
      const calls: string[] = [];
      const spans: Tracer.Span[] = [];
      let cacheReads = 0;
      const checkedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (file) => {
          if (file.startsWith(archiveDirectory)) cacheReads++;
          return fs.exists(file);
        },
        readFile: (file) => {
          if (file.startsWith(archiveDirectory)) cacheReads++;
          return fs.readFile(file);
        },
      });
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
          if (command.command === "gh") {
            calls.push("gh");
            return {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            };
          }
          const input = command.options.stdin;
          const chunks =
            input !== undefined &&
            typeof input === "object" &&
            "stream" in input &&
            Stream.isStream(input.stream)
              ? yield* input.stream.pipe(Stream.runCollect)
              : [];
          const data = new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
          if (command.args.includes("goat-runtime-cleanup")) {
            calls.push("cleanup");
            return makeSuccessfulProcess("");
          }
          if (command.args.includes("-c")) {
            calls.push("upload");
            assert.include(command.args.join(" "), ARCHIVE.archiveVersion);
            return makeSuccessfulProcess("");
          }
          if (
            !isRemoteLaunch(command.args) &&
            new TextDecoder().decode(data).includes("ready=false")
          ) {
            calls.push("probe");
            // Execute the real probe against the isolated remote HOME.
            return yield* realSpawner.spawn(
              ChildProcess.make(remoteShell, ["-s"], {
                env: { HOME: root },
                stdin: Stream.make(data),
              }),
            );
          }
          calls.push(entry);
          return makeSuccessfulProcess(
            entry === "launch"
              ? '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}'
              : entry === "pairing"
                ? '{"credential":"fixture-pairing"}'
                : 'T3_CEILING=default\n{"token":"fixture-session","expiresAt":null}',
          );
        }),
      );
      const runner = {
        ...ARCHIVE,
        archiveDirectory,
        keepExistingRunner: true,
        ...(mode !== "ready" ? { releaseBaseUrl: "https://mirror.example/goat" } : {}),
      };
      const invocation =
        entry === "launch"
          ? SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner).pipe(Effect.asVoid)
          : entry === "pairing"
            ? SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner).pipe(Effect.asVoid)
            : SshTunnel.issueRemoteMcpClientSession(
                uploadTarget,
                {
                  ttl: "1h",
                  label: "fixture",
                  runtimeModeCeiling: null,
                },
                {},
                runner,
              ).pipe(Effect.asVoid);
      const result = yield* Effect.result(
        invocation.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, checkedFs),
          Effect.withTracer(recordSpans(spans)),
        ),
      );
      assert.isTrue(Result.isSuccess(result));
      // Cleanup is a best-effort trailing call after a launch that installed a runtime.
      assert.deepEqual(
        calls.filter((call) => call !== "cleanup"),
        ["probe", entry],
      );
      assert.isTrue(calls.indexOf("cleanup") === -1 || calls.at(-1) === "cleanup");
      assert.equal(
        spans
          .find((span) => span.name === "ssh.prepareRemoteRuntime")
          ?.attributes.get("goat.runtime.source"),
        mode === "ready" ? "retained-runner" : "download",
      );
      assert.equal(yield* fs.exists(archiveDirectory), false);
      if (mode === "ready") assert.equal(cacheReads, 0);
      else assert.isAbove(cacheReads, 0);
      if (mode !== "none")
        assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), retainedScript);
      if (mode === "upstream-only")
        assert.equal(yield* fs.readFileString(`${upstream}/t3`), "#!/bin/sh\nexit 97\n");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("does not restart an existing managed server after runtime preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-managed-preparation-" });
      const runtime = `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
      const state = `${root}/.goat/ssh-launch/${REMOTE_RUNTIME_STATE_KEY}`;
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.makeDirectory(state, { recursive: true });
      const cli = `${runtime}/goat`;
      yield* fs.writeFileString(
        cli,
        `#!${process.execPath}
import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("goat v${ARCHIVE.archiveVersion}"); }
else if (args[0] === "__ssh-helper") {
  if (args[1] === "protocol") {
    if (!args.includes("--runtime-file")) console.log("${ARCHIVE.archiveVersion} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0");
    else {
            const at = args.indexOf("--runtime-file");
      const value = await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readLiveSshRuntimeProtocol(args[at+1]);
      console.log((value.status+" ") + [value.serverVersion ?? "unknown",value.sshRuntimeProtocolVersion ?? "unknown",value.orchestrationProtocolVersion ?? "unknown",value.pid ?? 0,value.port ?? 0].join(" "));
    }
  }
  if (args[1] === "runtime-port") process.exit(1);
  if (args[1] === "pick-port") console.log(3773);
  if (args[1] === "wait-ready") {
    const request = http.get("http://127.0.0.1:"+args[2]+"/",response=>{response.resume();response.on("end",()=>process.exit(0));});
    request.on("error",()=>process.exit(1));
  }
} else if (args[0] === "auth") { console.log(JSON.stringify({ credential: "fixture-pairing" })); }
else {
  fs.appendFileSync("${root}/starts", "start\\n");
  const fields = {serverVersion:"${ARCHIVE.archiveVersion}",sshRuntimeProtocolVersion:${SSH_RUNTIME_PROTOCOL_VERSION},orchestrationProtocolVersion:${ORCHESTRATION_PROTOCOL_VERSION}};
  const server = http.createServer((request,response) => response.end(["/.well-known/goat/environment", "/.well-known/t3/environment"].includes(request.url) ? JSON.stringify({environmentId:"fixture",label:"Fixture",platform:{os:"linux",arch:"x64"},capabilities:{},...fields}) : "ok"));
  process.on("SIGTERM", () => { fs.appendFileSync("${root}/stops", "stop\\n"); server.close(); });
  server.listen(0, "127.0.0.1", () => {
    const record = {version:1,startedAt:"2026-10-11T00:00:00.000Z",...fields,pid:process.pid,port:server.address().port,origin:"http://127.0.0.1:"+server.address().port};
    fs.mkdirSync("${root}/.goat/userdata",{recursive:true});fs.writeFileSync("${root}/.goat/userdata/server-runtime.json",JSON.stringify(record));
    console.log(JSON.stringify(record));
  });
}
`,
      );
      yield* fs.chmod(cli, 0o700);
      yield* fs.writeFileString(`${runtime}/.install-complete`, ARCHIVE.archiveVersion);
      const child = yield* realSpawner.spawn(
        ChildProcess.make(cli, ["serve"], { detached: false }),
      );
      yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
      const started = JSON.parse(
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.mkString,
        ),
      ) as { pid: number; port: number };
      assert.equal(started.pid, child.pid);
      yield* fs.writeFileString(`${state}/pid`, `${started.pid}\n`);
      yield* fs.writeFileString(`${state}/port`, `${started.port}\n`);
      yield* fs.writeFileString(`${state}/managed`, "managed\n");
      yield* fs.writeFileString(
        `${state}/identity`,
        `${cli} serve --host 127.0.0.1 --port ${started.port} --base-dir ${root}/.goat\n`,
      );
      yield* installArchivePsDouble(root, started.pid, started.port, ARCHIVE.archiveVersion);
      // Use the persisted heredoc bytes, including existing placeholder escaping.
      const persistedRunner =
        baseline.archive.launch.split("<<'SH'\n")[1]!.split("\nSH\n")[0]! + "\n";
      yield* fs.writeFileString(`${state}/run-t3.sh`, persistedRunner);
      yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
      const scripts = yield* nativeScripts(ARCHIVE);
      let uploads = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.succeed(makeSuccessfulProcess(""));
        const args = command.args;
        if (args.includes("-c")) uploads++;
        const remoteArgs = args.slice(args.indexOf("sh") + 1).filter((arg) => arg !== "-l");
        const stdin = isRemoteLaunch(args)
          ? Stream.make(encoder.encode(scripts.launch))
          : args.includes("-l")
            ? command.options.stdin
            : Stream.make(encoder.encode(scripts.pairing));
        return realSpawner.spawn(
          ChildProcess.make(remoteShell, remoteArgs, {
            env: { HOME: root, PATH: `${root}/.test/identity-bin:${process.env.PATH ?? ""}` },
            stdin,
          }),
        );
      });
      const runner = { ...ARCHIVE, archiveDirectory: `${root}/missing` };
      yield* Effect.gen(function* () {
        const first = yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner);
        if (first.status !== "ready") throw new Error("Expected a ready runtime");
        assert.equal(first.remotePort, started.port);
        assert.equal(first.remoteServerKind, "managed");
        const pairing = yield* SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner);
        assert.equal(pairing.credential, "fixture-pairing");
        const second = yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner);
        if (second.status !== "ready") throw new Error("Expected a ready runtime");
        assert.equal(second.remotePort, started.port);
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(uploads, 0);
      assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), persistedRunner);
      assert.equal((yield* fs.readFileString(`${state}/pid`)).trim(), String(started.pid));
      assert.equal((yield* fs.readFileString(`${state}/port`)).trim(), String(started.port));
      assert.equal(yield* fs.readFileString(`${root}/starts`), "start\n");
      assert.isFalse(yield* fs.exists(`${root}/stops`));
      assert.isTrue(yield* fs.exists(`${root}/.goat/userdata/server-runtime.json`));
      assert.isTrue(yield* child.isRunning);
      yield* child.kill({ killSignal: "SIGTERM" });
      assert.equal(yield* child.exitCode, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.each([
    "uploads the local archive to a cold remote",
    "downloads from an explicit mirror when no local archive exists",
    "skips upload when the remote runtime is ready",
  ] as const)("%s", (name) =>
    Effect.gen(function* () {
      const fixture = yield* makeUploadFixture();
      const { root, directory, bytes, fs, spawner: realSpawner } = fixture;
      const ready = name === "skips upload when the remote runtime is ready";
      const missing = name === "downloads from an explicit mirror when no local archive exists";
      const archiveDirectory = missing || ready ? `${root}/missing` : directory;
      const runner = {
        ...ARCHIVE,
        archiveDirectory,
        releaseBaseUrl: missing ? `file://${root}/mirror` : "file:///unavailable",
      };
      const calls: string[] = [];
      const auth: Array<{
        secret: string | undefined;
        batch: string | undefined;
        askpass: string | undefined;
      }> = [];
      const spans: Tracer.Span[] = [];
      let reads = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
          const args = command.args;
          const kind = args.includes("goat-runtime-cleanup")
            ? "cleanup"
            : args.includes("-c")
              ? "upload"
              : isRemoteLaunch(args)
                ? "launch"
                : "probe";
          calls.push(kind);
          if (kind === "cleanup") return makeSuccessfulProcess("");
          auth.push({
            secret: command.options.env?.T3_SSH_AUTH_SECRET,
            batch: args.find((arg) => arg.startsWith("BatchMode=")),
            askpass: command.options.env?.SSH_ASKPASS_REQUIRE,
          });
          if (kind === "probe")
            return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready }));
          if (kind === "upload") {
            const input = command.options.stdin;
            assert.isDefined(input);
            if (
              input !== undefined &&
              typeof input === "object" &&
              "stream" in input &&
              Stream.isStream(input.stream)
            ) {
              const chunks = yield* input.stream.pipe(Stream.runCollect);
              assert.deepEqual(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))), bytes);
            }
            const remoteArgs = args.slice(args.indexOf("sh"));
            return yield* realSpawner.spawn(
              ChildProcess.make(
                remoteShell,
                ["-c", [remoteShellCommand, ...remoteArgs.slice(1)].join(" ")],
                {
                  env: { HOME: root },
                  stdin: command.options.stdin,
                },
              ),
            );
          }
          if (missing) {
            const installer = yield* realSpawner.spawn(
              ChildProcess.make(
                remoteShell,
                ["-c", SshTunnel.buildRemoteGoatRunnerScript(runner), "--", "--version"],
                { env: { HOME: root } },
              ),
            );
            assert.equal(yield* installer.exitCode, 0);
          }
          return makeSuccessfulProcess(
            '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}',
          );
        }),
      );
      const checkedFs = FileSystem.FileSystem.of({
        ...fs,
        readFile: (file) => {
          if (file.startsWith(archiveDirectory)) reads++;
          return fs.readFile(file);
        },
      });
      yield* SshTunnel.launchOrReuseRemoteServer(
        uploadTarget,
        { authSecret: "fixture-password", batchMode: "no", interactiveAuth: true },
        runner,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, checkedFs),
        Effect.withTracer(recordSpans(spans)),
      );
      assert.deepEqual(
        calls,
        ready
          ? ["probe", "launch"]
          : missing
            ? ["probe", "launch", "cleanup"]
            : ["probe", "upload", "launch", "cleanup"],
      );
      assert.equal(reads, ready || missing ? 0 : 1);
      for (const options of auth)
        assert.deepEqual(options, {
          secret: "fixture-password",
          batch: "BatchMode=no",
          askpass: "force",
        });
      const span = spans.find((span) => span.name === "ssh.prepareRemoteRuntime");
      assert.equal(span?.attributes.get("ssh.target"), "devbox");
      assert.equal(
        span?.attributes.get("goat.runtime.source"),
        ready ? "ready" : missing ? "download" : "upload",
      );
      if (!ready && !missing) {
        assert.equal(span?.attributes.get("goat.runtime.upload.installComplete"), true);
        assert.equal(span?.attributes.get("goat.runtime.upload.sha256"), fixture.sha256);
        assert.equal(span?.attributes.get("goat.runtime.upload.bytes"), bytes.byteLength);
      }
      if (!ready)
        assert.equal(
          (yield* fs.readFileString(
            `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-complete`,
          )).trim(),
          ARCHIVE.archiveVersion,
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("surfaces local archive preparation errors during pairing", () =>
    Effect.gen(function* () {
      const { directory, fs } = yield* makeUploadFixture();
      yield* fs.truncate(
        `${directory}/goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`,
        268435457,
      );
      let calls = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          calls++;
          return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: false }));
        }),
      );
      const result = yield* Effect.result(
        SshTunnel.issueRemotePairingToken(
          uploadTarget,
          {},
          { ...ARCHIVE, archiveDirectory: directory },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshLaunchError);
        assert.include(result.failure.message, ARCHIVE.archiveVersion);
        assert.include(
          result.failure.message,
          `Remove goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz from ${directory}, then reconnect.`,
        );
      }
      assert.equal(calls, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("retries upload authentication through SshEnvironmentManager", () =>
    Effect.gen(function* () {
      const { directory } = yield* makeUploadFixture();
      let uploads = 0;
      let prompts = 0;
      const calls: Array<{
        kind: string;
        batch: string | undefined;
        secret: string | undefined;
        askpass: string | undefined;
      }> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
          if (args.includes("-N")) return makeRunningProcess(() => undefined);
          if (
            args.includes("-s") &&
            !args.includes("-l") &&
            calls.some((call) => call.kind === "pairing")
          )
            return makeSuccessfulProcess('{"stopped":true}');
          const kind = args.includes("goat-runtime-cleanup")
            ? "cleanup"
            : args.includes("-c")
              ? "upload"
              : isRemoteLaunch(args)
                ? "launch"
                : args.includes("-l")
                  ? "probe"
                  : "pairing";
          if (command._tag === "StandardCommand")
            calls.push({
              kind,
              batch: args.find((arg) => arg.startsWith("BatchMode=")),
              secret: command.options.env?.T3_SSH_AUTH_SECRET,
              askpass: command.options.env?.SSH_ASKPASS_REQUIRE,
            });
          if (kind === "probe")
            return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: uploads > 1 }));
          if (kind === "upload" && ++uploads === 1)
            return {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
              stderr: Stream.make(encoder.encode("Permission denied (publickey,password).")),
            };
          return makeSuccessfulProcess(
            kind === "launch"
              ? '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773}'
              : '{"credential":"fixture-pairing"}',
          );
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: () =>
              Effect.sync(() => {
                prompts++;
                return "fixture-password";
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed({ ...ARCHIVE, archiveDirectory: directory }),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        if ("type" in result) throw new Error("Expected a ready environment");
        assert.equal(result.pairingToken, "fixture-pairing");
      }).pipe(Effect.provide(layer), Effect.scoped);
      assert.equal(prompts, 1);
      assert.equal(uploads, 2);
      assert.deepEqual(
        calls.map((call) => call.kind),
        ["probe", "upload", "probe", "upload", "launch", "cleanup", "pairing"],
      );
      for (const call of calls.slice(0, 2))
        assert.deepEqual(
          { batch: call.batch, secret: call.secret, askpass: call.askpass },
          { batch: "BatchMode=yes", secret: undefined, askpass: undefined },
        );
      for (const call of calls.slice(2))
        assert.deepEqual(
          { batch: call.batch, secret: call.secret, askpass: call.askpass },
          { batch: "BatchMode=no", secret: "fixture-password", askpass: "force" },
        );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

// The archive runner is generated shell; string assertions cannot prove the
// lock excludes concurrent installers. Run the real script against a tiny
// fake archive served from a file:// mirror.
describe("archive runner script", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const hostArch = HostProcess.Architecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runShell = (home: string, args: string[], bytes?: Uint8Array, pathPrefix?: string) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        killGroupWithTestOwner(
          ChildProcess.make(remoteShell, args, {
            env: {
              PATH: pathPrefix
                ? `${pathPrefix}:${process.env.PATH ?? ""}`
                : (process.env.PATH ?? ""),
              HOME: home,
            },
            extendEnv: false,
            ...(bytes === undefined
              ? {}
              : { stdin: { stream: Stream.make(bytes), endOnDone: true } }),
          }),
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  const runRunner = (home: string, runner: string, pathPrefix?: string) =>
    runShell(home, [runner, "--version"], undefined, pathPrefix);
  const runUpload = (home: string, script: string, bytes: Uint8Array) =>
    runShell(home, ["-c", script], bytes);

  it.effect.skipIf(windowsHost)(
    "keeps a retained GOAT runner off upstream data despite an ambient T3 home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-identity-shell-" });
        const old = path.join(home, ".t3", "userdata");
        yield* fs.makeDirectory(old, { recursive: true });
        const sentinel = path.join(old, "settings.json");
        yield* fs.writeFileString(sentinel, "upstream remains intact");
        const runtime = path.join(home, ".goat", "runtime", "goat", "versions", archiveVersion);
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(
          path.join(runtime, "goat"),
          "#!/bin/sh\nprintf 'goat-ready\\n'\n",
        );
        yield* fs.chmod(path.join(runtime, "goat"), 0o700);
        yield* fs.writeFileString(path.join(runtime, ".install-complete"), archiveVersion);
        const scripts = yield* nativeScripts({ archiveVersion });
        const runner = path.join(home, "runner.sh");
        yield* fs.writeFileString(runner, scripts.runner);
        const result = yield* runShell(home, [
          "-c",
          'export T3CODE_HOME="$HOME/.t3"; exec sh "$1" --version',
          "identity",
          runner,
        ]);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, "goat-ready\n");
        assert.equal(yield* fs.readFileString(sentinel), "upstream remains intact");
        assert.isFalse(yield* fs.exists(path.join(home, ".t3", "runtime")));
        assert.isFalse(yield* fs.exists(path.join(home, ".t3", "ssh-launch")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // A fake "executable" that answers --version, packed the way the release
  // workflow packs the real archive: one top-level directory named after the
  // stem, checksummed in SHA256SUMS.
  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `goat-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\nif [ "$1" = --version ]; then echo goat v${archiveVersion}; else exit 2; fi\\n' > '${stage}/goat'`,
      `chmod +x '${stage}/goat'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make(remoteShell, ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)(
    "uploads GOAT beside same-version upstream and repairs a marker-only cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const markerOnly of [false, true]) {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-collision-" });
          yield* makeMirror(root);
          const platform = hostPlatform === "darwin" ? "darwin" : "linux";
          const arch = hostArch === "arm64" ? "arm64" : "x64";
          const bytes = yield* fs.readFile(
            `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`,
          );
          const checksum = (yield* fs.readFileString(
            `${root}/mirror/v${archiveVersion}/SHA256SUMS`,
          )).slice(0, 64);
          const upstream = `${root}/.t3/runtime/versions/${archiveVersion}`;
          yield* fs.makeDirectory(upstream, { recursive: true });
          yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
          yield* fs.writeFileString(`${upstream}/.install-complete`, archiveVersion);
          const runtime = `${root}/.goat/runtime/goat/versions/${archiveVersion}`;
          if (markerOnly) {
            yield* fs.makeDirectory(runtime, { recursive: true });
            yield* fs.writeFileString(`${runtime}/.install-complete`, archiveVersion);
          }
          const probe = yield* runShell(root, [
            "-c",
            SshTunnel.buildRemoteRuntimeProbeScript(archiveVersion),
          ]);
          assert.equal(probe.exitCode, 0, probe.stderr);
          assert.equal(JSON.parse(probe.stdout).ready, false);
          const result = yield* runUpload(
            root,
            SshTunnel.buildRemoteUploadScript(ARCHIVE, checksum),
            bytes,
          );
          assert.equal(result.exitCode, 0, result.stderr);
          assert.isTrue(yield* fs.exists(`${runtime}/goat`));
          assert.equal(
            (yield* fs.readFileString(`${runtime}/.install-complete`)).trim(),
            archiveVersion,
          );
          assert.equal(yield* fs.readFileString(`${upstream}/t3`), "#!/bin/sh\nexit 97\n");
          assert.equal(yield* fs.readFileString(`${upstream}/.install-complete`), archiveVersion);
          const after = yield* runShell(root, [
            "-c",
            SshTunnel.buildRemoteRuntimeProbeScript(archiveVersion),
          ]);
          assert.equal(after.exitCode, 0, after.stderr);
          assert.equal(JSON.parse(after.stdout).ready, true);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("fails on an uploaded archive checksum mismatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-upload-bad-" });
      yield* makeMirror(root);
      const platform = hostPlatform === "darwin" ? "darwin" : "linux";
      const arch = hostArch === "arm64" ? "arm64" : "x64";
      const bytes = yield* fs.readFile(
        `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`,
      );
      const result = yield* runUpload(
        root,
        SshTunnel.buildRemoteUploadScript(
          { ...ARCHIVE, releaseBaseUrl: "file:///unavailable" },
          "0".repeat(64),
        ),
        bytes,
      );
      assert.equal(result.exitCode, 1);
      assert.include(result.stderr, "Checksum mismatch");
      assert.isFalse(
        yield* fs.exists(`${root}/.goat/runtime/goat/versions/${archiveVersion}/.install-complete`),
      );
      assert.deepEqual(
        yield* fs.readDirectory(`${root}/.goat/runtime/goat/versions`),
        versionEntries(),
      );
      assert.notInclude(result.stderr, "curl");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("installs once when two uploads race", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-upload-race-" });
      yield* makeMirror(root);
      const platform = hostPlatform === "darwin" ? "darwin" : "linux";
      const arch = hostArch === "arm64" ? "arm64" : "x64";
      const file = `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`;
      const bytes = yield* fs.readFile(file);
      const checksums = yield* fs.readFileString(`${root}/mirror/v${archiveVersion}/SHA256SUMS`);
      const script = SshTunnel.buildRemoteUploadScript(
        { ...ARCHIVE, releaseBaseUrl: "file:///unavailable" },
        checksums.slice(0, 64),
      );
      const results = yield* Effect.all(
        [runUpload(root, script, bytes), runUpload(root, script, bytes)],
        { concurrency: "unbounded" },
      );
      for (const result of results) {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.include(result.stdout, `goat v${archiveVersion}`);
      }
      const versions = `${root}/.goat/runtime/goat/versions`;
      assert.deepEqual(yield* fs.readDirectory(versions), versionEntries(archiveVersion));
      assert.equal(
        (yield* fs.readFileString(`${versions}/${archiveVersion}/.install-complete`)).trim(),
        archiveVersion,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "installs once when several launches race, and reclaims stale locks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });

        const results = yield* Effect.all(
          [runRunner(home, runner), runRunner(home, runner), runRunner(home, runner)],
          { concurrency: "unbounded" },
        );
        for (const result of results) {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `goat v${archiveVersion}`);
        }
        const versionsDir = `${home}/.goat/runtime/goat/versions`;
        assert.deepEqual(yield* fs.readDirectory(versionsDir), versionEntries(archiveVersion));
        assert.equal(
          (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
          archiveVersion,
        );

        // A lock left by a crashed installer (dead pid) must not block the
        // next launch, and neither must one that never published a pid.
        const lock = `${versionsDir}/.${archiveVersion}.install.lock`;
        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        yield* fs.writeFileString(`${lock}/pid`, "999999\n");
        const afterDead = yield* runRunner(home, runner);
        assert.equal(afterDead.exitCode, 0, afterDead.stderr);

        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        const bin = `${root}/bin`;
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(
          `${bin}/sleep`,
          '#!/bin/sh\necho x >> "$(dirname "$0")/sleep-calls"\n',
        );
        yield* fs.chmod(`${bin}/sleep`, 0o700);
        const afterUnowned = yield* runRunner(home, runner, bin);
        assert.equal(afterUnowned.exitCode, 0, afterUnowned.stderr);
        assert.isFalse(yield* fs.exists(lock));
        assert.equal((yield* fs.readFileString(`${bin}/sleep-calls`)).trim().split("\n").length, 4);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  describe.skipIf(windowsHost)("lock waits", () => {
    it.effect.each([
      "a dead owner's lock it cannot empty",
      "a candidate it cannot publish",
    ] as const)("waits out %s instead of spinning", (blocker) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-lock-stuck-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const home = `${root}/home`;
        const lock = `${home}/.goat/runtime/goat/versions/.${archiveVersion}.install.lock`;
        const bin = `${root}/bin`;
        const runner = `${root}/runner.sh`;
        yield* fs.makeDirectory(bin);
        if (blocker === "a candidate it cannot publish") {
          // No lock exists, but every publication fails.
          yield* fs.makeDirectory(`${home}/.goat/runtime/goat/versions`, { recursive: true });
          yield* fs.writeFileString(`${bin}/mv`, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
        } else {
          // A find that cannot delete leaves the stale lock in place, whatever
          // the test user's permissions.
          yield* fs.makeDirectory(lock, { recursive: true });
          yield* fs.writeFileString(`${lock}/pid`, "999999\n");
          yield* fs.writeFileString(`${bin}/find`, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
        }
        yield* fs.writeFileString(
          `${bin}/sleep`,
          '#!/bin/sh\necho x >> "$(dirname "$0")/sleep-calls"\n',
          { mode: 0o700 },
        );
        const script = SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion, releaseBaseUrl });
        assert.include(script, 'if [ "$GOAT_LOCK_WAITED" -ge 360 ]; then');
        yield* fs.writeFileString(runner, script.replace("-ge 360 ]", "-ge 3 ]"));
        const result = yield* runRunner(home, runner, bin);
        assert.equal(result.exitCode, 1);
        assert.include(result.stderr, "has held");
        // Each failed attempt still sleeps and counts toward the timeout.
        assert.equal((yield* fs.readFileString(`${bin}/sleep-calls`)).trim().split("\n").length, 3);
        if (blocker === "a candidate it cannot publish") assert.isFalse(yield* fs.exists(lock));
        else assert.equal((yield* fs.readFileString(`${lock}/pid`)).trim(), "999999");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  });

  describe.skipIf(windowsHost)("lock reclaim interleavings", () => {
    it.effect.each(["pid write", "move"] as const)(
      "retries when its candidate disappears before the %s",
      (step) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-lock-publication-" });
          const releaseBaseUrl = yield* makeMirror(root);
          const home = `${root}/home`;
          const bin = `${root}/bin`;
          const runner = `${root}/runner.sh`;
          yield* fs.makeDirectory(home);
          yield* fs.makeDirectory(bin);
          yield* fs.writeFileString(
            runner,
            SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion, releaseBaseUrl }),
          );
          const mktempPath = yield* runShell(home, ["-c", "command -v mktemp"]);
          assert.equal(mktempPath.exitCode, 0, mktempPath.stderr);
          yield* fs.writeFileString(
            `${bin}/mktemp`,
            `#!/bin/sh
candidate=$('${mktempPath.stdout.trim()}' "$@") || exit 1
case "$candidate" in
  *.install.lock.candidate-*)
    echo attempt >> '${root}/attempts'
    if [ '${step}' = 'pid write' ] && mkdir '${root}/removed' 2>/dev/null; then
      /bin/rm -rf "$candidate"
    fi ;;
esac
printf '%s\\n' "$candidate"
`,
            { mode: 0o700 },
          );
          if (step === "move") {
            yield* fs.writeFileString(
              `${bin}/mv`,
              `#!/bin/sh
case "$1" in
  *.install.lock.candidate-*)
    if mkdir '${root}/removed' 2>/dev/null; then /bin/rm -rf "$1"; fi ;;
esac
exec /bin/mv "$@"
`,
              { mode: 0o700 },
            );
          }
          const result = yield* runRunner(home, runner, bin);
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(result.stderr, "");
          assert.equal(result.stdout, `goat v${archiveVersion}\n`);
          assert.equal((yield* fs.readFileString(`${root}/attempts`)).trim().split("\n").length, 2);
          assert.deepEqual(
            yield* fs.readDirectory(`${home}/.goat/runtime/goat/versions`),
            versionEntries(archiveVersion),
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.effect.each(["dead", "unowned"] as const)(
      "a delayed %s reclaimer cannot remove a newer installer's lock",
      (owner) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-lock-interleaving-" });
          const releaseBaseUrl = yield* makeMirror(root);
          const home = `${root}/home`;
          const versions = `${home}/.goat/runtime/goat/versions`;
          const lock = `${versions}/.${archiveVersion}.install.lock`;
          const bin = `${root}/bin`;
          const gates = `${root}/gates`;
          const runner = `${root}/runner.sh`;
          yield* fs.makeDirectory(lock, { recursive: true });
          yield* fs.makeDirectory(bin);
          yield* fs.makeDirectory(gates);
          if (owner === "dead") yield* fs.writeFileString(`${lock}/pid`, "999999\n");
          else yield* fs.writeFileString(`${lock}/pid.tmp`, "interrupted publication\n");
          yield* fs.writeFileString(
            runner,
            SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion, releaseBaseUrl }),
          );
          // FIFOs put B after its stale read, A inside the download with its live
          // lock, then B after cleanup. No scheduler speed or elapsed time is an oracle.
          const curlPath = yield* runShell(home, ["-c", "command -v curl"]);
          assert.equal(curlPath.exitCode, 0, curlPath.stderr);
          const wrappers = {
            cat: `#!/bin/sh
case "$1" in
  pid|*/pid)
    if [ "$T3_RACE_ROLE" = B ] && [ ! -f '${gates}/read-done' ]; then
      value=$(/bin/cat "$@" 2>/dev/null) || value=
      echo x >> '${gates}/reads'
      count=$(wc -l < '${gates}/reads')
      if [ "$count" -ge ${owner === "dead" ? 1 : 5} ]; then
        : > '${gates}/read-done'
        echo ready > '${gates}/read'
        read -r gate < '${gates}/resume'
      fi
      printf '%s\\n' "$value"
      exit 0
    fi ;;
esac
exec /bin/cat "$@"
`,
            curl: `#!/bin/sh
if [ "$T3_RACE_ROLE" = A ] && mkdir '${gates}/downloading' 2>/dev/null; then
  /bin/cat '${lock}/pid' > '${gates}/live-pid'
  echo ready > '${gates}/download'
  read -r gate < '${gates}/continue'
fi
echo fetch >> '${gates}/fetches'
exec '${curlPath.stdout.trim()}' "$@"
`,
            sleep: `#!/bin/sh
if [ "$T3_RACE_ROLE" = B ] && [ -f '${gates}/read-done' ] && [ ! -f '${gates}/finished' ]; then
  read -r gate < '${gates}/finish'
fi
`,
          };
          for (const command of ["rm", "rmdir"] as const) {
            // rm catches the old destructive protocol; rmdir catches the new one.
            const script = `#!/bin/sh
/bin/${command} "$@"
status=$?
case "$*" in
  *'${lock}')
    if [ "$T3_RACE_ROLE" = B ] && [ -f '${gates}/read-done' ] && mkdir '${gates}/cleaned' 2>/dev/null; then
      if cmp -s '${lock}/pid' '${gates}/live-pid'; then echo intact > '${gates}/lock-state';
      else echo lost > '${gates}/lock-state'; fi
      echo ready > '${gates}/cleanup'
      read -r gate < '${gates}/finish'
    fi ;;
esac
exit "$status"
`;
            yield* fs.writeFileString(`${bin}/${command}`, script, { mode: 0o700 });
          }
          for (const [command, script] of Object.entries(wrappers)) {
            yield* fs.writeFileString(`${bin}/${command}`, script, { mode: 0o700 });
          }
          const result = yield* runShell(
            home,
            [
              "-c",
              `set -eu
mkfifo '${gates}/read' '${gates}/resume' '${gates}/download' '${gates}/continue' '${gates}/cleanup' '${gates}/finish'
T3_RACE_ROLE=B ${remoteShellCommand} '${runner}' --version > '${gates}/B.out' 2> '${gates}/B.err' &
b=$!
read -r gate < '${gates}/read'
T3_RACE_ROLE=A ${remoteShellCommand} '${runner}' --version > '${gates}/A.out' 2> '${gates}/A.err' &
a=$!
read -r gate < '${gates}/download'
echo go > '${gates}/resume'
read -r gate < '${gates}/cleanup'
echo go > '${gates}/continue'
wait "$a"
: > '${gates}/finished'
echo go > '${gates}/finish'
wait "$b"
`,
            ],
            undefined,
            bin,
          );
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal((yield* fs.readFileString(`${gates}/lock-state`)).trim(), "intact");
          assert.equal((yield* fs.readFileString(`${gates}/fetches`)).trim().split("\n").length, 2);
          for (const role of ["A", "B"]) {
            assert.equal(yield* fs.readFileString(`${gates}/${role}.err`), "");
            assert.equal(
              yield* fs.readFileString(`${gates}/${role}.out`),
              `goat v${archiveVersion}\n`,
            );
          }
          assert.deepEqual(yield* fs.readDirectory(versions), versionEntries(archiveVersion));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "install before runner switch",
  () => {
    it.live.each([
      "launch",
      "mcp",
      "corrupt-bundle",
      "candidate-version",
      "upload-failure",
      "cache-write-failure",
      "retained-bundle-bypass",
    ] as const)("public bundle %s preserves the install-before-switch boundary", (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture("none", {
          seed: mode !== "mcp",
          compatible: mode === "retained-bundle-bypass",
        });
        const before = yield* f.snapshot;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const bundle = `${f.home}/packaged resources/ssh-runtime/archives`;
        const asset = `goat-${nextVersion}-${platform}-${arch}.tar.gz`;
        const source = `${f.home}/mirror/v${nextVersion}/${asset}`;
        if (mode === "candidate-version") {
          const binary = `${f.home}/stage/${asset.slice(0, -7)}/goat`;
          const script = (yield* f.fs.readFileString(binary)).replace(
            'console.log("goat v" + version);',
            `
const counter = path.join(fixture, "candidate-versions");
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
console.log("goat v" + (count === 0 ? version : "9.9.9"));`,
          );
          yield* f.fs.writeFileString(binary, script);
          const tar = yield* realSpawner.spawn(
            ChildProcess.make("tar", ["-czf", source, "-C", `${f.home}/stage`, asset.slice(0, -7)]),
          );
          assert.equal(Number(yield* tar.exitCode), 0);
        }
        const bytes = yield* f.fs.readFile(source);
        const crypto = yield* Crypto.Crypto;
        const hash = Hex.encode(yield* crypto.digest("SHA-256", bytes));
        yield* f.fs.makeDirectory(bundle, { recursive: true });
        yield* f.fs.writeFile(`${bundle}/${asset}`, bytes);
        const checksum = `${mode === "corrupt-bundle" || mode === "retained-bundle-bypass" ? "0".repeat(64) : hash}  ${asset}
`;
        yield* f.fs.writeFileString(`${bundle}/${asset}.sha256`, checksum);
        let downloads = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
            if (command.command === "gh") {
              downloads++;
              return makeSuccessfulProcess("");
            }
            if (
              mode === "upload-failure" &&
              command.args.some((arg) => arg.includes("GOAT_SSH_UPLOADED_ARCHIVE"))
            )
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(43)),
              };
            const index = command.args.indexOf("sh");
            assert.isAtLeast(index, 0);
            const args = command.args.slice(index);
            return yield* realSpawner.spawn(
              ChildProcess.make(
                remoteShell,
                command.args.includes("-c")
                  ? ["-c", [remoteShellCommand, ...args.slice(1)].join(" ")]
                  : args.slice(1).filter((arg) => arg !== "-l"),
                {
                  env: {
                    HOME: f.home,
                    PATH: `${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`,
                  },
                  extendEnv: false,
                  stdin: command.options.stdin,
                },
              ),
            );
          }),
        );
        const runner = {
          ...ARCHIVE,
          bundledArchiveDirectory: bundle,
          ...(mode === "cache-write-failure"
            ? { archiveDirectory: `${f.home}/cache-parent-file/cache` }
            : {}),
          keepExistingRunner: mode === "retained-bundle-bypass",
        };
        if (mode === "cache-write-failure") {
          yield* f.fs.remove(`${bundle}/${asset}`);
          yield* f.fs.writeFileString(
            `${f.home}/cache-parent-file`,
            "cannot create a cache below a file",
          );
        }
        const invocation =
          mode === "mcp" || mode === "retained-bundle-bypass"
            ? SshTunnel.issueRemoteMcpClientSession(
                uploadTarget,
                { label: "fixture", ttl: "1h", runtimeModeCeiling: null },
                {},
                runner,
              ).pipe(Effect.map((session) => ({ token: session.token, remotePort: 0 })))
            : SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner).pipe(
                Effect.map((server) => {
                  if (server.status !== "ready") throw new Error("Expected a ready runtime");
                  return { token: "", remotePort: server.remotePort };
                }),
              );
        const result = yield* Effect.result(
          invocation.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        );
        const failure =
          mode === "corrupt-bundle" ||
          mode === "candidate-version" ||
          mode === "upload-failure" ||
          mode === "cache-write-failure";
        assert.equal(Result.isFailure(result), failure);
        if (failure || mode === "retained-bundle-bypass") {
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
        } else if (Result.isSuccess(result)) {
          if (mode === "mcp") assert.equal(result.success.token, "fixture-session");
          else {
            assert.isAbove(result.success.remotePort, 0);
            assert.equal(Number(yield* f.oldProcess!.exitCode), 0);
          }
          assert.equal(
            (yield* f.fs.readFileString(
              `${f.home}/.goat/runtime/goat/versions/${nextVersion}/.install-complete`,
            )).trim(),
            nextVersion,
          );
        }
        yield* f.cleanCandidates;
        assert.equal(downloads, 0);
        assert.equal(yield* f.fs.readFileString(`${bundle}/${asset}.sha256`), checksum);
        if (mode !== "cache-write-failure")
          assert.deepEqual(yield* f.fs.readFile(`${bundle}/${asset}`), bytes);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a nested auth runner publishes the real shell PID as install-lock owner", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none", { seed: false });
        const bin = `${f.home}/.test/bin`;
        const observed = `${f.home}/.test/lock-owners.jsonl`;
        yield* f.fs.makeDirectory(bin, { recursive: true });
        yield* f.fs.writeFileString(observed, "");
        yield* f.fs.writeFileString(
          `${bin}/curl`,
          `#!${process.execPath}
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const home = process.env.HOME;
const lock = home + "/.goat/runtime/goat/versions/.${nextVersion}.install.lock";
const owner = fs.readFileSync(lock + "/pid", "utf8").trim();
let alive = false;
try { process.kill(Number(owner), 0); alive = true; } catch {}
fs.appendFileSync(home + "/.test/lock-owners.jsonl",
  JSON.stringify({ owner, shellPid: process.ppid, alive }) + "\\n");
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith("file://"));
const output = args[args.indexOf("-o") + 1];
fs.copyFileSync(fileURLToPath(url), output);
`,
        );
        yield* f.fs.chmod(`${bin}/curl`, 0o700);
        const result = yield* shell(
          f.home,
          f.scripts.pairing,
          [],
          `${bin}:${process.env.PATH ?? ""}`,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
        const records = (yield* f.fs.readFileString(observed))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { owner: string; shellPid: number; alive: boolean });
        assert.equal(records.length, 2); // checksum and archive downloads
        for (const record of records) {
          assert.match(record.owner, /^[1-9][0-9]*$/);
          assert.equal(Number(record.owner), record.shellPid);
          assert.isTrue(record.alive);
        }
        assert.equal(records[0]!.owner, records[1]!.owner);
        assert.isFalse(
          yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/.${nextVersion}.install.lock`),
        );
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a Node dev runner succeeds without matching an archive version", () =>
      Effect.gen(function* () {
        const f = yield* fixture("missing-release", { seed: false });
        const devScript = `${f.home}/.test/dev.mjs`;
        yield* f.fs.writeFileString(
          devScript,
          `
if (process.argv[2] === "--version") console.log("dev build without archive version");
else if (process.argv[2] === "__ssh-helper" && process.argv[3] === "protocol") console.log(process.argv.includes("--runtime-file") ? "none unknown unknown unknown 0 0" : "1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0");
else if (process.argv[2] === "auth") console.log(JSON.stringify({ credential: "dev-pairing" }));
else process.exit(2);
`,
        );
        // Even if the input carries an archive version, nodeScriptPath selects dev mode.
        const generated = yield* nativeScripts({ ...ARCHIVE, nodeScriptPath: devScript });
        const result = yield* shell(f.home, generated.pairing);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).credential, "dev-pairing");
        assert.include(yield* f.fs.readFileString(`${f.state}/run-t3.sh`), devScript);
        assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe("bundled runtime acquisition", () => {
  it.live.each([
    "bundle",
    "cache",
    "gh",
    "ready",
    "retained",
    "corrupt",
    "missing-sidecar",
    "wrong-executable",
    "bundle-only",
    "wrong-bundle-version",
    "wrong-bundle-platform",
    "no-cache",
    "same-cache",
    "blank-bundle",
  ] as const)(
    "%s installs or preserves the selected runtime without writing bundle bytes",
    (mode) =>
      Effect.gen(function* () {
        if (HostProcess.Platform.defaultValue() === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bundle-behavior-" });
        const home = `${root}/remote-home`;
        const bundle = `${root}/packaged resources/ssh-runtime/archives`;
        const cache = `${root}/cache`;
        const asset = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`;
        const executable = (version: string, origin: string) =>
          `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf 'goat v${version}\\n'\nelif [ "$1" = "__ssh-helper" ] && [ "$2" = "protocol" ]; then\n  case " $* " in *" --runtime-file "*) printf 'none unknown unknown unknown 0 0\\n';; *) printf '${version} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0\\n';; esac\nelif [ "$1" = "auth" ] && [ "$2" = "pairing" ]; then\n  printf '{"credential":"${origin}-pairing"}\\n'\nelse\n  exit 64\nfi\n`;
        const makeArchive = (directory: string, origin: string) =>
          Effect.gen(function* () {
            const stem = asset.slice(0, -7);
            const content = `${root}/${origin}-content/${stem}`;
            yield* fs.makeDirectory(content, { recursive: true });
            yield* fs.makeDirectory(directory, { recursive: true });
            const executableVersion =
              mode === "wrong-executable" && origin === "bundle" ? "1.2.2" : ARCHIVE.archiveVersion;
            yield* fs.writeFileString(`${content}/goat`, executable(executableVersion, origin));
            yield* fs.chmod(`${content}/goat`, 0o700);
            yield* fs.writeFileString(`${content}/origin`, origin);
            const tar = yield* realSpawner.spawn(
              ChildProcess.make("tar", [
                "-czf",
                `${directory}/${asset}`,
                "-C",
                `${root}/${origin}-content`,
                stem,
              ]),
            );
            assert.equal(Number(yield* tar.exitCode), 0);
            const bytes = yield* fs.readFile(`${directory}/${asset}`);
            const hash = Hex.encode(yield* crypto.digest("SHA-256", bytes));
            yield* fs.writeFileString(`${directory}/${asset}.sha256`, `${hash}  ${asset}\n`);
            return { bytes, hash };
          });
        yield* fs.makeDirectory(home, { recursive: true });
        const fromBundle = yield* makeArchive(bundle, "bundle");
        const fromCache = yield* makeArchive(cache, "cache");
        const fromGh = yield* makeArchive(`${root}/gh-source`, "gh");
        if (mode === "corrupt" || mode === "ready" || mode === "retained")
          yield* fs.writeFileString(`${bundle}/${asset}.sha256`, `${"0".repeat(64)}  ${asset}\n`);
        if (mode === "missing-sidecar") yield* fs.remove(`${bundle}/${asset}.sha256`);
        if (mode === "wrong-bundle-version" || mode === "wrong-bundle-platform") {
          yield* fs.rename(
            `${bundle}/${asset}`,
            `${bundle}/${mode === "wrong-bundle-version" ? "goat-9.9.9-" + platform + "-" + arch : "goat-" + ARCHIVE.archiveVersion + "-other-platform"}.tar.gz`,
          );
        }
        if (mode === "cache" || mode === "gh" || mode === "no-cache" || mode === "same-cache")
          yield* fs.remove(`${bundle}/${asset}`);
        if (mode === "gh") yield* fs.remove(`${cache}/${asset}`);
        const bundleBefore = yield* fs.readDirectory(bundle);
        const bundleArchiveBefore = (yield* fs.exists(`${bundle}/${asset}`))
          ? yield* fs.readFile(`${bundle}/${asset}`)
          : null;
        const stateKey = REMOTE_RUNTIME_STATE_KEY;
        const retainedVersion = "1.2.2-preview.20260910.1";
        const installedVersion = mode === "retained" ? retainedVersion : ARCHIVE.archiveVersion;
        const runtime = `${home}/.goat/runtime/goat/versions/${installedVersion}`;
        if (mode === "ready" || mode === "retained") {
          yield* fs.makeDirectory(runtime, { recursive: true });
          yield* fs.writeFileString(`${runtime}/goat`, executable(installedVersion, mode));
          yield* fs.chmod(`${runtime}/goat`, 0o700);
          yield* fs.writeFileString(`${runtime}/.install-complete`, installedVersion);
          yield* fs.writeFileString(`${runtime}/origin`, mode);
          if (mode === "retained") {
            const state = `${home}/.goat/ssh-launch/${stateKey}`;
            yield* fs.makeDirectory(state, { recursive: true });
            yield* fs.writeFileString(
              `${state}/run-t3.sh`,
              SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion: retainedVersion }),
            );
            yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
          }
        }
        const mutations: string[] = [];
        const guard = (file: string) => {
          if (file === bundle || file.startsWith(bundle + "/")) mutations.push(file);
        };
        const checkedFs = FileSystem.FileSystem.of({
          ...fs,
          writeFile: (file, bytes, options) => {
            guard(file);
            return fs.writeFile(file, bytes, options);
          },
          writeFileString: (file, text, options) => {
            guard(file);
            return fs.writeFileString(file, text, options);
          },
          makeDirectory: (file, options) => {
            guard(file);
            return fs.makeDirectory(file, options);
          },
          remove: (file, options) => {
            guard(file);
            return fs.remove(file, options);
          },
          rename: (from, to) => {
            guard(from);
            guard(to);
            return fs.rename(from, to);
          },
          chmod: (file, mode) => {
            guard(file);
            return fs.chmod(file, mode);
          },
        });
        let downloads = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.equal(command._tag, "StandardCommand");
            if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
            if (command.command === "gh") {
              downloads++;
              const destination = command.args[command.args.indexOf("--dir") + 1]!;
              assert.isFalse(destination.startsWith(bundle));
              yield* fs.writeFile(`${destination}/${asset}`, fromGh.bytes);
              yield* fs.writeFileString(`${destination}/SHA256SUMS`, `${fromGh.hash}  ${asset}\n`);
              return makeSuccessfulProcess("");
            }
            const index = command.args.indexOf("sh");
            assert.isAtLeast(index, 0);
            const remoteArgs = command.args.slice(index);
            return yield* realSpawner.spawn(
              ChildProcess.make(
                remoteShell,
                command.args.includes("-c")
                  ? ["-c", [remoteShellCommand, ...remoteArgs.slice(1)].join(" ")]
                  : ["-s"],
                {
                  env: { HOME: home, PATH: process.env.PATH ?? "" },
                  extendEnv: false,
                  stdin: command.options.stdin,
                },
              ),
            );
          }),
        );
        const runner = {
          ...ARCHIVE,
          bundledArchiveDirectory: mode === "blank-bundle" ? "  " : bundle,
          ...(mode === "bundle-only" || mode === "no-cache"
            ? {}
            : { archiveDirectory: mode === "same-cache" ? bundle + "/../archives" : cache }),
          // Bundle must also win over an explicit unusable mirror.
          ...(mode === "bundle" ? { releaseBaseUrl: "file:///unavailable" } : {}),
          keepExistingRunner: mode === "retained",
        };
        const result = yield* Effect.result(
          SshTunnel.prepareRemoteRuntime(uploadTarget, {}, runner, stateKey).pipe(
            Effect.provideService(FileSystem.FileSystem, checkedFs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        );
        const failure =
          mode === "corrupt" ||
          mode === "missing-sidecar" ||
          mode === "wrong-executable" ||
          mode === "no-cache" ||
          mode === "same-cache";
        assert.equal(Result.isFailure(result), failure);
        if (failure) {
          assert.isFalse(yield* fs.exists(`${runtime}/.install-complete`));
          assert.isFalse(yield* fs.exists(`${home}/.goat/ssh-launch/${stateKey}/run-t3.sh`));
        } else {
          const expected =
            mode === "bundle-only"
              ? "bundle"
              : mode === "wrong-bundle-version" ||
                  mode === "wrong-bundle-platform" ||
                  mode === "blank-bundle"
                ? "cache"
                : mode;
          assert.equal(yield* fs.readFileString(`${runtime}/origin`), expected);
          assert.equal(
            (yield* fs.readFileString(`${runtime}/.install-complete`)).trim(),
            installedVersion,
          );
          const runnerFile = `${home}/.goat/ssh-launch/${stateKey}/run-t3.sh`;
          const retainedBefore = mode === "retained" ? yield* fs.readFileString(runnerFile) : null;
          if (mode !== "retained") assert.isFalse(yield* fs.exists(runnerFile));
          // Public pairing runs prepare again, then verifies/publishes its candidate.
          const pairing = yield* SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner).pipe(
            Effect.provideService(FileSystem.FileSystem, checkedFs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          assert.equal(pairing.credential, `${expected}-pairing`);
          assert.isTrue(yield* fs.exists(runnerFile));
          if (retainedBefore !== null)
            assert.equal(yield* fs.readFileString(runnerFile), retainedBefore);
          assert.deepEqual(
            (yield* fs.readDirectory(`${home}/.goat/ssh-launch/${stateKey}`)).filter((name) =>
              name.startsWith("run-t3.next."),
            ),
            [],
          );
        }
        assert.equal(downloads, mode === "gh" ? 1 : 0);
        assert.deepEqual(mutations, []);
        assert.deepEqual(yield* fs.readDirectory(bundle), bundleBefore);
        if (bundleArchiveBefore !== null)
          assert.deepEqual(yield* fs.readFile(`${bundle}/${asset}`), bundleArchiveBefore);
        if (mode !== "gh")
          assert.deepEqual(yield* fs.readFile(`${cache}/${asset}`), fromCache.bytes);
        // Distinct tar origins prove which executable tree actually got installed.
        assert.notDeepEqual(fromBundle.bytes, fromCache.bytes);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote stop invocation ownership",
  () => {
    it.live.each([
      "archive",
      "node",
      "absolute node",
      "node path with spaces",
      "quoted entry",
      "archive other base dir",
      "node other base dir",
      "archive extra args",
      "node extra args",
      "tail node suffix",
      "runner code",
      "tail",
      "find",
      "different port",
      "port prefix",
      "missing identity",
      "missing marker",
      "empty marker",
      "external",
      "dead PID",
      "dead unmarked PID",
      "invalid port",
      "different entry",
      "invalid version",
      "version newline",
      "leading command",
      "different identity with spaced argv0",
      "different identity with multiline argv0",
    ] as const)("handles %s without signaling unrelated processes", (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-stop-" });
        // These characters must stay literal in the generated shell's case patterns.
        const home = `${root}/remote home[*?]`;
        const state = `${home}/.goat/ssh-launch/stop-fixture`;
        const bin = `${home}/.test/bin`;
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.makeDirectory(bin, { recursive: true });
        const pid = "424242";
        const port = "3773";
        const entry =
          mode === "quoted entry" ? "/repo/dev's entry.mjs" : `${home}/source entry[*?].mjs`;
        const nodeBin = `${home}/opt/node installation/bin`;
        const node = mode === "node path with spaces" ? `${nodeBin}/node` : `${bin}/node`;
        yield* fs.makeDirectory(nodeBin, { recursive: true });
        const runner = `${state}/run-t3.sh`;
        const runtime = `${home}/.goat/runtime/goat/versions/1.2.3/goat`;
        const argumentsText = `serve --host 127.0.0.1 --port ${port} --base-dir ${home}/.goat`;
        const commands: Partial<Record<typeof mode, string>> = {
          node: `node ${entry} ${argumentsText}`,
          "absolute node": `${node} ${entry} ${argumentsText}`,
          "node path with spaces": `${process.execPath} ${entry} ${argumentsText}`,
          "quoted entry": `node ${entry} ${argumentsText}`,
          tail: `tail -f ${runner}`,
          find: `find ${home}/.goat/runtime/goat/versions/1.2.3`,
          "different port": `${runtime} serve --host 127.0.0.1 --port 4773 --base-dir ${home}/.goat`,
          "port prefix": `${runtime} serve --host 127.0.0.1 --port ${port}0 --base-dir ${home}/.goat`,
          "archive other base dir": `${runtime} serve --host 127.0.0.1 --port ${port} --base-dir /other/userdata`,
          "node other base dir": `node ${entry} serve --host 127.0.0.1 --port ${port} --base-dir /other/userdata`,
          "archive extra args": `${runtime} ${argumentsText} --extra`,
          "node extra args": `node ${entry} ${argumentsText} --extra`,
          "tail node suffix": `/bin/tail -f /x/node ${entry} ${argumentsText}`,
          "runner code": `node ${entry} ${argumentsText}`,
          "different entry": `node ${entry}.backup ${argumentsText}`,
          "invalid version": `${home}/.goat/runtime/goat/versions/1.2.3 bad/goat ${argumentsText}`,
          "version newline": `${home}/.goat/runtime/goat/versions/1.2.3\nextra/goat ${argumentsText}`,
          "leading command": `tail -f ${runtime} ${argumentsText}`,
          "different identity with spaced argv0": `/opt/node path/node ${entry} ${argumentsText}`,
          "different identity with multiline argv0": `/opt/node\npath/node ${entry} ${argumentsText}`,
        };
        const command = commands[mode] ?? `${runtime} ${argumentsText}`;
        yield* fs.writeFileString(
          runner,
          mode === "runner code"
            ? "T3_NODE_SCRIPT_PATH='$(touch \"$HOME/.test/evaluated\")'\n"
            : SshTunnel.buildRemoteGoatRunnerScript({ nodeScriptPath: entry }),
        );
        if (mode !== "runner code") {
          // Stop asks the runner for activity and signals only an idle server.
          yield* fs.chmod(runner, 0o700);
          yield* fs.writeFileString(
            `${bin}/node`,
            '#!/bin/sh\ncase "$*" in *"__ssh-helper activity"*) echo idle; exit 0 ;; esac\nexit 2\n',
          );
          yield* fs.chmod(`${bin}/node`, 0o700);
        }
        const nodeIdentity = [
          "node",
          "absolute node",
          "node path with spaces",
          "quoted entry",
          "node other base dir",
          "node extra args",
          "different entry",
        ].includes(mode);
        if (mode !== "missing identity")
          yield* fs.writeFileString(
            `${state}/identity`,
            `${nodeIdentity ? entry : runtime} ${argumentsText}\n`,
          );
        yield* fs.writeFileString(`${state}/pid`, pid + "\n");
        yield* fs.writeFileString(`${state}/port`, (mode === "invalid port" ? "0" : port) + "\n");
        if (mode !== "missing marker" && mode !== "dead unmarked PID")
          yield* fs.writeFileString(
            `${state}/managed`,
            mode === "empty marker" ? "" : mode === "external" ? "external\n" : "managed\n",
          );
        yield* fs.writeFileString(`${home}/.test/command`, command + "\n");
        if (mode !== "dead PID" && mode !== "dead unmarked PID")
          yield* fs.writeFileString(`${home}/.test/alive`, pid);
        yield* fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
if [ "$1 $2 $3 $4" != '-o command= -p ${pid}' ]; then
  case "$1 $2 $3 $4" in
    '-o uid= -p ${pid}') id -u ;;
    '-o lstart= -p ${pid}') printf 'fixture-start\\n' ;;
    *) exec /bin/ps "$@" ;;
  esac
  exit 0
fi
cat "$HOME/.test/command"
`,
        );
        yield* fs.chmod(`${bin}/ps`, 0o700);
        const snapshot = Effect.forEach(
          ["pid", "port", "managed", "identity", "run-t3.sh"],
          (file) =>
            Effect.gen(function* () {
              return (yield* fs.exists(`${state}/${file}`))
                ? yield* fs.readFileString(`${state}/${file}`)
                : null;
            }),
        );
        const before = yield* snapshot;
        // Override sh's kill builtin; this test never sends an OS signal.
        const killShim = `kill() {
  if [ "$1" = -0 ]; then
    [ "$2" = ${pid} ] && [ -f "$HOME/.test/alive" ]
  else
    [ "$#" = 1 ] && [ "$1" = ${pid} ] || return 1
    printf '%s\\n' "$1" >> "$HOME/.test/killed"
    rm -f "$HOME/.test/alive"
  fi
}
`;
        const child = yield* spawner.spawn(
          ChildProcess.make(remoteShell, ["-s"], {
            env: { HOME: home, PATH: `${bin}:${nodeBin}:${process.env.PATH ?? ""}`, LC_ALL: "C" },
            extendEnv: false,
            stdin: {
              stream: Stream.make(
                encoder.encode(killShim + SshTunnel.buildRemoteStopScript("stop-fixture")),
              ),
              endOnDone: true,
            },
          }),
        );
        const result = yield* Effect.all(
          {
            code: child.exitCode.pipe(Effect.map(Number)),
            stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          },
          { concurrency: "unbounded" },
        );
        const owned = [
          "archive",
          "node",
          "absolute node",
          "node path with spaces",
          "quoted entry",
        ].includes(mode);
        assert.isFalse(yield* fs.exists(`${home}/.test/evaluated`));
        const cleanup =
          owned || mode === "external" || mode === "dead PID" || mode === "dead unmarked PID";
        assert.equal(result.code === 0, cleanup, result.stderr);
        assert.equal(yield* fs.exists(`${home}/.test/killed`), owned);
        if (owned) assert.equal(yield* fs.readFileString(`${home}/.test/killed`), pid + "\n");
        if (cleanup) {
          assert.deepEqual((yield* snapshot).slice(0, 4), [null, null, null, null]);
          assert.include(result.stdout, '{"stopped":true}');
          if (mode === "external") assert.isTrue(yield* fs.exists(`${home}/.test/alive`));
        } else {
          assert.include(result.stderr, "ownership could not be verified");
          assert.deepEqual(yield* snapshot, before);
          assert.isTrue(yield* fs.exists(`${home}/.test/alive`));
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["stale PID", "missing identity", "identity changes before drain"] as const)(
      "refuses an owned upgrade with %s despite matching protocol metadata",
      (mode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-upgrade-identity-" });
          const key = "stale-upgrade";
          const state = `${home}/.goat/ssh-launch/${key}`;
          const runtime = `${home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
          const bin = `${home}/.test/bin`;
          const record = `${home}/.goat/userdata/server-runtime.json`;
          for (const directory of [state, runtime, bin, `${home}/.goat/userdata`])
            yield* fs.makeDirectory(directory, { recursive: true });
          const pid = "424242";
          const port = "1234";
          yield* fs.writeFileString(`${state}/pid`, pid + "\n");
          yield* fs.writeFileString(`${state}/port`, port + "\n");
          yield* fs.writeFileString(`${state}/managed`, "managed\n");
          yield* fs.writeFileString(
            `${state}/run-t3.sh`,
            SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion: "1.2.2" }),
          );
          if (mode !== "missing identity")
            yield* fs.writeFileString(
              `${state}/identity`,
              `${home}/.goat/runtime/goat/versions/1.2.2/goat serve --host 127.0.0.1 --port ${port} --base-dir ${home}/.goat\n`,
            );
          const originalRunner = yield* fs.readFileString(`${state}/run-t3.sh`);
          const metadata = JSON.stringify({
            version: 1,
            startedAt: "2026-10-11T00:00:00.000Z",
            serverVersion: "1.2.2",
            sshRuntimeProtocolVersion: 99,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            pid: Number(pid),
            port: Number(port),
            origin: `http://127.0.0.1:${port}`,
          });
          yield* fs.writeFileString(record, metadata);
          // Reproduce the helper's stale-but-matching live report. Its report must never authorize a signal.
          yield* fs.writeFileString(
            `${runtime}/goat`,
            `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'goat v${ARCHIVE.archiveVersion}'; exit 0; fi
if [ "$1 $2" = '__ssh-helper compat' ]; then printf 'update-required 1 fixture-instance\\n'; exit 0; fi
if [ "$1 $2" = '__ssh-helper drain' ]; then touch "$HOME/.test/drained"; exit 2; fi
if [ "$1 $2" = '__ssh-helper compare-version' ]; then printf 'older\\n'; exit 0; fi
if [ "$1 $2" = '__ssh-helper protocol' ]; then
  case " $* " in
    *' --runtime-file '*) printf '%s\\n' 'live 1.2.2 99 ${ORCHESTRATION_PROTOCOL_VERSION} ${pid} ${port}' ;;
    *) printf '%s\\n' '${ARCHIVE.archiveVersion} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0' ;;
  esac
  exit 0
fi
exit 2
`,
          );
          yield* fs.chmod(`${runtime}/goat`, 0o700);
          yield* fs.writeFileString(`${runtime}/.install-complete`, ARCHIVE.archiveVersion + "\n");
          yield* fs.writeFileString(
            `${bin}/ps`,
            `#!/bin/sh
if [ "$1 $2 $3 $4" != '-o command= -p ${pid}' ]; then
  case "$1 $2 $3 $4" in
    '-o uid= -p ${pid}') id -u ;;
    '-o lstart= -p ${pid}') printf 'fixture-start\\n' ;;
    *) exec /bin/ps "$@" ;;
  esac
  exit 0
fi
printf 'inspected\\n' >> "$HOME/.test/inspected"
if [ '${mode}' = 'identity changes before drain' ] && [ "$(wc -l < "$HOME/.test/inspected" | tr -d ' ')" = 1 ]; then
  cat "$HOME/.goat/ssh-launch/${key}/identity"
else
  printf '%s\\n' '/bin/tail -f /unrelated/log'
fi
`,
          );
          yield* fs.chmod(`${bin}/ps`, 0o700);
          const killShim = `kill() {
  if [ "$1" = -0 ]; then [ "$2" = ${pid} ]; else
    printf '%s\\n' "$*" >> "$HOME/.test/signals"
    return 1
  fi
}
`;
          const child = yield* spawner.spawn(
            ChildProcess.make(remoteShell, ["-s", "--", key], {
              env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, LC_ALL: "C" },
              extendEnv: false,
              stdin: {
                stream: Stream.make(
                  encoder.encode(killShim + SshTunnel.buildRemoteLaunchScript(ARCHIVE)),
                ),
                endOnDone: true,
              },
            }),
          );
          const result = yield* Effect.all(
            {
              code: child.exitCode.pipe(Effect.map(Number)),
              stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            },
            { concurrency: "unbounded" },
          );
          assert.notEqual(result.code, 0);
          assert.include(
            result.stderr,
            mode === "missing identity" ? `kill ${pid}` : "ownership could not be verified",
          );
          assert.equal(result.stdout, "");
          if (mode !== "missing identity")
            assert.isAtLeast(
              (yield* fs.readFileString(`${home}/.test/inspected`)).trim().split("\n").length,
              mode === "identity changes before drain" ? 2 : 1,
            );
          assert.isFalse(yield* fs.exists(`${home}/.test/signals`));
          assert.isFalse(yield* fs.exists(`${home}/.test/drained`));
          assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), originalRunner);
          assert.equal(yield* fs.readFileString(record), metadata);
          assert.equal(yield* fs.readFileString(`${state}/pid`), pid + "\n");
          assert.equal(yield* fs.readFileString(`${state}/port`), port + "\n");
          assert.equal(yield* fs.readFileString(`${state}/managed`), "managed\n");
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too. macOS needs neither.
const MACOS_BIND_PRELOAD = `const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") return listen.apply(this, arguments);
  return listen.call(this, { port, host, reusePort: true }, callback);
};
`;

describe("remote port picker", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const linuxHost = hostPlatform === "linux";
  const windowsHost = hostPlatform === "win32";

  const holdWildcardPort = Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "0.0.0.0", reusePort: linuxHost }, () =>
        resume(Effect.succeed(server)),
      );
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  it.effect.skipIf(windowsHost)("skips a port another server answers on loopback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-pick-port-" });
      yield* fs.writeFileString(`${root}/preload.cjs`, MACOS_BIND_PRELOAD);
      yield* fs.writeFileString(`${root}/pick-port.cjs`, SshTunnel.REMOTE_PICK_PORT_SCRIPT);
      const holder = yield* holdWildcardPort;
      const heldPort = (holder.address() as NodeNet.AddressInfo).port;

      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          ...(linuxHost ? ["--require", `${root}/preload.cjs`] : []),
          `${root}/pick-port.cjs`,
          "",
          String(heldPort),
          "20",
        ]),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(exitCode, 0);
      const picked = Number(stdout);
      assert.isAbove(picked, heldPort);
      assert.isBelow(picked, heldPort + 20);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// The reconnect liveness check must reject an exited child even before its
// parent reaps it; kill -0 alone would keep treating it as a managed server.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("remote process liveness", () => {
  it.live("does not count a zombie as a running server", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const parent = yield* spawner.spawn(
        ChildProcess.make(remoteShell, ["-c", "sleep 600 & echo $!; exec sleep 600"]),
      );
      const output = yield* parent.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.mkString,
      );
      const pid = Number(output.trim());
      assert.isAbove(pid, 0);
      yield* Effect.sync(() => process.kill(pid, "SIGKILL"));
      const launch = SshTunnel.buildRemoteLaunchScript(ARCHIVE);
      const liveness = launch.match(/  # An exited, unreaped server[\s\S]*?\n  }/);
      assert.isNotNull(liveness);
      const probe = yield* spawner.spawn(
        ChildProcess.make(remoteShell, [
          "-c",
          `${liveness![0]}\nserver_alive "$1" && exit 9\nserver_alive "$2"`,
          "probe",
          String(pid),
          String(process.pid),
        ]),
      );
      assert.equal(Number(yield* probe.exitCode), 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("validated preparation attachment completion", () => {
  it.effect(
    "renews pairing on a live attachment without another preparation or phase publication",
    () =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        f.state.holdUpload = false;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const bootstrap = yield* manager.ensureEnvironment(uploadTarget);
          if ("type" in bootstrap) return yield* Effect.die("Expected a ready attachment");
          assert.isString(bootstrap.attachmentId);
          const before = { ...f.count };
          const phases: string[] = [];
          const admissions: string[] = [];
          const options = {
            preparedAttachmentId: bootstrap.attachmentId!,
            issuePairingToken: true,
            onPhase: () => phases.push("phase"),
            onPreparationProgress: () => phases.push("progress"),
            onPreparationAdmission: ({ disposition }: { disposition: string }) =>
              admissions.push(disposition),
          };
          const first = yield* manager.ensureEnvironment(uploadTarget, options);
          const second = yield* manager.ensureEnvironment(uploadTarget, options);
          if ("type" in first || "type" in second)
            return yield* Effect.die("Expected fresh credentials");
          assert.notEqual(first.pairingToken, second.pairingToken);
          assert.equal(first.attachmentId, bootstrap.attachmentId);
          assert.deepEqual(f.count, { ...before, pairings: 2 });
          assert.deepEqual(phases, []);
          assert.deepEqual(admissions, ["attachment-completion", "attachment-completion"]);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([
    "exited",
    "removed",
    "generation",
    "rotated",
    "uncertain-drain",
    "invalid-pin",
  ] as const)(
    "rejects a %s attachment neutrally and never uploads/pairs through the hint",
    (change) =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        f.state.holdUpload = false;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const bootstrap = yield* manager.ensureEnvironment(uploadTarget);
          if ("type" in bootstrap) return yield* Effect.die("Expected a ready attachment");
          switch (change) {
            case "exited":
              f.state.forwardAlive = false;
              break;
            case "removed":
              yield* manager.disconnectEnvironment(uploadTarget);
              break;
            case "generation":
              yield* manager.beginSetupOperation(uploadTarget, "successor");
              break;
            case "rotated":
              yield* manager.ensureEnvironment(uploadTarget, { refreshRuntime: true });
              break;
            case "uncertain-drain":
              f.state.launchFails = true;
              assert.isTrue(
                Result.isFailure(
                  yield* Effect.result(
                    manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
                  ),
                ),
              );
              f.state.launchFails = false;
              break;
            case "invalid-pin": {
              const fs = yield* FileSystem.FileSystem;
              const directory = `${f.root}/.ssh/goat-hosts`;
              yield* fs.makeDirectory(directory, { recursive: true });
              yield* fs.writeFileString(`${directory}/devbox.conf`, "Host devbox\n");
              yield* fs.writeFileString(`${directory}/devbox.known_hosts`, "invalid pin\n");
              break;
            }
          }
          const before = { ...f.count };
          const result = yield* Effect.result(
            manager.ensureEnvironment(uploadTarget, {
              preparedAttachmentId: bootstrap.attachmentId!,
              issuePairingToken: true,
            }),
          );
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.equal(result.failure._tag, "SshEnsureSupersededError");
          assert.equal(f.count.acquisitions, before.acquisitions);
          assert.equal(f.count.uploads, before.uploads);
          assert.equal(f.count.launches, before.launches);
          assert.equal(f.count.pairings, 0);
          if (change === "exited" || change === "removed") {
            const renewed = yield* manager.ensureEnvironment(uploadTarget);
            assert.notProperty(renewed, "type");
            assert.equal(f.count.forwards, 2);
            assert.equal(f.count.uploads, 1);
            assert.equal(f.count.kills, 1);
          }
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
