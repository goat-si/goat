import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { ARCHIVE, installArchivePsDouble } from "./tunnel.fixture.ts";
import { protocolExecutable } from "./tunnel.protocol.fixture.ts";
import { fixture, launch, type Fixture } from "./tunnel.reconnect-probe.fixture.ts";

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
          // A compatible newer runtime is an ordinary kept selection with nothing to block.
          assert.isUndefined(result.success.selectedRuntime.updateBlocked);
          assert.isString(result.success.selectedRuntime.reconnectProbe);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "an identity rewritten between folded probe and launch falls back and replaces nothing",
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
          assert.equal(result._tag, "Success"); // The fallback launch repairs the identity.
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
