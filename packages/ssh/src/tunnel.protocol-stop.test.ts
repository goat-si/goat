import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  remoteShell,
  TEST_NODE_ENGINE_RANGE,
  testHttpClient,
  testNetService,
  ARCHIVE,
  uploadTarget,
  platform,
  arch,
} from "./tunnel.fixture.ts";
import { protocolExecutable, makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { awaitProtocolStop, synchronizeProtocolStop } from "./tunnel.protocol-stop.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live.each([
      { kind: "managed", activity: "idle", stopRuntime: "if_idle", stops: true },
      { kind: "managed", activity: "busy", stopRuntime: "if_idle", stops: false },
      { kind: "managed", activity: "unknown", stopRuntime: "if_idle", stops: false },
      { kind: "external", activity: "idle", stopRuntime: "if_idle", stops: false },
      { kind: "managed", activity: "idle", stopRuntime: "no", stops: false },
    ] as const)(
      "forget $stopRuntime preserves $kind/$activity unless owned and idle",
      ({ kind, activity, stopRuntime, stops }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind,
            stopBarrier: true,
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* synchronizeProtocolStop(f);
          yield* f.fs.writeFileString(`${f.test}/activity`, activity);
          const before = yield* f.snapshot;
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed(f.runner),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            const result = yield* manager.forgetEnvironment(uploadTarget, { stopRuntime });
            assert.equal(result.status?.state, "untrusted");
            assert.equal((yield* manager.status(uploadTarget)).status?.state, "untrusted");
          }).pipe(Effect.provide(layer), Effect.scoped);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.equal(events.includes('"type":"stop"'), stops);
          if (stops) {
            assert.equal(yield* f.fs.readFileString(`${f.test}/stop-exits`), `${f.pid}\n`);
            assert.notExists((yield* f.snapshot).pid);
          } else assert.deepEqual(yield* f.snapshot, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "cached manager auth pins its compatible release across resolver changes and rechecks both MCP attempts",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          let current = { ...f.runner, archiveVersion: String(f.runner.archiveVersion) };
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.sync(() => current),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            current = { ...f.runner, archiveVersion: "9.9.9" };
            const result = yield* manager.ensureEnvironment(uploadTarget, {
              issuePairingToken: true,
            });
            if ("type" in result) throw new Error("Expected a ready environment");
            assert.equal(result.pairingToken, "1.2.2");
            // Keep executable answers, but force both MCP attempts to ask the live server.
            const facts = `${f.home}/.goat/ssh-launch/facts`;
            const unrecordedFacts = `${f.test}/unrecorded-facts`;
            yield* f.fs.rename(facts, unrecordedFacts);
            for (const name of yield* f.fs.readDirectory(unrecordedFacts)) {
              if (name.startsWith("live.") || name.startsWith("compat."))
                yield* f.fs.remove(`${unrecordedFacts}/${name}`);
            }
            yield* f.fs.symlink(unrecordedFacts, facts);
            yield* f.fs.writeFileString(`${f.test}/reject-ceiling`, "1");
            const session = yield* manager.issueMcpClientSession(uploadTarget, {
              label: "fixture",
              ttl: "1h",
              runtimeModeCeiling: "approval-required",
            });
            assert.equal(session.token, "1.2.2");
            assert.isFalse(session.runtimeModeCeilingApplied);
            const events = (yield* f.fs.readFileString(`${f.test}/events`))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const auth = events
              .map((event, i) => ({ event, i }))
              .filter(({ event }) => event.type === "auth");
            assert.equal(auth.length, 3);
            for (const { event } of auth) assert.equal(event.version, "1.2.2");
            assert.isTrue(
              events
                .slice(auth[1]!.i + 1, auth[2]!.i)
                .some((event) => event.type === "protocol" && event.live),
            );
            yield* f.fs.remove(`${f.old}/goat`);
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.issueMcpClientSession(uploadTarget, {
                    label: "fixture",
                    ttl: "1h",
                    runtimeModeCeiling: null,
                  }),
                ),
              ),
            );
          }).pipe(Effect.provide(layer), Effect.scoped);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["goat", ".install-complete"] as const)(
      "cold-mirror manager pins the installed archive before cached auth when %s disappears",
      (missing) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 9,
            orchestration: 9,
          });
          yield* f.fs.remove(`${f.state}/run-t3.sh`);
          const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
          const mirror = `${f.home}/mirror/v${ARCHIVE.archiveVersion}`;
          yield* f.fs.makeDirectory(mirror, { recursive: true });
          yield* f.fs.writeFile(
            `${mirror}/${stem}.tar.gz`,
            yield* f.fs.readFile(`${f.home}/cache/${stem}.tar.gz`),
          );
          yield* f.fs.writeFileString(
            `${mirror}/SHA256SUMS`,
            yield* f.fs.readFileString(`${f.home}/cache/${stem}.tar.gz.sha256`),
          );
          const bin = `${f.test}/bin`;
          yield* f.fs.makeDirectory(bin);
          const curl = yield* f.realSpawner.spawn(
            ChildProcess.make(remoteShell, ["-c", "command -v curl"]),
          );
          const curlPath = (yield* curl.stdout.pipe(Stream.decodeText(), Stream.mkString)).trim();
          assert.equal(Number(yield* curl.exitCode), 0);
          yield* f.fs.writeFileString(
            `${bin}/curl`,
            `#!/bin/sh\nprintf 'download\\n' >> "$HOME/.test/downloads"\nexec ${JSON.stringify(curlPath)} "$@"\n`,
          );
          yield* f.fs.chmod(`${bin}/curl`, 0o700);
          f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          let current = {
            archiveVersion: String(ARCHIVE.archiveVersion),
            releaseBaseUrl: `file://${f.home}/mirror`,
          };
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.sync(() => current),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            const downloads = yield* f.fs.readFileString(`${f.test}/downloads`);
            assert.equal(downloads.trim().split("\n").length, 2);
            current = { ...current, archiveVersion: "9.9.9" };
            yield* f.fs.remove(
              `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/${missing}`,
            );
            const before = yield* f.snapshot;
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
                ),
              ),
            );
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.issueMcpClientSession(uploadTarget, {
                    label: "fixture",
                    ttl: "1h",
                    runtimeModeCeiling: null,
                  }),
                ),
              ),
            );
            assert.deepEqual(yield* f.snapshot, before);
            assert.equal(yield* f.fs.readFileString(`${f.test}/downloads`), downloads);
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"auth"');
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
            assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
            assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/9.9.9`));
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("disconnect reports the real stop deadline and preserves ownership until exit", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          stopBarrier: true,
        });
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
          Layer.succeed(FileSystem.FileSystem, f.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(f.runner),
            leaveRemoteServerRunning: false,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          const before = yield* f.snapshot;
          // No controller: the real process acknowledges SIGTERM but cannot exit yet.
          yield* synchronizeProtocolStop(f);
          f.setScriptPrefix("");
          const result = yield* Effect.result(manager.disconnectEnvironment(uploadTarget));
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.include(result.failure.message, `PID ${f.pid} did not stop within 2 seconds`);
            assert.include(result.failure.message, "Its ownership files were kept");
          }
          yield* awaitProtocolStop(f);
          assert.include(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          assert.deepEqual(yield* f.snapshot, before);
          yield* Effect.sync(() => process.kill(f.pid, 0));
          yield* synchronizeProtocolStop(f);
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(yield* f.fs.readFileString(`${f.test}/stop-exits`), `${f.pid}\n`);
          for (const file of ["pid", "port", "managed", "identity"])
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
        }).pipe(Effect.provide(layer), Effect.scoped);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (
        [
          "runtime command",
          "descriptor without PID identity",
          "unrelated PID",
          "unknown descriptor",
        ] as const
      ).flatMap((mode) =>
        (["disconnect", "shutdown"] as const).map((action) => ({ mode, action })),
      ),
    )("$action verifies ownership through $mode before stopping", ({ mode, action }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          stopBarrier: true,
        });
        yield* synchronizeProtocolStop(f);
        const unrelated =
          mode === "unrelated PID"
            ? yield* f.realSpawner.spawn(
                ChildProcess.make(process.execPath, [
                  "-e",
                  'require("net").createServer().listen(0, "127.0.0.1", () => console.log("ready"))',
                ]),
              )
            : undefined;
        if (unrelated !== undefined)
          assert.equal(
            yield* unrelated.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.take(1),
              Stream.mkString,
            ),
            "ready",
          );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
          Layer.succeed(FileSystem.FileSystem, f.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(f.runner),
            leaveRemoteServerRunning: false,
          }),
        );
        let before: Effect.Success<typeof f.snapshot> | undefined;
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            if (mode !== "unrelated PID") {
              const bin = `${f.test}/bin`;
              yield* f.fs.makeDirectory(bin);
              yield* f.fs.writeFileString(
                `${bin}/ps`,
                mode === "runtime command"
                  ? `#!/bin/sh\nif [ "$1 $2" != '-o command=' ]; then exec /bin/ps "$@"; fi\nprintf '%s\\n' "$HOME/.goat/runtime/goat/versions/1.2.2/goat serve --host 127.0.0.1 --port ${f.port} --base-dir $HOME/.goat"\n`
                  : "#!/bin/sh\nif [ \"$1 $2\" != '-o command=' ]; then exec /bin/ps \"$@\"; fi\nprintf 'unavailable command identity\\n'\n",
              );
              yield* f.fs.chmod(`${bin}/ps`, 0o700);
              f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
            }
            if (mode === "unknown descriptor")
              yield* f.fs.writeFileString(`${f.test}/descriptor404`, "1");
            if (unrelated !== undefined)
              yield* f.fs.writeFileString(`${f.state}/pid`, `${unrelated.pid}\n`);
            before = yield* f.snapshot;
            if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer), Effect.scoped),
        );
        const verified = mode === "runtime command";
        assert.equal(Result.isSuccess(result), verified || action === "shutdown");
        if (verified) {
          assert.equal(yield* f.fs.readFileString(`${f.test}/stop-exits`), `${f.pid}\n`);
          assert.notExists((yield* f.snapshot).pid);
          assert.include(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        } else {
          if (Result.isFailure(result))
            assert.include(result.failure.message, "ownership could not be verified");
          assert.deepEqual(yield* f.snapshot, before);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          if (unrelated !== undefined) assert.isTrue(yield* unrelated.isRunning);
          yield* Effect.sync(() => process.kill(f.pid, 0));
        }
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["disconnect", "shutdown"] as const).flatMap((action) =>
        [false, true].map((shim) => ({ action, shim })),
      ),
    )(
      "$action stops an old-entry Node server after reconnecting with a new entry; shim=$shim",
      ({ action, shim }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* synchronizeProtocolStop(f);
          const entry = `${f.home}/dev's old entry.cjs`;
          const nextEntry = `${f.home}/new entry.cjs`;
          for (const file of [entry, nextEntry])
            yield* f.fs.writeFileString(
              file,
              protocolExecutable(
                "1.2.3",
                {
                  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
                  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
                  nodeReadiness: true,
                  stopBarrier: true,
                },
                f.state,
              ),
            );
          if (shim) {
            const nodeBin = `${f.home}/.nvm/versions/node/v${process.versions.node} installation/bin`;
            yield* f.fs.makeDirectory(nodeBin, { recursive: true });
            yield* f.fs.writeFileString(
              `${nodeBin}/node`,
              `#!/bin/sh
if [ "$1" = - ] && [ "\${2:-}" = '${f.state}/port' ]; then
  printf 'pick-port\\n' >> "$HOME/.test/discovered-helpers"
  a=$1; b=$2; shift 3; set -- "$a" "$b" '${f.pickPort}' "$@"
fi
exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"
`,
            );
            yield* f.fs.chmod(`${nodeBin}/node`, 0o700);
            // This glob runs in both the runner and the launch parent's discovery.
            yield* f.fs.writeFileString(
              `${f.home}/.nvm/nvm.sh`,
              `for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
PATH="$node_bin:$PATH"
done
export PATH
`,
            );
            // The node first on PATH fails the engine check, so the runner must discover nvm's.
            // A runner image may ship a suitable /usr/bin/node, which would skip discovery.
            const unsuitableBin = `${f.home}/unsuitable-node`;
            yield* f.fs.makeDirectory(unsuitableBin);
            yield* f.fs.writeFileString(`${unsuitableBin}/node`, "#!/bin/sh\nexit 1\n");
            yield* f.fs.chmod(`${unsuitableBin}/node`, 0o700);
            f.setRemotePath(`${unsuitableBin}:/usr/bin:/bin:/usr/sbin:/sbin`);
          }
          const layer = (nodeScriptPath: string, leaveRemoteServerRunning: boolean) =>
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, f.transport),
              Layer.succeed(FileSystem.FileSystem, f.observedFs),
              Layer.succeed(HttpClient.HttpClient, testHttpClient),
              Layer.succeed(NetService.NetService, testNetService),
              SshAuth.SshPasswordPrompt.disabledLayer,
              SshTunnel.SshEnvironmentManager.layer({
                resolveCliRunner: Effect.succeed({
                  nodeScriptPath,
                  nodeEngineRange: TEST_NODE_ENGINE_RANGE,
                }),
                leaveRemoteServerRunning,
              }),
            );
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer(entry, true)), Effect.scoped);
          const pid = (yield* f.fs.readFileString(`${f.state}/pid`)).trim();
          const port = (yield* f.fs.readFileString(`${f.state}/port`)).trim();
          assert.equal(port, String(f.pickPort));
          const identity = `${entry} serve --host 127.0.0.1 --port ${port} --base-dir ${f.home}/.goat\n`;
          assert.equal(yield* f.fs.readFileString(`${f.state}/identity`), identity);
          // Read real ps: the shim execs the native binary, not its own pathname.
          const ps = yield* f.realSpawner.spawn(
            ChildProcess.make("/bin/ps", ["-o", "command=", "-p", pid]),
          );
          const command = (yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString)).trim();
          assert.equal(Number(yield* ps.exitCode), 0);
          assert.equal(command, `${shim ? process.execPath : "node"} ${identity.trim()}`);
          if (shim)
            assert.equal(yield* f.fs.readFileString(`${f.test}/discovered-helpers`), "pick-port\n");
          yield* Effect.gen(function* () {
            const manager = yield* SshTunnel.SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            assert.equal(yield* f.fs.readFileString(`${f.state}/pid`), pid + "\n");
            assert.equal(yield* f.fs.readFileString(`${f.state}/identity`), identity);
            assert.include(yield* f.fs.readFileString(`${f.state}/run-t3.sh`), nextEntry);
            if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          }).pipe(Effect.provide(layer(nextEntry, false)), Effect.scoped);
          assert.equal(yield* f.fs.readFileString(`${f.test}/stop-exits`), `${pid}\n`);
          for (const file of ["pid", "port", "managed", "identity"])
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
          assert.include(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
