import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { installArchivePsDouble, uploadTarget } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { prepareRemoteRuntime } from "./tunnel.ts";

const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};

// Each case runs two full launches through fake executables, each a Node start. A case takes about
// 11 s on a hosted runner but 50-60 s on the shared EPYC host, where every runner shares one machine.
const LAUNCHES_TIMEOUT_MS = 180_000;

type Fixture = Effect.Success<ReturnType<typeof makeProtocolFixture>>;

// How many times each launch started goat to ask a question whose answer could be recorded.
const recordableAsks = (f: Fixture) =>
  Effect.gen(function* () {
    const events = (yield* f.fs.readFileString(`${f.test}/events`))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; live?: boolean; args?: string[] });
    return {
      compat: events.filter(
        (event) =>
          event.type === "exec" && event.args?.[0] === "__ssh-helper" && event.args[1] === "compat",
      ).length,
      own: events.filter(
        (event) => event.type === "version" || (event.type === "protocol" && !event.live),
      ).length,
      live: events.filter((event) => event.type === "protocol" && event.live === true).length,
    };
  });

const launch = (f: Fixture) =>
  Effect.gen(function* () {
    const result = yield* f.run("launch");
    if (Result.isFailure(result)) throw result.failure;
    assert.equal(result.success.status, "ready");
    assert.equal(result.success.port, f.port);
  });

const probe = (f: Fixture) =>
  prepareRemoteRuntime(uploadTarget, {}, f.runner, REMOTE_RUNTIME_STATE_KEY).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
    Effect.provideService(FileSystem.FileSystem, f.observedFs),
  );

const liveFixture = makeProtocolFixture({
  live: true,
  kind: "managed",
  oldVersion: "1.2.2",
  commitTime: 1_700_000_000,
  drain: true,
  ...current,
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH host facts", () => {
  it.live(
    "a reconnect to an unchanged runtime starts goat only for readiness",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        assert.isAbove(first.own, 0);
        assert.isAbove(first.live, 0);
        yield* launch(f);
        // Probe, candidate checks and every live recheck reuse the recorded answers.
        assert.deepEqual(yield* recordableAsks(f), first);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live.each(["compatible 0 -", "unknown 0 -", "failure"])(
    "%s is re-asked and never becomes a compat fact",
    (response) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          drain: true,
          ...current,
        });
        yield* f.shiftHostClock(60, true);
        yield* f.setCompat([response]);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        assert.isAbove(first.compat, 0);
        // The probe uses the same compat facts as launch without repeating readiness and guards.
        yield* probe(f);
        assert.isAbove((yield* recordableAsks(f)).compat, first.compat);
        const facts = yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch/facts`);
        assert.isFalse(facts.some((name) => name.startsWith("compat.")));
        const before = yield* f.snapshot;
        yield* f.setCompat(["real"]);
        yield* probe(f);
        assert.deepEqual(yield* f.snapshot, before);
        const positive = yield* recordableAsks(f);
        const recoveredFacts = yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch/facts`);
        assert.isTrue(recoveredFacts.some((name) => name.startsWith("compat.")));
        yield* probe(f);
        assert.equal((yield* recordableAsks(f)).compat, positive.compat);
        const refreshed = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(refreshed)) throw refreshed.failure;
        assert.equal(refreshed.success.refresh, "replaced");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live.each(["compatible 0 -", "unknown 0 -"])(
    "ignores a pre-U2 %s record under the same valid key",
    (negative) =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60, true);
        yield* launch(f);
        const file = `${f.home}/.goat/ssh-launch/facts/compat.1.2.2.exe`;
        const record = yield* f.fs.readFileString(file);
        const key = record.split("\n")[0]!;
        yield* f.fs.writeFileString(file, `${key}\n${negative}\n`);
        yield* f.setCompat(["compatible 0 -"]);
        const before = yield* recordableAsks(f);
        yield* launch(f);
        assert.isAbove((yield* recordableAsks(f)).compat, before.compat);
        assert.equal((yield* f.fs.readFileString(file)).split("\n")[0], key);
        const retained = yield* f.snapshot;
        yield* f.setCompat(["real"]);
        yield* launch(f);
        assert.deepEqual(yield* f.snapshot, retained);
        const recovered = yield* f.fs.readFileString(file);
        assert.equal(recovered.split("\n")[0], key);
        assert.match(recovered.split("\n")[1]!, /^compatible 1 [A-Za-z0-9-]+$/u);
        const positive = yield* recordableAsks(f);
        yield* launch(f);
        assert.equal((yield* recordableAsks(f)).compat, positive.compat);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a rewritten executable is asked again",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        const executable = `${f.old}/goat`;
        // A longer file changes the recorded size even when the rewrite lands in the same second.
        yield* f.fs.writeFileString(
          executable,
          (yield* f.fs.readFileString(executable)) + "\n// rebuilt\n",
        );
        yield* launch(f);
        assert.isAbove((yield* recordableAsks(f)).own, first.own);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a changed runtime record asks the live server again",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        const record = `${f.home}/.goat/userdata/server-runtime.json`;
        const runtime = JSON.parse(yield* f.fs.readFileString(record)) as Record<string, unknown>;
        // A restarted server writes a new record; only the start time differs here.
        yield* f.fs.writeFileString(
          record,
          JSON.stringify({ ...runtime, startedAt: "1970-01-01T00:00:00.000Z" }),
        );
        yield* launch(f);
        const second = yield* recordableAsks(f);
        assert.isAbove(second.live, first.live);
        assert.equal(second.own, first.own);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live.each([0, 1, 60])(
    "the first reconnect after an install starts goat only for readiness (age %s s at cleanup)",
    (age) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          candidateSignals: { ...current, drain: true, commitTime: 1_700_000_001 },
          ...current,
        });
        yield* f.fs.remove(f.old, { recursive: true });
        yield* f.fs.remove(`${f.state}/run-t3.sh`);
        yield* f.shiftHostClock(age, true);
        // Launch also polls its listener; measure the cleanup age gate on its own command.
        f.setBeforeCommand((script) =>
          script.includes("warm_runtime_facts()")
            ? f.fs.remove(`${f.test}/clock/waits`, { force: true })
            : Effect.void,
        );
        // Warming starts a dozen fixture node processes; a loaded CI runner can exceed the 10 s default.
        const installed = yield* f.run("launch", false, { cleanupTimeoutMs: LAUNCHES_TIMEOUT_MS });
        if (Result.isFailure(installed)) throw installed.failure;
        assert.equal(installed.success.status, "ready");
        assert.isAbove(installed.success.port, 0);
        assert.equal(installed.success.version, f.runner.archiveVersion);
        assert.isAbove(f.counters().uploads, 0);
        const runtime = JSON.parse(
          yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
        ) as { pid: number };
        yield* installArchivePsDouble(
          f.home,
          runtime.pid,
          installed.success.port,
          f.runner.archiveVersion,
        );
        assert.isTrue(
          f.remoteCommands.some(
            (command) =>
              command._tag === "StandardCommand" && command.args.includes("goat-runtime-cleanup"),
          ),
        );
        const waited = `${f.test}/clock/waits`;
        if (age < 2) assert.equal(yield* f.fs.readFileString(waited), `${2 - age}\n`);
        else assert.isFalse(yield* f.fs.exists(waited));
        const facts = `${f.home}/.goat/ssh-launch/facts`;
        for (const kind of ["version", "own", "commit", "scopes", "live", "compat"]) {
          for (const via of ["exe", "runner"]) {
            assert.isTrue(yield* f.fs.exists(`${facts}/${kind}.${f.runner.archiveVersion}.${via}`));
          }
        }
        const starts = Effect.gen(function* () {
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { type: string; args?: string[] });
          return events.filter((event) => event.type === "exec").map((event) => event.args);
        });
        const before = (yield* starts).length;
        // The next SSH operation observes the same file times, now outside the age gate.
        yield* f.shiftHostClock(60, true);
        const reconnected = yield* f.run("launch");
        if (Result.isFailure(reconnected)) throw reconnected.failure;
        assert.equal(reconnected.success.port, installed.success.port);
        const reconnectStarts = (yield* starts).slice(before);
        yield* Effect.logInfo("first reconnect goat starts", {
          count: reconnectStarts.length,
          args: reconnectStarts,
        });
        assert.equal(reconnectStarts.length, 1);
        assert.equal(reconnectStarts[0]?.[1], "wait-ready");
        if (age === 60) {
          // Replay the submitted cleanup shell at real fault boundaries; every failure must
          // preserve the ready server and leave a later reconnect free to discover facts.
          const cleanup = f.remoteCommands.find(
            (command) =>
              command._tag === "StandardCommand" && command.args.includes("goat-runtime-cleanup"),
          )!;
          for (const fault of ["lock", "rollback", "wait", "timeout", "clock", "windows"]) {
            yield* f.fs.remove(facts, { recursive: true, force: true });
            yield* f.shiftHostClock(fault === "clock" ? -1 : 0, true);
            const lock = `${f.home}/.goat/ssh-launch/replacement.lock`;
            const previous = `${f.state}/run-t3.previous`;
            if (fault === "lock") yield* f.fs.symlink("another-owner", lock);
            if (fault === "rollback") yield* f.fs.writeFileString(previous, "rollback\n");
            f.setScriptPrefix(
              fault === "wait"
                ? "sleep() { return 1; }\n"
                : fault === "timeout"
                  ? `
# Force the cleanup's existing fail-closed path on Linux as well as macOS.
flock() { return 1; }
printf() {
  case "$1" in ssh.runtime.cleanup.skipped*) command printf 'cleanup-finished\\n' >> "$HOME/.test/order" ;; esac
  command printf "$@"
}
sleep() {
  if [ -e "$LOCK" ] || [ -L "$LOCK" ] || [ -e "$RECOVERY" ] || [ -L "$RECOVERY" ]; then
    command printf 'warmup-locked\\n' >> "$HOME/.test/order"
  else
    command printf 'warmup-unlocked\\n' >> "$HOME/.test/order"
  fi
  # Model the command deadline expiring at the warm-up wait, without a timed test.
  kill -TERM "$$"
  exit 1
}
`
                  : fault === "windows"
                    ? 'uname() { if [ "$1" = -s ]; then echo MINGW64_NT; else command uname "$@"; fi; }\n'
                    : "",
            );
            const child = yield* f.transport.spawn(cleanup);
            assert.equal(Number(yield* child.exitCode), fault === "timeout" ? 1 : 0, fault);
            if (fault === "timeout") {
              assert.equal(
                yield* f.fs.readFileString(`${f.test}/order`),
                "cleanup-finished\nwarmup-unlocked\n",
              );
            }
            assert.isFalse(yield* f.fs.exists(facts), fault);
            yield* Effect.sync(() => process.kill(runtime.pid, 0));
            if (fault === "lock") {
              assert.equal(yield* f.fs.readLink(lock), "another-owner");
              yield* f.fs.remove(lock);
            }
            if (fault === "rollback") {
              assert.equal(yield* f.fs.readFileString(previous), "rollback\n");
              yield* f.fs.remove(previous);
            }
          }
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a same-size rewrite within the same second stays unkeyed and is asked again",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(0, true);
        yield* probe(f);
        const first = yield* recordableAsks(f);
        const executable = `${f.old}/goat`;
        const source = yield* f.fs.readFileString(executable);
        const rebuilt = source.replace("1.2.2", "1.2.1");
        assert.notEqual(rebuilt, source);
        assert.equal(rebuilt.length, source.length);
        yield* f.fs.writeFileString(executable, rebuilt);
        const selected = yield* probe(f);
        assert.isAbove((yield* recordableAsks(f)).own, first.own);
        assert.notEqual(selected.source, "retained");
        assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/ssh-launch/facts`));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "prunes only facts of removed versions without following symlinks",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* probe(f);
        const facts = `${f.home}/.goat/ssh-launch/facts`;
        const versions = `${f.home}/.goat/runtime/goat/versions`;
        const removed = `${versions}/1.0.0`;
        yield* f.fs.makeDirectory(removed);
        const kinds = ["version", "own", "commit", "scopes", "live", "compat"];
        const stale = kinds.flatMap((kind) =>
          ["exe", "runner"].map((via) => `${kind}.1.0.0.${via}`),
        );
        for (const name of stale) yield* f.fs.writeFileString(`${facts}/${name}`, "obsolete\n");
        // Directory existence protects incomplete installs too; neither link is traversed.
        yield* f.fs.makeDirectory(`${versions}/1.0.1`);
        yield* f.fs.symlink(`${f.home}/absent`, `${versions}/1.0.2`);
        const preserved = ["own.1.0.1.exe", "own.1.0.2.exe", "unknown.1.0.0.exe", "own.bad.exe"];
        for (const name of preserved) yield* f.fs.writeFileString(`${facts}/${name}`, "keep\n");
        yield* f.fs.symlink(`${f.test}/events`, `${facts}/own.1.0.3.exe`);
        yield* f.fs.makeDirectory(`${facts}/own.1.0.4.exe`);
        const installed = yield* f.fs.readFileString(`${facts}/version.1.2.2.exe`);
        yield* f.fs.remove(removed, { recursive: true });
        yield* probe(f);
        const names = yield* f.fs.readDirectory(facts);
        for (const name of stale) assert.notInclude(names, name);
        for (const name of [...preserved, "own.1.0.3.exe", "own.1.0.4.exe"])
          assert.include(names, name);
        assert.equal(yield* f.fs.readFileString(`${facts}/version.1.2.2.exe`), installed);
        assert.isAbove((yield* recordableAsks(f)).own, 0);
        const movedFacts = `${f.test}/moved-facts`;
        yield* f.fs.rename(facts, movedFacts);
        yield* f.fs.symlink(movedFacts, facts);
        yield* f.fs.writeFileString(`${movedFacts}/own.1.0.0.exe`, "keep behind link\n");
        yield* probe(f);
        assert.equal(
          yield* f.fs.readFileString(`${movedFacts}/own.1.0.0.exe`),
          "keep behind link\n",
        );
        yield* f.fs.remove(facts);
        yield* f.fs.rename(movedFacts, facts);
        const movedVersions = `${f.test}/moved-versions`;
        yield* f.fs.rename(versions, movedVersions);
        yield* f.fs.symlink(movedVersions, versions);
        yield* probe(f);
        assert.equal(yield* f.fs.readFileString(`${facts}/own.1.0.0.exe`), "keep behind link\n");
        yield* f.fs.remove(versions);
        yield* f.fs.rename(movedVersions, versions);
        f.setScriptPrefix("rm() { return 1; }\n");
        yield* probe(f);
        assert.equal(yield* f.fs.readFileString(`${facts}/own.1.0.0.exe`), "keep behind link\n");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "Windows host probes still ask every time and never record or prune facts",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        f.setScriptPrefix(
          'uname() { if [ "$1" = -s ]; then echo MINGW64_NT; else command uname "$@"; fi; }\n',
        );
        yield* probe(f);
        const first = yield* recordableAsks(f);
        assert.isAbove(first.own, 0);
        assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/ssh-launch/facts`));
        const stale = `${f.home}/.goat/ssh-launch/facts/own.1.0.0.exe`;
        yield* f.fs.makeDirectory(`${f.home}/.goat/ssh-launch/facts`);
        yield* f.fs.writeFileString(stale, "untouched\n");
        yield* probe(f);
        assert.isAbove((yield* recordableAsks(f)).own, first.own);
        assert.equal(yield* f.fs.readFileString(stale), "untouched\n");
        assert.deepEqual(yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch/facts`), [
          "own.1.0.0.exe",
        ]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "a damaged record is asked again instead of trusted",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        yield* launch(f);
        const first = yield* recordableAsks(f);
        const facts = `${f.home}/.goat/ssh-launch/facts`;
        for (const name of yield* f.fs.readDirectory(facts)) {
          const [key] = (yield* f.fs.readFileString(`${facts}/${name}`)).split("\n");
          yield* f.fs.writeFileString(`${facts}/${name}`, `${key}\nlive garbled\n`);
        }
        yield* launch(f);
        const second = yield* recordableAsks(f);
        assert.isAbove(second.own, first.own);
        assert.isAbove(second.live, first.live);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );

  it.live(
    "records no live answer when the record does not name the answering process",
    () =>
      Effect.gen(function* () {
        const f = yield* liveFixture;
        yield* f.shiftHostClock(60);
        const record = `${f.home}/.goat/userdata/server-runtime.json`;
        // A record from before versions were persisted grants the helper no PID, so whatever
        // listens on its port could change while every recorded input stays the same.
        const { serverVersion: _version, ...historical } = JSON.parse(
          yield* f.fs.readFileString(record),
        ) as Record<string, unknown>;
        yield* f.fs.writeFileString(record, JSON.stringify(historical));
        // Nothing is recorded here, so every ask starts goat; one launch already asks the live
        // server more than once, and a second launch would only double a slow runner's cost.
        yield* launch(f);
        assert.isAbove((yield* recordableAsks(f)).live, 1);
        const names = yield* f.fs.readDirectory(`${f.home}/.goat/ssh-launch/facts`);
        assert.isFalse(
          names.some((name) => name.startsWith("live.") || name.startsWith("compat.")),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    LAUNCHES_TIMEOUT_MS,
  );
});
