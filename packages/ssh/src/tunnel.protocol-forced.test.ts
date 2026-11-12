import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { replaceTargetOf } from "./forcedReplacementScripts.ts";
import { buildRemoteRuntimeProbeScript, decodeRemoteRuntimeProbe } from "./runtimeProbe.ts";
import { ARCHIVE, remoteShell } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const OLDER = "1.2.3-preview.9";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Fixture = Effect.Success<ReturnType<typeof makeProtocolFixture>>;

/** The start time the host reports for a PID, as a person approved it. */
const startOf = (f: Pick<Fixture, "realSpawner">, pid: number) =>
  Effect.gen(function* () {
    const ps = yield* f.realSpawner.spawn(
      ChildProcess.make("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { LC_ALL: "C", TZ: "UTC" },
        extendEnv: false,
      }),
    );
    const text = yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return text.trim().replace(/\s+/gu, " ");
  });

const events = (f: Pick<Fixture, "fs" | "test">) =>
  f.fs.readFileString(`${f.test}/events`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; version: string }),
    ),
  );

const unverified = {
  live: true,
  kind: "managed",
  oldVersion: "1.2.2",
  ssh: 99,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  descriptor404: true,
} as const;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced runtime replacement",
  () => {
    it.live(
      "an approved forced update replaces a runtime without a descriptor by its recorded PID and start time",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          if (Result.isSuccess(result)) {
            assert.equal(result.success.status, "ready");
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          }
          assert.isFalse(isAlive(f.pid));
          const after = yield* f.snapshot;
          assert.notEqual(after.pid, `${f.pid}\n`);
          assert.include(after.identity!, `/versions/${ARCHIVE.archiveVersion}/goat serve`);
          const log = yield* events(f);
          assert.equal(
            log.filter((entry) => entry.type === "stop" && entry.version === "1.2.2").length,
            1,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    const refusedBecause = {
      "start time": "its start time differs from the approved one",
      uid: "another user owns it",
      "start tick": "the start tick recorded at its launch differs",
    } as const;

    it.live.each(["start time", "port", "uid", "start tick", "no approval"] as const)(
      "a runtime that fails the %s check is never signalled",
      (mismatch) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          if (mismatch === "uid") yield* f.fs.writeFileString(`${f.test}/foreign-uid`, "4242\n");
          // On Linux the live tick is real and on macOS it is empty; neither is this record.
          if (mismatch === "start tick")
            yield* f.fs.writeFileString(`${f.state}/started.ticks`, "1\n");
          const startedAt = yield* startOf(f, f.pid);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            ...(mismatch === "no approval"
              ? {}
              : {
                  forceReplace: {
                    pid: f.pid,
                    port: mismatch === "port" ? f.port + 1 : f.port,
                    startedAt: mismatch === "start time" ? "Thu Jan 1 00:00:00 1970" : startedAt,
                  },
                }),
          });
          assert.isTrue(Result.isFailure(result));
          assert.isTrue(isAlive(f.pid));
          assert.deepEqual(yield* f.snapshot, before);
          assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
          if (mismatch === "no approval") return;
          if (mismatch === "port") {
            // The records no longer name the approved port, so the stop is refused and logged.
            assert.include(
              yield* f.fs.readFileString(`${f.state}/server.log`),
              `GOAT did not stop PID ${f.pid} for an approved forced update: the launch records no longer name it on port ${f.port + 1}.`,
            );
            return;
          }
          // The person is told how to stop it themselves; the host log says which check failed.
          if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
          assert.include(
            yield* f.fs.readFileString(`${f.state}/server.log`),
            `GOAT did not stop PID ${f.pid} for an approved forced update: ${refusedBecause[mismatch]}.`,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a runtime that no longer matches before SIGKILL is left running with its records",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            ...unverified,
            ignoreSigterm: true,
            startChangesOnTerm: true,
          });
          const startedAt = yield* startOf(f, f.pid);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 1,
            forceReplace: { pid: f.pid, port: f.port, startedAt },
          });
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
          assert.isTrue(isAlive(f.pid));
          assert.deepEqual(yield* f.snapshot, before);
          assert.include(
            yield* f.fs.readFileString(`${f.state}/server.log`),
            `GOAT did not stop PID ${f.pid} for an approved forced update: it no longer matched the approved runtime before SIGKILL.`,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "a runtime that ignores SIGTERM is killed after the grace, and its child is left running and named",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            ...unverified,
            ignoreSigterm: true,
            spawnChild: true,
          });
          const child = Number((yield* f.fs.readFileString(`${f.test}/child-pid`)).trim());
          assert.isTrue(isAlive(child));
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 1,
            forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          assert.isFalse(isAlive(f.pid));
          // Children are never signalled: one still running is named for a person to check.
          assert.isTrue(isAlive(child));
          assert.include(
            yield* f.fs.readFileString(`${f.state}/server.log`),
            `child process ${child}`,
          );
          assert.isTrue((yield* events(f)).some((entry) => entry.type === "stop"));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([false, true])(
      "an owned older runtime that cannot drain is replaced only when forced; forced=%s",
      (forced) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: OLDER,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            ...(forced
              ? { forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) } }
              : {}),
          });
          if (Result.isFailure(result)) throw result.failure;
          if (forced) {
            assert.equal(result.success.status, "ready");
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
            assert.isFalse(isAlive(f.pid));
          } else {
            // Without approval the host keeps the old runtime and attaches to it.
            assert.equal(result.success.version, OLDER);
            assert.equal(result.success.pending?.refreshCause, "drain_unavailable");
            assert.isTrue(isAlive(f.pid));
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH status names the recorded runtime process",
  () => {
    it.live.each([false, true])(
      "the probe reports the recorded process only while this user owns it; foreign=%s",
      (foreign) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          if (foreign) yield* f.fs.writeFileString(`${f.test}/foreign-uid`, "4242\n");
          const probe = yield* f.realSpawner.spawn(
            ChildProcess.make(remoteShell, ["-s"], {
              env: {
                HOME: f.home,
                PATH: `${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`,
                LC_ALL: "C",
              },
              extendEnv: false,
              stdin: {
                stream: Stream.make(
                  new TextEncoder().encode(
                    buildRemoteRuntimeProbeScript(
                      ARCHIVE.archiveVersion,
                      REMOTE_RUNTIME_STATE_KEY,
                      false,
                      false,
                      undefined,
                      true,
                    ),
                  ),
                ),
                endOnDone: true,
              },
            }),
          );
          const output = yield* probe.stdout.pipe(Stream.decodeText(), Stream.mkString);
          const decoded = yield* decodeRemoteRuntimeProbe(output);
          assert.deepEqual(
            replaceTargetOf(decoded),
            foreign
              ? {}
              : {
                  replaceTarget: {
                    pid: f.pid,
                    port: f.port,
                    startedAt: yield* startOf(f, f.pid),
                  },
                },
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement descendants",
  () => {
    it.live("a process listed as a child before its start time was read is never signalled", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const bystander = yield* f.realSpawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"]),
        );
        const bystanderPid = Number(bystander.pid);
        // A tree read alone names the bystander as the runtime's child, as when that child exits
        // and its PID is reused before a separate start-time read.
        const bin = `${f.test}/reused-bin`;
        yield* f.fs.makeDirectory(bin);
        yield* f.fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
if [ "$*" = "-A -o pid= -o ppid=" ]; then /bin/ps "$@"; echo "${bystanderPid} ${f.pid}"; exit 0; fi
exec "$HOME/.test/identity-bin/ps" "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/ps`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
        });
        assert.isTrue(Result.isSuccess(result));
        assert.isFalse(isAlive(f.pid));
        assert.isTrue(isAlive(bystanderPid));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement process table",
  () => {
    const tableDouble = (
      f: Pick<Fixture, "fs" | "test" | "home" | "setRemotePath">,
      body: string,
    ) =>
      Effect.gen(function* () {
        const bin = `${f.test}/table-bin`;
        yield* f.fs.makeDirectory(bin);
        yield* f.fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
if [ "$*" = "-A -o pid= -o ppid= -o uid= -o lstart=" ]; then ${body}; fi
exec "$HOME/.test/identity-bin/ps" "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/ps`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
      });

    it.live("an unreadable process table stops the update before any signal", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        yield* tableDouble(f, "exit 1");
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a table whose runtime row is another process signals nothing, children included", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const bystander = yield* f.realSpawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"]),
        );
        const bystanderPid = Number(bystander.pid);
        const bystanderStart = yield* startOf(f, bystanderPid);
        // The table read sees the approved PID reused by a newer process with a child.
        yield* tableDouble(
          f,
          `echo "${f.pid} 1 $(id -u) Thu Jan 1 00:00:00 2099"; echo "${bystanderPid} ${f.pid} $(id -u) ${bystanderStart}"; exit 0`,
        );
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.isTrue(isAlive(bystanderPid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement descendant parse",
  () => {
    it.live("a descendant list that cannot be parsed stops the update before any signal", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const bin = `${f.test}/awk-bin`;
        yield* f.fs.makeDirectory(bin);
        // Only the descendant parse passes the caller's uid as "me".
        yield* f.fs.writeFileString(
          `${bin}/awk`,
          `#!/bin/sh
for arg in "$@"; do case "$arg" in me=*) exit 2 ;; esac; done
exec /usr/bin/awk "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/awk`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement after a lost drain",
  () => {
    it.live(
      "an approved forced update replaces a runtime left behind by an unconfirmed drain",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          // A drain whose outcome was never confirmed leaves its fence for the same runtime.
          yield* f.fs.writeFileString(`${f.state}/draining`, "drained-instance\n");
          const result = yield* f.run("launch", false, {
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          if (Result.isSuccess(result))
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          assert.isFalse(isAlive(f.pid));
          assert.isFalse(yield* f.fs.exists(`${f.state}/draining`));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement, final review",
  () => {
    it.live(
      "an approved forced update replaces an owned runtime that does not answer its drain",
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
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: true,
            replacementGraceSeconds: 5,
            forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
          });
          assert.isTrue(
            Result.isSuccess(result),
            String(Result.isFailure(result) && result.failure),
          );
          if (Result.isSuccess(result)) {
            assert.equal(result.success.status, "ready");
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          }
          assert.isFalse(isAlive(f.pid));
          assert.isFalse(yield* f.fs.exists(`${f.state}/draining`));
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a malformed descendant row stops the update before any signal", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const bin = `${f.test}/row-bin`;
        yield* f.fs.makeDirectory(bin);
        // The runtime's own row is right; a child row lost its start time.
        yield* f.fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
if [ "$*" = "-A -o pid= -o ppid= -o uid= -o lstart=" ]; then
  echo "${f.pid} 1 $(id -u) $(LC_ALL=C TZ=UTC /bin/ps -o lstart= -p ${f.pid})"
  echo "99999 ${f.pid} $(id -u)"
  exit 0
fi
exec "$HOME/.test/identity-bin/ps" "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/ps`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.isFalse((yield* events(f)).some((entry) => entry.type === "stop"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement binds the drain to the approved process",
  () => {
    it.live("a runtime other than the approved one is not drained by the approval", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: OLDER,
          drain: true,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        // The approved process exited and this drain-capable runtime took its place and port.
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: "Thu Jan 1 00:00:00 1970" },
        });
        assert.isTrue(Result.isFailure(result));
        assert.isTrue(isAlive(f.pid));
        assert.isFalse(
          (yield* events(f)).some((entry) =>
            ["drain", "drain-request", "stop"].includes(entry.type),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement deep descendants",
  () => {
    it.live("a descendant forty levels below the runtime is found and named", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        const deep = yield* f.realSpawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"]),
        );
        const deepPid = Number(deep.pid);
        const deepStart = yield* startOf(f, deepPid);
        const chain = Array.from({ length: 40 }, (_, at) => 9_000_001 + at);
        const rows = [
          ...chain.map(
            (pid, at) =>
              `echo "${pid} ${at === 0 ? f.pid : chain[at - 1]} $(id -u) Thu Jan 1 00:00:00 2099"`,
          ),
          `echo "${deepPid} ${chain.at(-1)} $(id -u) ${deepStart}"`,
        ].join("\n");
        const bin = `${f.test}/deep-bin`;
        yield* f.fs.makeDirectory(bin);
        // The table shows the spawned process at the end of a chain forty processes deep, and its
        // parent read agrees, as for a real chain.
        yield* f.fs.writeFileString(
          `${bin}/ps`,
          `#!/bin/sh
if [ "$*" = "-A -o pid= -o ppid= -o uid= -o lstart=" ]; then
  /bin/ps "$@"
${rows}
  exit 0
fi
if [ "$*" = "-o ppid= -p ${deepPid}" ]; then echo ${chain.at(-1)}; exit 0; fi
exec "$HOME/.test/identity-bin/ps" "$@"
`,
        );
        yield* f.fs.chmod(`${bin}/ps`, 0o700);
        f.setRemotePath(`${bin}:${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`);
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) },
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        assert.isFalse(isAlive(f.pid));
        assert.isTrue(isAlive(deepPid));
        assert.include(
          yield* f.fs.readFileString(`${f.state}/server.log`),
          `child process ${deepPid}`,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
