import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as NetService from "@goat/shared/Net";
import * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  ARCHIVE,
  uploadTarget,
  testHttpClient,
  testNetService,
  makeSuccessfulProcess,
  makeRunningProcess,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { fixture } from "./tunnel.reconnect-probe.fixture.ts";
import { SshReconnectCost } from "./command.ts";
import * as SshAuth from "./auth.ts";
import { SshEnvironmentManager } from "./tunnel.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH folded reconnect probe",
  () => {
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
          `Host devbox\n  HostName devbox.example.com\n  User alex\n  Port 2222\n  HostKeyAlias devbox\n  UserKnownHostsFile "${pinPath}"\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  UpdateHostKeys no\n  HostKeyAlgorithms ssh-ed25519\n`,
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
                `hostname devbox.example.com\nuser alex\nport 2222\nhostkeyalias devbox\nuserknownhostsfile ${pinPath}\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\n`,
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
          let configuration = "hostname devbox.example.com\nuser alex\nport 2222\n";
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
  },
);
