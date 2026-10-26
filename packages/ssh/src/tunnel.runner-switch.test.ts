import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  makeSuccessfulProcess,
  makeRunningProcess,
  testHttpClient,
  testNetService,
  commandArgs,
  PROTOCOL_ARCHIVE,
  uploadTarget,
  platform,
  arch,
  makeProtocolTestSpawner,
  nativeScripts,
  isRemoteLaunch,
} from "./tunnel.fixture.ts";
import {
  stateKey,
  oldVersion,
  nextVersion,
  shell,
  fixture,
} from "./tunnel.runnerSwitch.fixture.ts";

const versionEntries = (...versions: string[]) =>
  platform === "linux" ? [".maintenance.lock", ...versions] : versions;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "install before runner switch",
  () => {
    it.live.each([
      { leaveRemoteServerRunning: true, action: "disconnect" },
      { leaveRemoteServerRunning: false, action: "disconnect" },
      { leaveRemoteServerRunning: true, action: "shutdown" },
      { leaveRemoteServerRunning: false, action: "shutdown" },
    ] as const)(
      "$action follows leaveRemoteServerRunning=$leaveRemoteServerRunning",
      ({ leaveRemoteServerRunning, action }) =>
        Effect.gen(function* () {
          const f = yield* fixture("none");
          const before = yield* f.snapshot;
          const remote = f.oldProcess!;
          let forwardKills = 0;
          let remoteStops = 0;
          const spawner = makeProtocolTestSpawner((command) =>
            Effect.gen(function* () {
              const args = commandArgs(command);
              if (args.includes("-G")) {
                return makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n");
              }
              if (args.includes("-N"))
                return makeRunningProcess(() => {
                  forwardKills++;
                });
              if (isRemoteLaunch(args)) {
                return makeSuccessfulProcess(
                  '{"status":"ready","selectedVersion":"1.2.3-preview.20260911.4","remotePort":3773,"serverKind":"managed"}',
                );
              }
              if (args.includes("sh")) {
                remoteStops++;
                assert.equal(forwardKills, 1); // local forward closes before remote stop
                yield* remote.kill({ killSignal: "SIGTERM" });
                assert.equal(Number(yield* remote.exitCode), 0);
                return makeSuccessfulProcess('{"stopped":true}');
              }
              return makeSuccessfulProcess("");
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
              ...(leaveRemoteServerRunning ? { leaveRemoteServerRunning: true } : {}),
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            assert.isTrue(yield* remote.isRunning);
            if (action === "disconnect") {
              yield* manager.disconnectEnvironment(uploadTarget);
              assert.equal(forwardKills, 1);
              assert.equal(remoteStops, leaveRemoteServerRunning ? 0 : 1);
              assert.equal(yield* remote.isRunning, leaveRemoteServerRunning);
              if (leaveRemoteServerRunning) {
                assert.deepEqual(yield* f.snapshot, before);
                // No cached tunnel remains: a second disconnect still cannot stop it.
                yield* manager.disconnectEnvironment(uploadTarget);
                assert.equal(remoteStops, 0);
                assert.equal(forwardKills, 1);
                assert.isTrue(yield* remote.isRunning);
              }
            }
          }).pipe(Effect.provide(layer), Effect.scoped);
          // In shutdown rows the manager finalizer performed the tested action.
          // In disconnect rows it must not perform a duplicate close/remote stop.
          assert.equal(forwardKills, 1);
          assert.equal(remoteStops, leaveRemoteServerRunning ? 0 : 1);
          assert.equal(yield* remote.isRunning, leaveRemoteServerRunning);
          if (leaveRemoteServerRunning) {
            assert.deepEqual(yield* f.snapshot, before);
            assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          } else {
            assert.equal((yield* f.events).filter((event) => event.type === "stop").length, 1);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { failure: "missing-release", publishDefault: true },
      { failure: "missing-release", publishDefault: false },
      { failure: "bad-checksum", publishDefault: true },
      { failure: "bad-checksum", publishDefault: false },
      { failure: "broken-executable", publishDefault: true },
      { failure: "broken-executable", publishDefault: false },
      { failure: "wrong-version", publishDefault: true },
      { failure: "wrong-version", publishDefault: false },
    ] as const)(
      "$failure preserves the live server (default descriptor=$publishDefault)",
      ({ failure, publishDefault }) =>
        Effect.gen(function* () {
          const f = yield* fixture(failure, { publishDefault });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, nextVersion);
          assert.include(result.stderr, "existing runner and server");
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          yield* f.cleanCandidates;
          if (failure === "wrong-version") {
            assert.include(result.stderr, `expected goat v${nextVersion}`);
            assert.include(result.stderr, `reported "goat v${oldVersion}"`);
            assert.isTrue(
              (yield* f.events).some(
                (event) =>
                  event.type === "version" && event.version === oldVersion && event.oldAlive,
              ),
            );
          } else {
            assert.isFalse(
              yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/${nextVersion}`),
            );
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "rejects a same-version wrong archive without replacing the broken-marker runtime",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-same-version-rejected-" });
          const requestedVersion = "1.2.3";
          const reportedVersion = "9.9.9";
          const state = `${home}/.goat/ssh-launch/${stateKey}`;
          const versions = `${home}/.goat/runtime/goat/versions`;
          const runtime = `${versions}/${requestedVersion}`;
          const stem = `goat-${requestedVersion}-${platform}-${arch}`;
          const stage = `${home}/stage/${stem}`;
          const release = `${home}/mirror/v${requestedVersion}`;
          for (const directory of [state, runtime, stage, release]) {
            yield* fs.makeDirectory(directory, { recursive: true });
          }
          yield* fs.writeFileString(`${runtime}/goat`, "#!/bin/sh\nprintf 'goat v1.2.3\\n'\n");
          yield* fs.chmod(`${runtime}/goat`, 0o700);
          yield* fs.writeFileString(`${runtime}/.install-complete`, "broken-marker\n");
          yield* fs.writeFileString(`${runtime}/preserved`, "existing runtime sentinel\n");
          const installed = yield* nativeScripts({ archiveVersion: requestedVersion });
          yield* fs.writeFileString(`${state}/run-t3.sh`, installed.runner + "\n");
          yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
          yield* fs.writeFileString(
            `${stage}/goat`,
            `#!/bin/sh\nprintf 'goat v${reportedVersion}\\n'\n`,
          );
          yield* fs.chmod(`${stage}/goat`, 0o700);
          const packed = yield* spawner.spawn(
            ChildProcess.make("tar", [
              "-czf",
              `${release}/${stem}.tar.gz`,
              "-C",
              `${home}/stage`,
              stem,
            ]),
          );
          assert.equal(Number(yield* packed.exitCode), 0);
          const crypto = yield* Crypto.Crypto;
          const sha256 = Hex.encode(
            yield* crypto.digest("SHA-256", yield* fs.readFile(`${release}/${stem}.tar.gz`)),
          );
          yield* fs.writeFileString(`${release}/SHA256SUMS`, `${sha256}  ${stem}.tar.gz\n`);
          const snapshot = Effect.gen(function* () {
            const values: Record<string, unknown> = {};
            for (const file of [
              `${state}/run-t3.sh`,
              `${runtime}/goat`,
              `${runtime}/.install-complete`,
              `${runtime}/preserved`,
            ]) {
              const info = yield* fs.stat(file);
              values[file] = {
                bytes: yield* fs.readFile(file),
                ino: info.ino,
                mode: info.mode,
                mtime: info.mtime,
              };
            }
            return values;
          });
          const before = yield* snapshot;
          const generated = yield* nativeScripts({
            archiveVersion: requestedVersion,
            releaseBaseUrl: `file://${home}/mirror`,
          });
          const result = yield* shell(home, generated.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.equal(result.stdout, "");
          assert.include(result.stderr, `expected goat v${requestedVersion}`);
          assert.include(result.stderr, `reported "goat v${reportedVersion}"`);
          assert.deepEqual(yield* snapshot, before);
          assert.deepEqual(yield* fs.readDirectory(versions), versionEntries(requestedVersion));
          assert.deepEqual(yield* fs.readDirectory(state), ["run-t3.sh"]);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("verifies, drains, publishes, then supervises startup on a successful upgrade", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none");
        const before = yield* f.snapshot;
        const mvPath = `${f.home}/.test/identity-bin/mv`;
        // Publication is observed after rename, using the captured old process identity.
        yield* f.fs.writeFileString(
          mvPath,
          `#!/bin/sh
/bin/mv "$@" || exit $?
if [ "$2" = '${f.state}/run-t3.sh' ]; then
  if kill -0 '${f.oldProcess!.pid}' 2>/dev/null; then observed_alive=true; else observed_alive=false; fi
  printf '{"type":"publication","oldAlive":%s}\\n' "$observed_alive" >> '${f.home}/.test/events'
fi
`,
        );
        yield* f.fs.chmod(mvPath, 0o700);
        const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        const events = yield* f.events;
        const verified = events.findIndex(
          (event) => event.type === "version" && event.version === nextVersion,
        );
        const stopped = events.findIndex(
          (event) => event.type === "self-stop" && event.version === oldVersion,
        );
        const started = events.findIndex(
          (event) => event.type === "start" && event.version === nextVersion,
        );
        const published = events.findIndex((event) => event.type === "publication");
        assert.isAtLeast(verified, 0);
        assert.isAtLeast(stopped, 0);
        assert.isAtLeast(published, 0);
        assert.isAtLeast(started, 0);
        assert.isFalse(events.some((event) => event.type === "stop"));
        assert.isTrue(events.some((event) => event.type === "drain"));
        assert.isTrue(events.some((event) => event.type === "supervise"));
        assert.include(events[verified]!.runner!, `GOAT_ARCHIVE_VERSION='${oldVersion}'`);
        assert.isTrue(events[verified]!.oldAlive);
        assert.isFalse(events[published]!.oldAlive);
        assert.isBelow(verified, published);
        assert.isBelow(stopped, published);
        assert.isBelow(verified, stopped);
        assert.isBelow(stopped, started);
        assert.include(events[started]!.installed!, `GOAT_ARCHIVE_VERSION='${nextVersion}'`);
        assert.equal(events[started]!.complete, nextVersion);
        assert.equal(Number(yield* f.oldProcess!.exitCode), 0);
        const resultJson = JSON.parse(result.stdout.trim()) as { serverKind: string };
        assert.equal(resultJson.serverKind, "managed");
        const after = yield* f.snapshot;
        for (const key of [
          "oldExecutable",
          "oldMarker",
          "oldMetadata:goat",
          "oldMetadata:.install-complete",
          "upstreamExecutable",
          "upstreamMarker",
        ])
          assert.deepEqual(after[key], before[key]);
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("identical runner retains managed PID even with its default descriptor", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none", { identical: true });
        const before = yield* f.snapshot;
        const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isTrue(yield* f.oldProcess!.isRunning);
        assert.deepEqual(
          (yield* f.events)
            .filter((event) => event.type === "start" || event.type === "stop")
            .map((event) => event.type),
          ["start"],
        );
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "keep-existing ignores a newer unavailable release and leaves the older runtime untouched",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("missing-release", { compatible: true });
          const before = yield* f.snapshot;
          const scripts = f.scripts;
          const result = yield* shell(f.home, scripts.launch, [stateKey]);
          assert.equal(result.code, 0, result.stderr);
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.version === nextVersion));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["pairing", "mcp"] as const)(
      "warm %s uses the retained runner even without a keep flag",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* fixture("missing-release", { compatible: true });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.equal(result.code, 0, result.stderr);
          if (entry === "pairing") {
            assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
          } else {
            assert.deepEqual(yield* SshTunnel.decodeRemoteMcpSessionOutput(result.stdout), {
              token: "fixture-session",
              expiresAt: null,
              runtimeModeCeilingApplied: false,
            });
          }
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.deepEqual(
            (yield* f.events)
              .filter((event) => event.type === "auth")
              .map((event) => event.version),
            [oldVersion],
          );
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["pairing", "mcp"] as const)(
      "cold %s verifies and publishes before issuing credentials",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* fixture("none", { seed: false });
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.equal(result.code, 0, result.stderr);
          if (entry === "pairing") {
            assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
          } else {
            assert.deepEqual(yield* SshTunnel.decodeRemoteMcpSessionOutput(result.stdout), {
              token: "fixture-session",
              expiresAt: null,
              runtimeModeCeilingApplied: false,
            });
          }
          const events = yield* f.events;
          const verified = events.findIndex((event) => event.type === "version");
          const issued = events.findIndex((event) => event.type === "auth");
          assert.isAtLeast(verified, 0);
          assert.isBelow(verified, issued);
          assert.include(
            yield* f.fs.readFileString(`${f.state}/run-t3.sh`),
            `GOAT_ARCHIVE_VERSION='${nextVersion}'`,
          );
          assert.equal(
            (yield* f.fs.readFileString(
              `${f.home}/.goat/runtime/goat/versions/${nextVersion}/.install-complete`,
            )).trim(),
            nextVersion,
          );
          assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { entry: "pairing", failure: "missing-release" },
      { entry: "pairing", failure: "bad-checksum" },
      { entry: "pairing", failure: "broken-executable" },
      { entry: "pairing", failure: "wrong-version" },
      { entry: "mcp", failure: "missing-release" },
      { entry: "mcp", failure: "bad-checksum" },
      { entry: "mcp", failure: "broken-executable" },
      { entry: "mcp", failure: "wrong-version" },
    ] as const)(
      "cold $entry refuses $failure without publishing or issuing credentials",
      ({ entry, failure }) =>
        Effect.gen(function* () {
          const f = yield* fixture(failure, { seed: false });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, nextVersion);
          assert.include(result.stderr, "existing runner and server");
          assert.deepEqual(yield* f.snapshot, before);
          for (const file of ["run-t3.sh", "pid", "port", "managed"]) {
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
          }
          assert.isFalse(
            (yield* f.events).some((event) => event.type === "auth" || event.type === "start"),
          );
          if (failure === "wrong-version") {
            assert.include(result.stderr, `expected goat v${nextVersion}`);
            assert.include(result.stderr, `reported "goat v${oldVersion}"`);
          } else {
            assert.isFalse(
              yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/${nextVersion}`),
            );
          }
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "TERM during candidate validation removes the candidate and preserves the old server",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("none");
          const before = yield* f.snapshot;
          const candidateRuntime = `${f.home}/.goat/runtime/goat/versions/${nextVersion}`;
          yield* f.fs.makeDirectory(candidateRuntime, { recursive: true });
          yield* f.fs.writeFileString(`${candidateRuntime}/.install-complete`, `${nextVersion}\n`);
          yield* f.fs.writeFileString(
            `${candidateRuntime}/goat`,
            `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.HOME + "/.test/events", JSON.stringify({ type: "interrupted-validation", version: ${JSON.stringify(nextVersion)} }) + "\\n");
process.kill(process.ppid, "SIGTERM");
process.exit(95);
`,
          );
          yield* f.fs.chmod(`${candidateRuntime}/goat`, 0o700);
          const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.isTrue((yield* f.events).some((event) => event.type === "interrupted-validation"));
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
