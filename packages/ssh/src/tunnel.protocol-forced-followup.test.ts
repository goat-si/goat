import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { replaceTargetOf } from "./forcedReplacementScripts.ts";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import {
  events,
  isAlive,
  startOf,
  statusProbe,
  unverified,
  type Fixture,
} from "./tunnel.protocol-forced.testkit.ts";

const OLDER = "1.2.3-preview.9";

const approved = (f: Fixture) =>
  Effect.gen(function* () {
    return { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) };
  });

/** The process on the recorded PID now runs a command that is not GOAT's recorded launch. */
const foreignCommand = (f: Fixture) =>
  f.fs.writeFileString(`${f.test}/foreign-command`, "node /srv/other/server.js --port 1\n");

/** The host log names the PID and the check that failed, so a refusal can be diagnosed later. */
const loggedRefusal = (f: Fixture, reason: string) =>
  Effect.gen(function* () {
    assert.include(
      yield* f.fs.readFileString(`${f.state}/server.log`),
      `GOAT did not stop PID ${f.pid} for an approved forced update: ${reason}.`,
    );
  });

/** nohup fails as on a host without it, either for every command or only for the supervisor. */
const failingNohup = (f: Fixture, when: "always" | "supervise") =>
  Effect.gen(function* () {
    const bin = `${f.test}/nohup-bin`;
    yield* f.fs.makeDirectory(bin);
    yield* f.fs.writeFileString(
      `${bin}/nohup`,
      when === "always"
        ? "#!/bin/sh\nexit 127\n"
        : '#!/bin/sh\n[ "$1" = true ] && exit 0\nexit 127\n',
    );
    yield* f.fs.chmod(`${bin}/nohup`, 0o700);
    f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement only stops a process GOAT can show it started",
  () => {
    it.live(
      "a process whose command is not GOAT's recorded launch is refused, even with a recorded start",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          yield* foreignCommand(f);
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: yield* approved(f),
          });
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
          assert.isTrue(isAlive(f.pid));
          assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
          yield* loggedRefusal(f, "its command is not GOAT's recorded launch");
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a runtime from before launches recorded their start takes the manual path", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        yield* f.fs.remove(`${f.state}/started`);
        yield* f.fs.remove(`${f.state}/started.ticks`);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: yield* approved(f),
        });
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
        assert.isTrue(isAlive(f.pid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
        yield* loggedRefusal(f, "no start time was recorded at its launch");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a launch records the start time of the runtime it started", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...unverified, live: false });
        const result = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        const pid = Number((yield* f.fs.readFileString(`${f.state}/pid`)).trim());
        assert.equal(
          (yield* f.fs.readFileString(`${f.state}/started`)).trim(),
          yield* startOf(f, pid),
        );
        assert.isTrue(yield* f.fs.exists(`${f.state}/started.ticks`));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { name: "a recorded start and GOAT's launch command", started: true, command: true },
      { name: "a recorded start only", started: true, command: false },
      { name: "GOAT's launch command only", started: false, command: true },
    ])(
      "the status probe offers a process only with both kinds of evidence: $name",
      ({ started, command }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          if (!command) yield* foreignCommand(f);
          if (!started) yield* f.fs.remove(`${f.state}/started`);
          const target = yield* approved(f);
          assert.deepEqual(
            replaceTargetOf(yield* statusProbe(f)),
            started && command ? { replaceTarget: target } : {},
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement after the stop",
  () => {
    it.live(
      "an SSH drop while the runtime is being stopped does not leave the host half done",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({ ...unverified, ignoreSigterm: true });
          const bin = `${f.test}/hup-bin`;
          yield* f.fs.makeDirectory(bin);
          // The first wait for the stopping runtime hangs up the launch shell, as a dropped SSH session does.
          yield* f.fs.writeFileString(
            `${bin}/sleep`,
            `#!/bin/sh
if [ ! -e "$HOME/.test/hup-sent" ]; then : >"$HOME/.test/hup-sent"; kill -HUP "$PPID"; fi
exec /bin/sleep "$@"
`,
          );
          yield* f.fs.chmod(`${bin}/sleep`, 0o700);
          f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 1,
            forceReplace: yield* approved(f),
          });
          assert.isTrue(yield* f.fs.exists(`${f.test}/hup-sent`));
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          if (Result.isSuccess(result))
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          assert.isFalse(isAlive(f.pid));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a supervisor failure after the forced stop says what happened and where the reason is",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: yield* approved(f),
          });
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.include(
              String(result.failure),
              `after the approved forced stop of PID ${f.pid}, the detached supervisor reported a failure`,
            );
          assert.isFalse(isAlive(f.pid));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a child of the stopped runtime is never signalled, and one still running is named",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({ ...unverified, spawnChild: true });
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: yield* approved(f),
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          // A shell cannot signal a PID that its child may have given up; the person checks it instead.
          const child = Number((yield* f.fs.readFileString(`${f.test}/child-pid`)).trim());
          assert.isFalse(yield* f.fs.exists(`${f.test}/child-term-ppid`));
          assert.isTrue(isAlive(child));
          assert.include(
            yield* f.fs.readFileString(`${f.state}/server.log`),
            `child process ${child}`,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement trusts only the SSH user's own records",
  () => {
    it.live("a start time in a file other users can write is not evidence", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const target = yield* approved(f);
        yield* f.fs.chmod(`${f.state}/started`, 0o666);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: target,
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.deepEqual(replaceTargetOf(yield* statusProbe(f)), {});
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { mark: "+", acl: true },
      { mark: "@", acl: true },
      { mark: "@", acl: false },
    ] as const)(
      "a start time is evidence only without an access list; ls marks $mark, access list $acl",
      ({ mark, acl }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          const target = yield* approved(f);
          // ls marks an access list with +, or with @ when extended attributes are also present;
          // on macOS ls -le lists the entries of the list.
          yield* f.fs.writeFileString(
            `${f.home}/.test/identity-bin/ls`,
            `#!/bin/sh
for last; do :; done
if [ "$last" = '${f.state}/started' ]; then
  printf '%s\\n' '-rw-------${mark} 1 u g 25 Jan  1 00:00 started'
  case " $* " in *" -lde "*) ${acl ? "printf '%s\\\\n' ' 0: user:other allow write'" : ":"} ;; esac
  exit 0
fi
exec /bin/ls "$@"
`,
          );
          yield* f.fs.chmod(`${f.home}/.test/identity-bin/ls`, 0o700);
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: target,
          });
          if (!acl) {
            // Extended attributes alone are common on macOS and prove nothing either way.
            assert.isTrue(
              Result.isSuccess(result),
              String(Result.isFailure(result) && result.failure),
            );
            assert.isFalse(isAlive(f.pid));
            return;
          }
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
          assert.isTrue(isAlive(f.pid));
          assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
          assert.deepEqual(replaceTargetOf(yield* statusProbe(f)), {});
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a launch replaces a started symlink instead of writing through it", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...unverified, live: false });
        const victim = `${f.test}/victim`;
        yield* f.fs.writeFileString(victim, "keep\n");
        yield* f.fs.symlink(victim, `${f.state}/started`);
        const result = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        assert.equal(yield* f.fs.readFileString(victim), "keep\n");
        assert.equal((yield* f.fs.stat(`${f.state}/started`)).type, "File");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement hands the start to the detached supervisor",
  () => {
    it.live("a failed start after the forced stop of a runtime that answered starts it again", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: yield* approved(f),
        });
        assert.isFalse(isAlive(f.pid));
        const pid = Number((yield* f.fs.readFileString(`${f.state}/pid`)).trim());
        assert.notEqual(pid, f.pid);
        assert.isTrue(isAlive(pid));
        if (Result.isFailure(result))
          assert.include(String(result.failure), `GOAT ${OLDER} was started again`);
        else assert.equal(result.success.version, OLDER);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a child that ignores SIGTERM is left running and named once its runtime is gone", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          ...unverified,
          spawnChild: true,
          childIgnoresTerm: true,
        });
        const child = Number((yield* f.fs.readFileString(`${f.test}/child-pid`)).trim());
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 1,
          forceReplace: yield* approved(f),
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        assert.isTrue(isAlive(child));
        assert.include(
          yield* f.fs.readFileString(`${f.state}/server.log`),
          `child process ${child}`,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement publishes the new runner before it stops anything",
  () => {
    it.live("a publication that fails stops nothing", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const bin = `${f.test}/mv-bin`;
        yield* f.fs.makeDirectory(bin);
        // The final rename of the new runner fails, as on a full or read-only disk.
        yield* f.fs.writeFileString(
          `${bin}/mv`,
          `#!/bin/sh
if [ "$2" = '${f.state}/run-t3.sh' ]; then
  case "$1" in '${f.state}'/run-t3.next.*.restore) ;; '${f.state}'/run-t3.next.*) printf 'injected publication failure\\n' >&2; exit 73 ;; esac
fi
exec /bin/mv "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/mv`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: yield* approved(f),
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a host that cannot run the detached supervisor stops nothing", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        yield* failingNohup(f, "always");
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: yield* approved(f),
        });
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
        assert.isTrue(isAlive(f.pid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
        yield* loggedRefusal(f, "the detached supervisor that starts the new runtime cannot run");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a supervisor that left no result after the stop is reported as unknown", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        yield* failingNohup(f, "supervise");
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: yield* approved(f),
        });
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(
            String(result.failure),
            "the detached supervisor left no result, so GOAT cannot tell whether a runtime is running there now",
          );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a drain that went unanswered and was force-stopped also reports an unknown outcome",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            drain: true,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(`${f.test}/drain`, "response-lost");
          yield* failingNohup(f, "supervise");
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: yield* approved(f),
          });
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.include(
              String(result.failure),
              "the detached supervisor left no result, so GOAT cannot tell whether a runtime is running there now",
            );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement after publication",
  () => {
    it.live(
      "an SSH drop right after the new runner is published does not strand the old runtime",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          const bin = `${f.test}/hup-mv-bin`;
          yield* f.fs.makeDirectory(bin);
          // Publishing the new runner hangs up the launch shell, as a dropped SSH session does.
          yield* f.fs.writeFileString(
            `${bin}/mv`,
            `#!/bin/sh
/bin/mv "$@" || exit $?
if [ "$2" = '${f.state}/run-t3.sh' ] && [ ! -e "$HOME/.test/hup-sent" ]; then : >"$HOME/.test/hup-sent"; kill -HUP "$PPID"; fi
`,
          );
          yield* f.fs.chmod(`${bin}/mv`, 0o700);
          f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: yield* approved(f),
          });
          assert.isTrue(yield* f.fs.exists(`${f.test}/hup-sent`));
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          if (Result.isSuccess(result))
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          assert.isFalse(isAlive(f.pid));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
