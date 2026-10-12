// @effect-diagnostics nodeBuiltinImport:off - host identity is fixture data for POSIX lock owners.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshTunnel from "./tunnel.ts";
import { uploadTarget, installArchivePsDouble } from "./tunnel.fixture.ts";
import { protocolExecutable } from "./tunnel.protocol.fixture.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};
const liveOwner = () =>
  `${NodeOS.hostname()}|${process.getuid!()}|${process.pid}|${NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).replace(/\n$/, "")}|fixture`;
const deadOwner = () =>
  `${NodeOS.hostname()}|${process.getuid!()}|2147483647|Mon Jan 1 00:00:00 2000|fixture`;

// A fixture file marks a subprocess milestone; the waiter never polls or sleeps.
const fileMilestone = (file: string) =>
  Effect.callback<void>((resume) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      watcher.close();
      resume(Effect.void);
    };
    const watcher = NodeFS.watch(file.slice(0, file.lastIndexOf("/")), (_event, name) => {
      if (String(name) === file.slice(file.lastIndexOf("/") + 1)) finish();
    });
    if (NodeFS.existsSync(file)) finish();
    return Effect.sync(() => watcher.close());
  });

const pauseFirstLock = Effect.fn("test.pauseReplacementLock")(function* (
  f: Effect.Success<ReturnType<typeof makeProtocolFixture>>,
  name: "replacement.lock" | "replacement.recovery",
) {
  const fifo = yield* f.realSpawner.spawn(ChildProcess.make("mkfifo", [`${f.test}/lock-release`]));
  assert.equal(Number(yield* fifo.exitCode), 0);
  const bin = `${f.test}/lock-barrier-bin`;
  yield* f.fs.makeDirectory(bin);
  yield* f.fs.writeFileString(
    `${bin}/ln`,
    `#!/bin/sh
/bin/ln "$@" || exit $?
case "$3" in */${name})
  if mkdir "$HOME/.test/first-lock" 2>/dev/null; then
    printf acquired > "$HOME/.test/lock-acquired"
    read -r release < "$HOME/.test/lock-release"
  fi
;; esac
`,
  );
  yield* f.fs.chmod(`${bin}/ln`, 0o700);
  f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "host-wide replacement symlink mutex",
  () => {
    it.live("legacy stop failure rolls back identity while holding the replacement lock", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          descriptor404: true,
        });
        yield* f.fs.remove(`${f.state}/identity`);
        const before = yield* f.snapshot;
        const bin = `${f.test}/rollback-bin`;
        yield* f.fs.makeDirectory(bin);
        yield* f.fs.writeFileString(
          `${bin}/rm`,
          `#!/bin/sh
if [ "$2" = '${f.state}/identity' ]; then
  readlink "$HOME/.goat/ssh-launch/replacement.lock" > "$HOME/.test/rollback-owner"
fi
exec /bin/rm "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/rm`, 0o700);
        f.setRemotePath(`${bin}:${f.test}/identity-bin:${process.env.PATH ?? ""}`);
        f.setScriptPrefix(
          'kill() { if [ "$1" = -0 ]; then command kill "$@"; else return 1; fi; }\n',
        );
        const result = yield* f.run("launch");
        assert.isTrue(Result.isFailure(result));
        assert.isNotEmpty((yield* f.fs.readFileString(`${f.test}/rollback-owner`)).trim());
        assert.deepEqual(yield* f.snapshot, before);
        assert.notInclude(
          yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch`),
          "replacement.lock",
        );
        yield* Effect.sync(() => process.kill(f.pid, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { locale: "ko_KR.UTF-8", zone: "Asia/Seoul" },
      { locale: "C", zone: "Pacific/Honolulu" },
    ])("locale $locale and TZ $zone cannot prove a live owner dead", ({ locale, zone }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
        });
        const bin = `${f.test}/locale-bin`;
        yield* f.fs.makeDirectory(bin);
        yield* f.fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
if [ "$1 $2" = '-o lstart=' ]; then
  printf '%s %s\\n' "$LC_ALL" "$TZ" >> "$HOME/.test/lock-locale"
  if [ "$LC_ALL" != C ] || [ "$TZ" != UTC ]; then printf 'different locale or zone\\n'; exit 0; fi
  exec /bin/ps "$@"
fi
exec "$HOME/.test/identity-bin/ps" "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/ps`, 0o700);
        f.setRemotePath(`${bin}:${f.test}/identity-bin:${process.env.PATH ?? ""}`);
        f.setScriptPrefix(`export LC_ALL='${locale}' TZ='${zone}'\n`);
        const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
        const owner = liveOwner();
        yield* f.fs.symlink(owner, lock);
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.pending?.reason, "contended");
        assert.equal(yield* f.fs.readLink(lock), owner);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isTrue(
          (yield* f.fs.readFileString(`${f.test}/lock-locale`))
            .trim()
            .split("\n")
            .every((line) => line === "C UTC"),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["launch", "pairing", "mcp"] as const)(
      "unavailable lock identity preserves %s reuse",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
          });
          const bin = `${f.test}/minimal-bin`;
          yield* f.fs.makeDirectory(bin);
          yield* f.fs.writeFileString(
            `${bin}/ps`,
            `#!/bin/sh
if [ "$1 $2" = '-o lstart=' ]; then exit 1; fi
exec "$HOME/.test/identity-bin/ps" "$@"
`,
          );
          yield* f.fs.writeFileString(`${bin}/hostname`, "#!/bin/sh\nexit 1\n");
          for (const command of ["ps", "hostname"]) yield* f.fs.chmod(`${bin}/${command}`, 0o700);
          f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          const before = yield* f.snapshot;
          const result = yield* f.run(entry, entry !== "launch", {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(result)) throw result.failure;
          if (entry === "launch") assert.equal(result.success.pending?.reason, "contended");
          else assert.equal(result.success.version, "1.2.2");
          assert.deepEqual(yield* f.snapshot, before);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["live", "ownerless", "foreign", "recovery"] as const)(
      "%s owner stays contended and untouched",
      (mode) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
            candidateSignals: current,
          });
          const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
          const recovery = `${f.home}/.goat/ssh-launch/replacement.recovery`;
          const owner =
            mode === "live"
              ? liveOwner()
              : mode === "foreign"
                ? "other-host|0|1|old|nonce"
                : deadOwner();
          if (mode === "ownerless") yield* f.fs.writeFileString(lock, "");
          else yield* f.fs.symlink(owner, lock);
          if (mode === "recovery") yield* f.fs.symlink(deadOwner(), recovery);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(result)) throw result.failure;
          assert.equal(result.success.pending?.reason, "contended");
          if (mode === "recovery") assert.equal(result.success.pending?.detail, "recovery-stale");
          assert.deepEqual(yield* f.snapshot, before);
          if (mode !== "ownerless") assert.equal(yield* f.fs.readLink(lock), owner);
          if (mode === "recovery") assert.equal(yield* f.fs.readLink(recovery), deadOwner());
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["absent", "reused-pid"] as const)(
      "recovers only a proven dead %s owner, and releases only its acquired link",
      (mode) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
            candidateSignals: current,
          });
          const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
          const recovery = `${f.home}/.goat/ssh-launch/replacement.recovery`;
          const owner =
            mode === "absent"
              ? deadOwner()
              : `${NodeOS.hostname()}|${process.getuid!()}|${process.pid}|different-start|fixture`;
          yield* f.fs.symlink(owner, lock);
          yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(result)) throw result.failure;
          assert.equal(result.success.pending?.reason, "busy");
          assert.deepEqual(yield* f.snapshot, before);
          assert.notInclude(
            yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch`),
            "replacement.lock",
          );
          assert.notInclude(
            yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch`),
            "replacement.recovery",
          );
          assert.isFalse(yield* f.fs.exists(recovery));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("cleanup preserves a successor link installed by another actor", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
          candidateSignals: current,
        });
        const bin = `${f.test}/lock-bin`;
        yield* f.fs.makeDirectory(bin);
        yield* f.fs.writeFileString(
          `${bin}/ln`,
          `#!/bin/sh
/bin/ln "$@" || exit $?
case "$3" in */replacement.lock)
  /bin/rm -f "$3"
  /bin/ln -s 'successor-owner' "$3"
;; esac
`,
        );
        yield* f.fs.chmod(`${bin}/ln`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.pending?.reason, "contended");
        assert.equal(
          yield* f.fs.readLink(`${f.home}/.goat/ssh-launch/replacement.lock`),
          "successor-owner",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live("different aliases serialize replacement while the first owner is paused", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
          candidateSignals: current,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        const other = { ...uploadTarget, alias: "other-alias" };
        yield* pauseFirstLock(f, "replacement.lock");
        const first = yield* Effect.forkChild(
          f.run("launch", false, { refreshOwnedRuntimeOnFirstConnection: true }),
        );
        yield* fileMilestone(`${f.test}/lock-acquired`);
        const owner = yield* f.fs.readLink(`${f.home}/.goat/ssh-launch/replacement.lock`);
        const second = yield* SshTunnel.launchOrReuseRemoteServer(
          other,
          {},
          { ...f.runner, refreshOwnedRuntimeOnFirstConnection: true },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport));
        assert.equal(second.pending?.reason, "contended");
        assert.equal(yield* f.fs.readLink(`${f.home}/.goat/ssh-launch/replacement.lock`), owner);
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        yield* f.fs.writeFileString(`${f.test}/lock-release`, "release\n");
        const result = yield* Fiber.join(first);
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.refresh, "replaced");
        assert.equal(
          (yield* f.fs.readFileString(`${f.test}/events`)).split('"type":"stop"').length - 1,
          1,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("concurrent recovery leaves the first recoverer's links intact", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
          candidateSignals: current,
        });
        const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
        const recovery = `${f.home}/.goat/ssh-launch/replacement.recovery`;
        yield* f.fs.symlink(deadOwner(), lock);
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        yield* pauseFirstLock(f, "replacement.recovery");
        const first = yield* Effect.forkChild(
          f.run("launch", false, { refreshOwnedRuntimeOnFirstConnection: true }),
        );
        yield* fileMilestone(`${f.test}/lock-acquired`);
        const recoveryOwner = yield* f.fs.readLink(recovery);
        const second = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(second)) throw second.failure;
        assert.equal(second.success.pending?.reason, "contended");
        assert.equal(yield* f.fs.readLink(lock), deadOwner());
        assert.equal(yield* f.fs.readLink(recovery), recoveryOwner);
        yield* f.fs.writeFileString(`${f.test}/lock-release`, "release\n");
        const result = yield* Fiber.join(first);
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.pending?.reason, "busy");
        assert.notInclude(
          yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch`),
          "replacement.lock",
        );
        assert.notInclude(
          yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch`),
          "replacement.recovery",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a newer compatible runtime appearing under the lock is reused without downgrade", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
          candidateSignals: current,
        });
        yield* pauseFirstLock(f, "replacement.lock");
        const launch = yield* Effect.forkChild(
          SshTunnel.launchOrReuseRemoteServer(
            uploadTarget,
            {},
            { ...f.runner, refreshOwnedRuntimeOnFirstConnection: true },
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport)),
        );
        yield* fileMilestone(`${f.test}/lock-acquired`);
        const newer = "9.9.9";
        const directory = `${f.home}/.goat/runtime/goat/versions/${newer}`;
        yield* f.fs.makeDirectory(directory);
        yield* f.fs.writeFileString(
          `${directory}/goat`,
          protocolExecutable(newer, current, f.state),
        );
        yield* f.fs.chmod(`${directory}/goat`, 0o700);
        yield* f.fs.writeFileString(`${directory}/.install-complete`, newer);
        yield* f.fs.writeFileString(
          `${f.state}/run-t3.sh`,
          SshTunnel.buildRemoteGoatRunnerScript({ archiveVersion: newer }),
        );
        yield* Effect.sync(() => process.kill(f.pid, "SIGTERM"));
        const child = yield* f.realSpawner.spawn(
          ChildProcess.make(`${directory}/goat`, ["serve", "--test-seed"], {
            env: { HOME: f.home },
            extendEnv: true,
          }),
        );
        const ready = JSON.parse(
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(1),
            Stream.mkString,
          ),
        ) as { pid: number; port: number };
        yield* f.fs.writeFileString(`${f.state}/pid`, String(ready.pid));
        yield* f.fs.writeFileString(`${f.state}/port`, String(ready.port));
        yield* f.fs.writeFileString(
          `${f.state}/identity`,
          `${directory}/goat serve --host 127.0.0.1 --port ${ready.port} --base-dir ${f.home}/.goat`,
        );
        yield* installArchivePsDouble(f.home, ready.pid, ready.port, newer);
        yield* f.fs.writeFileString(`${f.test}/lock-release`, "release\n");
        const result = yield* Fiber.join(launch);
        if (result.status !== "ready") throw new Error("Expected newer compatible reuse");
        assert.equal(result.selectedRuntime.version, newer);
        assert.equal(result.remotePort, ready.port);
        assert.equal(result.refresh, undefined);
        assert.equal(
          (yield* f.fs.readFileString(`${f.test}/events`)).split('"type":"stop"').length - 1,
          1,
        );
        yield* Effect.sync(() => process.kill(ready.pid, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
