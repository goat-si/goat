// @effect-diagnostics nodeBuiltinImport:off - host identity is fixture data for POSIX lock owners.
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as NetService from "@goat/shared/Net";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ARCHIVE,
  uploadTarget,
  testHttpClient,
  testNetService,
  makeRunningProcess,
  makeSuccessfulProcess,
  installArchivePsDouble,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture, protocolExecutable } from "./tunnel.protocol.fixture.ts";
import { SshReconnectCost } from "./command.ts";
import * as SshAuth from "./auth.ts";
import {
  launchOrReuseRemoteServer,
  SshEnvironmentManager,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
} from "./tunnel.ts";

const fixture = makeProtocolFixture({
  live: true,
  kind: "managed",
  oldVersion: ARCHIVE.archiveVersion,
  commitTime: 1_700_000_000,
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  candidateSignals: {
    ssh: SSH_RUNTIME_PROTOCOL_VERSION,
    orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    commitTime: 1_700_000_000,
    drain: true,
  },
});
type Fixture = Effect.Success<typeof fixture>;
const launch = (f: Fixture, previous?: PreparedRemoteRuntime, refresh = false) =>
  launchOrReuseRemoteServer(
    uploadTarget,
    {},
    { ...f.runner, cleanupTimeoutMs: 60_000, refreshOwnedRuntimeOnFirstConnection: refresh },
    undefined,
    previous,
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
    Effect.provideService(FileSystem.FileSystem, f.observedFs),
  );

const replaceLive = (f: Fixture, compatible: boolean) =>
  Effect.gen(function* () {
    const version = "9.0.0";
    const directory = `${f.home}/.goat/runtime/goat/versions/${version}`;
    yield* f.fs.makeDirectory(directory);
    yield* f.fs.writeFileString(
      `${directory}/goat`,
      protocolExecutable(
        version,
        {
          ssh: compatible ? SSH_RUNTIME_PROTOCOL_VERSION : SSH_RUNTIME_PROTOCOL_VERSION + 1,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        },
        f.state,
      ),
    );
    yield* f.fs.chmod(`${directory}/goat`, 0o700);
    yield* f.fs.writeFileString(`${directory}/.install-complete`, version + "\n");
    const child = yield* f.realSpawner.spawn(
      ChildProcess.make(`${directory}/goat`, ["serve", "--test-seed"], {
        env: { HOME: f.home },
        extendEnv: true,
      }),
    );
    const record = JSON.parse(
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.mkString,
      ),
    ) as { pid: number; port: number };
    assert.equal(record.pid, Number(child.pid));
    yield* installArchivePsDouble(f.home, record.pid, record.port, version);
    yield* f.fs.writeFileString(`${f.state}/pid`, `${record.pid}\n`);
    yield* f.fs.writeFileString(`${f.state}/port`, `${record.port}\n`);
    yield* f.fs.writeFileString(
      `${f.state}/identity`,
      `${directory}/goat serve --host 127.0.0.1 --port ${record.port} --base-dir ${f.home}/.goat\n`,
    );
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH folded reconnect probe",
  () => {
    it.live.each(["same", "unreadable", "different"])(
      "a folded attach fences an uncertain drain for the %s instance",
      (instance) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          assert.equal(f.remoteCommands.length, 2);
          if (first.status !== "ready") return;
          const runtime = JSON.parse(
            yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
          ) as { instanceId: string };
          yield* f.fs.writeFileString(
            `${f.state}/draining`,
            instance === "same"
              ? runtime.instanceId
              : instance === "unreadable"
                ? ""
                : "previous-instance",
          );
          const before = f.remoteCommands.length;
          const result = yield* launch(f, first.selectedRuntime);
          assert.equal(result.status, instance === "different" ? "ready" : "pending");
          assert.equal(f.remoteCommands.length - before, 1);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"drain"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["busy", "unknown", "cancelled"])(
      "keeps the one-command attach and deferred intent after %s refresh",
      (reason) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(
            `${f.test}/activity`,
            reason === "cancelled" ? "idle" : reason,
          );
          if (reason === "cancelled") yield* f.fs.writeFileString(`${f.test}/drain`, reason);
          yield* f.shiftHostClock(60);
          const first = yield* launch(f, undefined, true);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.equal(first.pending?.reason, reason === "cancelled" ? "busy" : reason);
          assert.isString(first.selectedRuntime.reconnectProbe);
          // Becoming idle must not turn a transport reconnect into an early replacement.
          yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
          const snapshot = yield* f.snapshot;
          const before = f.remoteCommands.length;
          const second = yield* launch(f, first.selectedRuntime);
          assert.equal(f.remoteCommands.length - before, 1);
          assert.equal(second.status, "ready");
          if (second.status !== "ready") return;
          assert.deepEqual(second.pending, first.pending);
          assert.equal(second.selectedRuntime.version, "1.2.2");
          assert.isString(second.selectedRuntime.reconnectProbe);
          assert.deepEqual(yield* f.snapshot, snapshot);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"self-stop"');
          const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
          const owner = "other-host|0|1|old|fixture";
          yield* f.fs.symlink(owner, lock);
          const beforeContended = f.remoteCommands.length;
          const contended = yield* launch(f, second.selectedRuntime);
          assert.equal(contended.status, "pending");
          assert.equal(contended.pending?.reason, "contended");
          assert.equal(f.remoteCommands.length - beforeContended, 1);
          assert.equal(yield* f.fs.readLink(lock), owner);
          assert.deepEqual(yield* f.snapshot, snapshot);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([ARCHIVE.archiveVersion, "1.2.2"])(
      "folds probe and launch into one command and reuses host facts for %s",
      (version) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: version,
            commitTime: 1_700_000_000,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.isString(first.selectedRuntime.reconnectProbe);
          const commands = f.remoteCommands.length;
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          const readinessEvent =
            JSON.stringify({
              type: "exec",
              version,
              args: ["__ssh-helper", "wait-ready", String(first.remotePort), "60000", "1000"],
            }) + "\n";
          const reconnectEvents = f.fs.readFileString(`${f.test}/events`).pipe(
            Effect.map((current) => {
              assert.equal(current.slice(0, events.length), events);
              return current.slice(events.length);
            }),
          );
          const cost = {
            active: true,
            spawns: 0,
            authentications: 0,
            steps: {} as Record<string, number>,
          };
          const second = yield* launch(f, first.selectedRuntime).pipe(
            Effect.provideService(SshReconnectCost, cost),
          );
          assert.equal(second.status, "ready");
          assert.equal(f.remoteCommands.length - commands, 1);
          assert.equal(yield* reconnectEvents, readinessEvent);
          assert.property(cost.steps, "runtime-probe-folded");
          if (second.status !== "ready") return;
          const beforeThird = f.remoteCommands.length;
          const third = yield* launch(f, second.selectedRuntime);
          assert.equal(third.status, "ready");
          assert.equal(f.remoteCommands.length - beforeThird, 1);
          assert.equal(yield* reconnectEvents, readinessEvent + readinessEvent);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([0, 1, 60])(
      "folds the first reconnect after install using warmed facts (age %s s at cleanup)",
      (age) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
            candidateSignals: {
              ssh: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestration: ORCHESTRATION_PROTOCOL_VERSION,
              commitTime: 1_700_000_000,
              drain: true,
            },
          });
          yield* f.fs.remove(f.old, { recursive: true });
          yield* f.fs.remove(`${f.state}/run-t3.sh`);
          yield* f.shiftHostClock(age, true);
          const installed = yield* launch(f);
          assert.equal(installed.status, "ready");
          if (installed.status !== "ready") return;
          assert.isString(installed.selectedRuntime.reconnectProbe);
          assert.equal(f.counters().uploads, 1);
          const runtime = JSON.parse(
            yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
          ) as { pid: number };
          yield* installArchivePsDouble(
            f.home,
            runtime.pid,
            installed.remotePort,
            ARCHIVE.archiveVersion,
          );
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          const before = f.remoteCommands.length;
          yield* f.shiftHostClock(60, true);
          const reconnected = yield* launch(f, installed.selectedRuntime);
          assert.equal(reconnected.status, "ready");
          if (reconnected.status !== "ready") return;
          assert.equal(reconnected.remotePort, installed.remotePort);
          assert.equal(f.remoteCommands.length - before, 1);
          assert.equal(
            (yield* f.fs.readFileString(`${f.test}/events`)).slice(events.length),
            JSON.stringify({
              type: "exec",
              version: ARCHIVE.archiveVersion,
              args: ["__ssh-helper", "wait-ready", String(installed.remotePort), "60000", "1000"],
            }) + "\n",
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["readiness", "launch"] as const)(
      "propagates an unchanged selection's %s failure without a second launch",
      (failure) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          if (failure === "readiness") {
            yield* f.fs.writeFileString(
              `${f.old}/goat`,
              (yield* f.fs.readFileString(`${f.old}/goat`)).replace(
                "// Fixture readiness uses an event, not polling or a delay.",
                `if (fs.existsSync(path.join(test, "readiness-fail"))) {
  fs.appendFileSync(path.join(test, "readiness-attempts"), "failed\\n");
  process.stderr.write("fixture readiness failed\\n"); process.exit(23);
}`,
              ),
            );
          }
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.isString(first.selectedRuntime.reconnectProbe);
          if (failure === "readiness") {
            yield* f.fs.writeFileString(`${f.test}/readiness-fail`, "");
          } else {
            f.setScriptPrefix(`sh() {
  if [ "\${3:-}" = runtime ]; then
    printf 'fixture launch failed\\n' >&2; return 23
  fi
  command sh "$@"
}
`);
          }
          const before = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          assert.equal(result._tag, "Failure");
          assert.equal(f.remoteCommands.length - before, 1);
          if (failure === "readiness") {
            assert.equal(yield* f.fs.readFileString(`${f.test}/readiness-attempts`), "failed\n");
          }
          const ordinary = yield* Effect.result(launch(f));
          assert.equal(ordinary._tag, "Failure");
          if (result._tag !== "Failure" || ordinary._tag !== "Failure") return;
          assert.equal(result.failure._tag, "SshCommandError");
          assert.equal(ordinary.failure._tag, "SshCommandError");
          if (
            result.failure._tag !== "SshCommandError" ||
            ordinary.failure._tag !== "SshCommandError"
          )
            return;
          assert.equal(result.failure.exitCode, failure === "readiness" ? 1 : 23);
          assert.equal(result.failure.exitCode, ordinary.failure.exitCode);
          assert.equal(result.failure.stderr, ordinary.failure.stderr);
          assert.equal(result.failure.message, ordinary.failure.message);
          assert.equal(
            result.failure.stderr,
            failure === "readiness"
              ? "fixture readiness failed\nSelected live server did not answer; it was left running.\n"
              : "fixture launch failed\n",
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["executable", "runner", "runtime record", "identity"] as const)(
      "reprobes a changed %s and preserves ordinary launch behavior",
      (changed) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          assert.isString(first.selectedRuntime.reconnectProbe);
          if (changed === "executable") {
            yield* f.fs.writeFileString(
              `${f.old}/goat`,
              (yield* f.fs.readFileString(`${f.old}/goat`)) + "\n// rebuilt\n",
            );
          } else if (changed === "runner") {
            yield* f.fs.writeFileString(
              `${f.state}/run-t3.sh`,
              (yield* f.fs.readFileString(`${f.state}/run-t3.sh`)) + "\n# changed\n",
            );
          } else if (changed === "runtime record") {
            const file = `${f.home}/.goat/userdata/server-runtime.json`;
            yield* f.fs.writeFileString(
              file,
              (yield* f.fs.readFileString(file)).replace(
                '"startedAt":',
                '"observed":true,"startedAt":',
              ),
            );
          } else {
            yield* f.fs.remove(`${f.state}/identity`);
          }
          const commands = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          const count = f.remoteCommands.length - commands;
          const ordinary = yield* Effect.result(launch(f));
          assert.equal(count, 2);
          assert.equal(result._tag, ordinary._tag);
          if (result._tag === "Failure" && ordinary._tag === "Failure") {
            assert.equal(result.failure.message, ordinary.failure.message);
          } else if (result._tag === "Success" && ordinary._tag === "Success") {
            assert.equal(result.success.status, ordinary.success.status);
            if (result.success.status === "ready" && ordinary.success.status === "ready") {
              assert.equal(result.success.remotePort, ordinary.success.remotePort);
              assert.equal(
                result.success.selectedRuntime.version,
                ordinary.success.selectedRuntime.version,
              );
            }
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { contended: "none", revalidate: false },
      { contended: "foreign", revalidate: false },
      { contended: "live", revalidate: false },
      { contended: "none", revalidate: true },
    ] as const)(
      "a stale manager entry reconnects and creates a forward (replacement lock held=$contended, revalidate=$revalidate)",
      ({ contended, revalidate }) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          let forwardAlive = true;
          let forwards = 0;
          let measureReconnect = false;
          const transport = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (
                measureReconnect &&
                command._tag === "StandardCommand" &&
                (command.args.includes("sh") || command.args.includes("-N"))
              ) {
                yield* TestClock.adjust(2_000);
              }
              if (command._tag === "StandardCommand" && command.args.includes("-N")) {
                forwardAlive = true;
                forwards++;
                return {
                  ...makeRunningProcess(() => undefined),
                  isRunning: Effect.sync(() => forwardAlive),
                };
              }
              return yield* f.transport.spawn(command);
            }),
          );
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed(f.runner),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
            const owner =
              contended === "live"
                ? `${NodeOS.hostname()}|${process.getuid!()}|${process.pid}|${NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).replace(/\n$/, "")}|fixture`
                : "other-client|0|1|old|fixture";
            if (contended !== "none") yield* f.fs.symlink(owner, lock);
            if (contended === "live") {
              // Account for the production waits without sleeping in the test. An executable
              // double is inherited by both shells, so a repeated nested wait is observable.
              yield* f.fs.writeFileString(
                `${f.test}/identity-bin/sleep`,
                '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/.test/lock-waits"\n',
              );
              yield* f.fs.chmod(`${f.test}/identity-bin/sleep`, 0o700);
            }
            const ordinary = contended !== "none" ? yield* launch(f) : undefined;
            if (ordinary !== undefined) {
              assert.equal(ordinary.status, "ready");
              assert.isUndefined(ordinary.pending);
            }
            const snapshot = yield* f.snapshot;
            const commands = f.remoteCommands.length;
            if (contended === "live") yield* f.fs.writeFileString(`${f.test}/lock-waits`, "");
            forwardAlive = false;
            if (revalidate) yield* manager.revalidateTunnels();
            const cost = {
              active: true,
              spawns: 0,
              authentications: 0,
              steps: {} as Record<string, number>,
            };
            const workerCosts: Readonly<Record<string, unknown>>[] = [];
            const logger = Logger.make(({ fiber, message }) => {
              if (String(message) === "ssh.reconnect.cost")
                workerCosts.push(fiber.getRef(References.CurrentLogAnnotations));
            });
            const result = yield* Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis;
              measureReconnect = true;
              const result = yield* manager.ensureEnvironment(uploadTarget).pipe(
                Effect.provideService(SshReconnectCost, cost),
                Effect.provideService(References.MinimumLogLevel, "Info"),
                Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
                Effect.ensuring(
                  Effect.sync(() => {
                    measureReconnect = false;
                  }),
                ),
              );
              if (contended === "live") {
                const waits = (yield* f.fs.readFileString(`${f.test}/lock-waits`))
                  .trim()
                  .split("\n")
                  .map(Number);
                assert.deepEqual(
                  waits,
                  Array(50).fill(0.1),
                  "the folded command shares one lock wait budget",
                );
                // Charge observed remote waits and SSH commands, excluding host process startup.
                yield* TestClock.adjust(waits.reduce((ms, seconds) => ms + seconds * 1_000, 0));
                const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
                assert.isAtMost(
                  elapsedMs,
                  15_000,
                  "fits initial setup with 2 s per command latency",
                );
              }
              return result;
            }).pipe(Effect.provide(TestClock.layer()));
            assert.isFalse("type" in result);
            if ("type" in result) return;
            assert.equal(result.remotePort, f.port);
            assert.isUndefined(result.pendingReplacement);
            assert.equal(forwards, 2);
            assert.equal(f.remoteCommands.length - commands, 1);
            assert.lengthOf(workerCosts, 1);
            assert.isString(workerCosts[0]?.operationId);
            assert.property(workerCosts[0]?.steps, "runtime-probe-folded");
            assert.notProperty(cost.steps, "runtime-probe-folded");
            assert.deepEqual(yield* f.snapshot, snapshot);
            if (contended !== "none") {
              assert.equal(yield* f.fs.readLink(lock), owner);
              yield* f.fs.remove(lock);
            }
            for (const options of [{ refreshRuntime: true }, { confirmReplacement: true }]) {
              forwardAlive = false;
              const before = f.remoteCommands.length;
              yield* manager.ensureEnvironment(uploadTarget, options);
              assert.equal(f.remoteCommands.length - before, 2);
            }
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.effect(
      "wake revalidation folds a deferred refresh and preserves its original retry deadline",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
          yield* f.shiftHostClock(60);
          const retried = yield* Deferred.make<void>();
          let completed = 0;
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (at, exit) => {
                end(at, exit);
                if (options.name === "ssh/tunnel.ensureTunnelEntry" && ++completed === 3)
                  Deferred.doneUnsafe(retried, Effect.void);
              };
              return span;
            },
          });
          let alive = true;
          let forwards = 0;
          const transport = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.args.includes("-N")) {
              alive = true;
              forwards++;
              return Effect.succeed({
                ...makeRunningProcess(() => undefined),
                isRunning: Effect.sync(() => alive),
              });
            }
            return f.transport.spawn(command);
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({
                ...f.runner,
                refreshOwnedRuntimeOnFirstConnection: true,
              }),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            const first = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in first) throw new Error("Expected attached deferred refresh");
            assert.equal(first.pendingReplacement?.reason, "busy");
            yield* TestClock.adjust("9 minutes");
            const before = f.remoteCommands.length;
            alive = false;
            yield* manager.revalidateTunnels();
            yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
            const second = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in second) throw new Error("Expected reattached deferred refresh");
            assert.deepEqual(second.pendingReplacement, first.pendingReplacement);
            assert.equal(second.remoteServerVersion, "1.2.2");
            assert.equal(forwards, 2);
            assert.equal(f.remoteCommands.length - before, 1);
            yield* TestClock.adjust("1 minute");
            yield* Deferred.await(retried);
            const settled = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in settled) throw new Error("Expected authoritative refresh");
            assert.isUndefined(settled.pendingReplacement);
            assert.equal(settled.remoteServerVersion, ARCHIVE.archiveVersion);
          }).pipe(
            Effect.provide(layer),
            Effect.provideService(Tracer.Tracer, tracer),
            Effect.scoped,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.effect.each(["verified", "rejected", "uncertain drain"] as const)(
      "long-wake no-drain attachment reconnects with %s status proof",
      (proof) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.shiftHostClock(60);
          let alive = true;
          let forwards = 0;
          const transport = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.args.includes("-N")) {
              alive = true;
              forwards++;
              return Effect.succeed({
                ...makeRunningProcess(() => undefined),
                isRunning: Effect.sync(() => alive),
              });
            }
            return f.transport.spawn(command);
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({
                ...f.runner,
                refreshOwnedRuntimeOnFirstConnection: true,
              }),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            const first = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in first) throw new Error("Expected no-drain attachment");
            assert.equal(first.pendingReplacement?.refreshCause, "drain_unavailable");
            yield* TestClock.adjust("9 minutes");
            const ownership = yield* f.fs.readFileString(`${f.state}/managed`);
            if (proof === "rejected")
              yield* f.fs.writeFileString(`${f.state}/managed`, "external\n");
            if (proof === "uncertain drain") {
              f.setScriptPrefix(`sh() {
  if [ "\${3:-}" = runtime ]; then return 23; fi
  command sh "$@"
}
`);
              assert.equal(
                (yield* Effect.result(
                  manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
                ))._tag,
                "Failure",
              );
              f.setScriptPrefix("");
            }
            const status = yield* manager.status(uploadTarget);
            assert.equal(status.status?.state, proof === "verified" ? "ready" : "update_blocked");
            if (proof === "verified") {
              assert.equal(status.status?.refreshDeferred?.refreshCause, "drain_unavailable");
              yield* manager.readyEnvironment(uploadTarget);
            } else {
              assert.isUndefined(status.status?.refreshDeferred);
              assert.equal(
                (yield* Effect.result(manager.readyEnvironment(uploadTarget)))._tag,
                "Failure",
              );
            }
            if (proof === "rejected") yield* f.fs.writeFileString(`${f.state}/managed`, ownership);
            const snapshot = yield* f.snapshot;
            alive = false;
            yield* manager.revalidateTunnels();
            const before = f.remoteCommands.length;
            const second = yield* manager.ensureEnvironment(uploadTarget);
            if ("type" in second) throw new Error("Expected reattached no-drain runtime");
            assert.equal(f.remoteCommands.length - before, proof === "verified" ? 1 : 2);
            assert.equal(forwards, 2);
            assert.equal(second.remoteServerVersion, "1.2.2");
            if (proof === "verified") {
              assert.deepEqual(second.pendingReplacement, first.pendingReplacement);
              const reconnected = yield* manager.status(uploadTarget);
              assert.equal(reconnected.status?.state, "ready");
              assert.equal(reconnected.status?.refreshDeferred?.refreshCause, "drain_unavailable");
              yield* manager.readyEnvironment(uploadTarget);
            }
            assert.deepEqual(yield* f.snapshot, snapshot);
            const events = yield* f.fs.readFileString(`${f.test}/events`);
            assert.notInclude(events, '"type":"drain"');
            assert.notInclude(events, '"type":"stop"');
          }).pipe(Effect.provide(layer), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      "disconnect",
      "forget",
      "generation",
      "refresh",
      "confirmation",
      "version",
      "build",
      "config",
      "host",
      "invalidated",
      "failed refresh",
      "uncertain drain",
      "rejected attachment",
      "failed launch",
    ] as const)("does not retain wake selection after %s", (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.shiftHostClock(60);
        let forwardAlive = true;
        let configuration = "hostname devbox.example.com\nuser julius\nport 2222\n";
        let runner: RemoteGoatRunnerOptions = {
          ...f.runner,
          refreshOwnedRuntimeOnFirstConnection: true,
        };
        const transport = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand" && command.args.includes("-G"))
            return Effect.succeed(makeSuccessfulProcess(configuration));
          if (command._tag === "StandardCommand" && command.args.includes("-N")) {
            forwardAlive = true;
            return Effect.succeed({
              ...makeRunningProcess(() => undefined),
              isRunning: Effect.sync(() => forwardAlive),
            });
          }
          return f.transport.spawn(command);
        });
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
          Layer.succeed(FileSystem.FileSystem, f.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshEnvironmentManager.layer({
            resolveCliRunner: Effect.sync(() => runner),
            leaveRemoteServerRunning: true,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          const snapshot = yield* f.snapshot;
          const failLaunch = `sh() {
  if [ "\${3:-}" = runtime ]; then return 23; fi
  command sh "$@"
}
`;
          if (action === "failed refresh" || action === "uncertain drain") {
            f.setScriptPrefix(failLaunch);
            const failed = yield* Effect.result(
              manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
            );
            assert.equal(failed._tag, "Failure");
            f.setScriptPrefix("");
          }
          if (action === "rejected attachment") {
            f.setScriptPrefix(`sh() {
  if [ "\${3:-}" = runtime ]; then
    printf '%s\\n' '{"status":"pending","pending":{"reason":"busy","replacement":"incompatible","requestedVersion":"1.2.3","liveVersion":"1.2.3"}}'
    return 0
  fi
  command sh "$@"
}
`);
            const rejected = yield* manager.ensureEnvironment(uploadTarget, {
              refreshRuntime: true,
            });
            assert.isTrue("type" in rejected);
            f.setScriptPrefix("");
          }
          if (action === "uncertain drain" || action === "rejected attachment") {
            const status = yield* manager.status(uploadTarget);
            assert.equal(
              status.status?.state,
              action === "uncertain drain" ? "update_blocked" : "update_waiting",
            );
            assert.equal(
              (yield* Effect.result(manager.readyEnvironment(uploadTarget)))._tag,
              "Failure",
            );
          }
          forwardAlive = false;
          yield* manager.revalidateTunnels();
          if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          if (action === "forget")
            yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
          if (action === "generation")
            yield* manager.beginSetupOperation(uploadTarget, "wake-test");
          if (action === "version") runner = { ...f.runner, archiveVersion: "1.2.4" };
          if (action === "build") runner = { ...f.runner, archiveCommitTime: 1_700_000_001 };
          if (action === "config") configuration += "identityfile /changed-identity\n";
          if (action === "host") configuration = configuration.replace("devbox", "otherbox");
          if (action === "invalidated") {
            f.setScriptPrefix("printf 'fixture rejected probe\\n' >&2\nexit 23\n");
            const status = yield* manager.status(uploadTarget);
            assert.equal(status.kind, "error");
            f.setScriptPrefix("");
          }
          if (action === "failed launch") {
            f.setScriptPrefix(failLaunch);
            const before = f.remoteCommands.length;
            const failed = yield* Effect.result(manager.ensureEnvironment(uploadTarget));
            assert.equal(failed._tag, "Failure");
            assert.equal(f.remoteCommands.length - before, 1);
            f.setScriptPrefix("");
          }
          const before = f.remoteCommands.length;
          const result = yield* manager.ensureEnvironment(
            uploadTarget,
            action === "refresh"
              ? { refreshRuntime: true }
              : action === "confirmation"
                ? { confirmReplacement: true }
                : undefined,
          );
          assert.isFalse("type" in result);
          assert.equal(f.remoteCommands.length - before, 2);
          assert.deepEqual(yield* f.snapshot, snapshot);
          if (action === "uncertain drain" || action === "rejected attachment")
            yield* manager.readyEnvironment(uploadTarget);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("rechecks a managed pin after master setup before using captured wake proof", () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.shiftHostClock(60);
        const directory = `${f.home}/.ssh/goat-hosts`;
        const pinPath = `${directory}/devbox.known_hosts`;
        yield* f.fs.makeDirectory(directory, { recursive: true });
        yield* f.fs.writeFileString(pinPath, "devbox ssh-ed25519 AAAA\n");
        yield* f.fs.writeFileString(
          `${directory}/devbox.conf`,
          `Host devbox\n  HostName devbox.example.com\n  User julius\n  Port 2222\n  HostKeyAlias devbox\n  UserKnownHostsFile "${pinPath}"\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  UpdateHostKeys no\n  HostKeyAlgorithms ssh-ed25519\n`,
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let pause = false;
        let afterMaster = false;
        let alive = true;
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (at, exit) => {
              end(at, exit);
              if (options.name === "ssh/master.ensure") afterMaster = pause;
            };
            return span;
          },
        });
        const fs = FileSystem.FileSystem.of({
          ...f.observedFs,
          readFileString: (file) =>
            Effect.gen(function* () {
              if (file === pinPath && pause && afterMaster) {
                pause = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* f.observedFs.readFileString(file);
            }),
        });
        const transport = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand" && command.args.includes("-G"))
            return Effect.succeed(
              makeSuccessfulProcess(
                `hostname devbox.example.com\nuser julius\nport 2222\nhostkeyalias devbox\nuserknownhostsfile ${pinPath}\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\n`,
              ),
            );
          if (command._tag === "StandardCommand" && command.args.includes("-N")) {
            alive = true;
            return Effect.succeed({
              ...makeRunningProcess(() => undefined),
              isRunning: Effect.sync(() => alive),
            });
          }
          return f.transport.spawn(command);
        });
        const layer = Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: f.home })),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
          Layer.succeed(FileSystem.FileSystem, fs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(f.runner),
            leaveRemoteServerRunning: true,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          alive = false;
          yield* manager.revalidateTunnels();
          pause = true;
          afterMaster = false;
          const cost = {
            active: true,
            spawns: 0,
            authentications: 0,
            steps: {} as Record<string, number>,
          };
          const reconnect = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)).pipe(
              Effect.provideService(SshReconnectCost, cost),
            ),
          );
          yield* Deferred.await(entered);
          yield* f.fs.writeFileString(pinPath, "devbox ssh-ed25519 BBBB\n");
          const before = f.remoteCommands.length;
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(reconnect);
          assert.equal(result._tag, "Failure");
          assert.equal(f.remoteCommands.length - before, 2);
          assert.notProperty(cost.steps, "runtime-probe-folded");
          assert.equal(
            (yield* Effect.result(manager.readyEnvironment(uploadTarget)))._tag,
            "Failure",
          );
          if (result._tag === "Failure")
            assert.include(result.failure.message, "Managed SSH host key changed.");
        }).pipe(Effect.provide(layer), Effect.provideService(Tracer.Tracer, tracer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["failed refresh", "superseded ensure", "changed config"] as const)(
      "fences wake proof when a paused reconnect meets %s",
      (race) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const resolved = yield* Deferred.make<void>();
          let pause = false;
          let forwardAlive = true;
          let configuration = "hostname devbox.example.com\nuser julius\nport 2222\n";
          const logger = Logger.make(({ message }) => {
            if (
              String(message).startsWith("ssh.environment.target.resolved") &&
              configuration.includes("changed")
            )
              Deferred.doneUnsafe(resolved, Effect.void);
          });
          const transport = ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.args.includes("-G"))
              return Effect.succeed(makeSuccessfulProcess(configuration));
            if (command._tag === "StandardCommand" && command.args.includes("-N")) {
              forwardAlive = true;
              return Effect.succeed({
                ...makeRunningProcess(() => undefined),
                isRunning: Effect.gen(function* () {
                  if (pause && race === "changed config") {
                    pause = false;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  return forwardAlive;
                }),
              });
            }
            return f.transport.spawn(command);
          });
          const layer = Layer.mergeAll(
            NodeServices.layer,
            Logger.layer([logger], { mergeWithExisting: false }),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshEnvironmentManager.layer({
              resolveCliRunner: Effect.gen(function* () {
                if (pause && race !== "changed config") {
                  pause = false;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return { ...f.runner, refreshOwnedRuntimeOnFirstConnection: true };
              }),
              leaveRemoteServerRunning: true,
            }),
          );
          yield* Effect.gen(function* () {
            const manager = yield* SshEnvironmentManager;
            yield* manager.ensureEnvironment(uploadTarget);
            const snapshot = yield* f.snapshot;
            forwardAlive = false;
            if (race !== "changed config") yield* manager.revalidateTunnels();
            pause = true;
            const reconnect = yield* Effect.forkChild(
              Effect.result(manager.ensureEnvironment(uploadTarget)),
            );
            yield* Deferred.await(entered);
            let concurrent: Fiber.Fiber<void, never> | undefined;
            if (race === "failed refresh") {
              f.setScriptPrefix(`sh() {
  if [ "\${3:-}" = runtime ]; then return 23; fi
  command sh "$@"
}
`);
              const failed = yield* Effect.result(
                manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
              );
              assert.equal(failed._tag, "Failure");
              f.setScriptPrefix("");
            } else if (race === "superseded ensure") {
              yield* manager.disconnectEnvironment(uploadTarget);
              yield* manager.ensureEnvironment(uploadTarget);
            } else {
              configuration += "identityfile /changed-identity\n";
              concurrent = yield* Effect.forkChild(
                manager.ensureEnvironment(uploadTarget).pipe(Effect.asVoid, Effect.orDie),
              );
              yield* Deferred.await(resolved);
            }
            const before = f.remoteCommands.length;
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(reconnect);
            if (concurrent !== undefined) yield* Fiber.join(concurrent);
            assert.equal(result._tag, race === "superseded ensure" ? "Failure" : "Success");
            assert.equal(f.remoteCommands.length - before, race === "superseded ensure" ? 0 : 2);
            forwardAlive = false;
            yield* manager.revalidateTunnels();
            const next = f.remoteCommands.length;
            yield* manager.ensureEnvironment(uploadTarget);
            assert.equal(f.remoteCommands.length - next, 1);
            assert.deepEqual(yield* f.snapshot, snapshot);
          }).pipe(
            Effect.provide(layer),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
            Effect.scoped,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([true, false])("reprobes a newer live runtime (compatible=%s)", (compatible) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.shiftHostClock(60);
        const first = yield* launch(f);
        assert.equal(first.status, "ready");
        if (first.status !== "ready") return;
        yield* replaceLive(f, compatible);
        const before = f.remoteCommands.length;
        const result = yield* Effect.result(launch(f, first.selectedRuntime));
        assert.equal(f.remoteCommands.length - before, compatible ? 2 : 1);
        const ordinary = yield* Effect.result(launch(f));
        assert.equal(result._tag, ordinary._tag);
        if (result._tag === "Failure" && ordinary._tag === "Failure") {
          assert.equal(result.failure._tag, "SshLaunchError");
          assert.equal("reason" in result.failure && result.failure.reason, "runtime-newer");
          assert.equal(result.failure.message, ordinary.failure.message);
        } else if (result._tag === "Success" && ordinary._tag === "Success") {
          assert.equal(result.success.status, "ready");
          if (result.success.status !== "ready" || ordinary.success.status !== "ready") return;
          assert.equal(result.success.selectedRuntime.version, "9.0.0");
          assert.equal(
            result.success.selectedRuntime.updateBlocked,
            ordinary.success.selectedRuntime.updateBlocked,
          );

          assert.isString(result.success.selectedRuntime.updateBlocked);
          assert.isUndefined(result.success.selectedRuntime.reconnectProbe);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a host change between folded probe and launch falls back without replacing anything",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          f.setScriptPrefix(`sh() {
      if [ -f "$HOME/.test/probed" ] && [ ! -f "$HOME/.test/raced" ]; then
        printf 'changed identity\\n' > "$HOME/.goat/ssh-launch/runtime/identity"
        touch "$HOME/.test/raced"
      fi
      touch "$HOME/.test/probed"
      command sh "$@"
    }
    `);
          const before = f.remoteCommands.length;
          const result = yield* Effect.result(launch(f, first.selectedRuntime));
          assert.equal(result._tag, "Failure");
          assert.equal(f.remoteCommands.length - before, 3);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, '"type":"drain"');
          assert.notInclude(events, '"type":"stop"');
          assert.equal(events.split('"type":"start"').length - 1, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a vanished selection reinstalls only the requested runtime, then cleans up separately",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.shiftHostClock(60);
          const first = yield* launch(f);
          assert.equal(first.status, "ready");
          if (first.status !== "ready") return;
          yield* f.fs.remove(`${f.old}/.install-complete`);
          const unverified = `${f.home}/.goat/runtime/goat/versions/8.0.0`;
          yield* f.fs.makeDirectory(unverified);
          yield* f.fs.writeFileString(`${unverified}/.install-complete`, "8.0.0\n");
          yield* f.fs.writeFileString(
            `${unverified}/.install-record`,
            `8.0.0 ${"a".repeat(64)} ${"b".repeat(64)} cache\n`,
          );
          yield* f.fs.writeFileString(
            `${unverified}/goat`,
            '#!/bin/sh\ntouch "$HOME/.test/unverified-executed"\nexit 1\n',
          );
          yield* f.fs.chmod(`${unverified}/goat`, 0o700);
          const before = f.remoteCommands.length;
          const result = yield* launch(f, first.selectedRuntime);
          assert.equal(result.status, "ready");
          if (result.status !== "ready") return;
          assert.equal(result.selectedRuntime.version, ARCHIVE.archiveVersion);
          assert.isString(result.selectedRuntime.reconnectProbe);
          assert.isFalse(yield* f.fs.exists(`${f.test}/unverified-executed`));
          assert.equal(f.counters().uploads, 1);
          assert.equal(f.remoteCommands.length - before, 4);
          const cleanup = f.remoteCommands.at(-1)!;
          assert.equal(cleanup._tag, "StandardCommand");
          if (cleanup._tag === "StandardCommand")
            assert.include(cleanup.args, "goat-runtime-cleanup");
          const reconnected = f.remoteCommands.length;
          yield* launch(f, result.selectedRuntime);
          assert.equal(f.remoteCommands.length - reconnected, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
