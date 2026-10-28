// @effect-diagnostics nodeBuiltinImport:off - host identity is fixture data for POSIX lock owners.
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as NetService from "@goat/shared/Net";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  uploadTarget,
  testHttpClient,
  testNetService,
  makeRunningProcess,
} from "./tunnel.fixture.ts";
import { fixture, launch } from "./tunnel.reconnect-probe.fixture.ts";
import { SshReconnectCost } from "./command.ts";
import * as SshAuth from "./auth.ts";
import { SshEnvironmentManager } from "./tunnel.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH folded reconnect probe",
  () => {
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
  },
);
