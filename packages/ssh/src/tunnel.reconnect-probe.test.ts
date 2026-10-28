import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { ARCHIVE, installArchivePsDouble } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { launch } from "./tunnel.reconnect-probe.fixture.ts";
import { SshReconnectCost } from "./command.ts";

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
  },
);
