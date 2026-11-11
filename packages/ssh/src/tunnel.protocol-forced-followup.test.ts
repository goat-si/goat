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

const approved = (f: Fixture) =>
  Effect.gen(function* () {
    return { pid: f.pid, port: f.port, startedAt: yield* startOf(f, f.pid) };
  });

/** The process on the recorded PID now runs a command that is not GOAT's recorded launch. */
const foreignCommand = (f: Fixture) =>
  f.fs.writeFileString(`${f.test}/foreign-command`, "node /srv/other/server.js --port 1\n");

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH forced replacement only stops a process GOAT can show it started",
  () => {
    it.live("a process with neither a recorded start nor GOAT's launch command is refused", () =>
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
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a start time recorded at launch is evidence on its own", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture(unverified);
        yield* foreignCommand(f);
        const target = yield* approved(f);
        yield* f.fs.writeFileString(`${f.state}/started`, target.startedAt + "\n");
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: target,
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        assert.isFalse(isAlive(f.pid));
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
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([false, true])(
      "the status probe offers a process only with that evidence; recorded start=%s",
      (recorded) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture(unverified);
          yield* foreignCommand(f);
          const target = yield* approved(f);
          if (recorded) yield* f.fs.writeFileString(`${f.state}/started`, target.startedAt + "\n");
          assert.deepEqual(
            replaceTargetOf(yield* statusProbe(f)),
            recorded ? { replaceTarget: target } : {},
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

    it.live("a start that fails after the forced stop says the earlier runtime was stopped", () =>
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
          assert.include(String(result.failure), `stopped the earlier runtime (PID ${f.pid})`);
        assert.isFalse(isAlive(f.pid));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a child is signalled while the runtime it belongs to still runs", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...unverified, spawnChild: true });
        const result = yield* f.run("launch", false, {
          confirmReplacement: true,
          replacementGraceSeconds: 5,
          forceReplace: yield* approved(f),
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        assert.equal(
          Number((yield* f.fs.readFileString(`${f.test}/child-term-ppid`)).trim()),
          f.pid,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
