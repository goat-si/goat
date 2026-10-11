import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live.each([
      "other UID",
      "arbitrary argv0",
      "non-GOAT path",
      "changed runner",
      "symlink pid",
      "symlink port",
      "symlink managed",
      "symlink run-t3.sh",
      "control pid",
      "control port",
      "control version",
      "extra newline",
      "start time changes",
      "start time changes before kill",
    ] as const)("audit legacy refusal: %s", (failure) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          descriptor404: true,
        });
        yield* f.fs.remove(`${f.state}/identity`);
        let linked: string | undefined;
        if (failure.startsWith("symlink ")) {
          linked = `${f.state}/${failure.slice("symlink ".length)}`;
          yield* f.fs.rename(linked, `${linked}.original`);
          yield* f.fs.symlink(`${linked}.original`, linked);
        }
        if (failure === "control pid")
          yield* f.fs.writeFileString(`${f.state}/pid`, `${f.pid}\t\n`);
        if (failure === "control port")
          yield* f.fs.writeFileString(`${f.state}/port`, `${f.port}\r\n`);
        if (failure === "extra newline")
          yield* f.fs.writeFileString(`${f.state}/pid`, `${f.pid}\n\n`);
        if (failure === "control version") {
          const source = yield* f.fs.readFileString(`${f.state}/run-t3.sh`);
          yield* f.fs.writeFileString(
            `${f.state}/run-t3.sh`,
            source.replace("T3_ARCHIVE_VERSION='1.2.2'", "T3_ARCHIVE_VERSION='1.2.2\t'"),
          );
        }
        const psPath = `${f.test}/identity-bin/ps`;
        let ps = yield* f.fs.readFileString(psPath);
        if (failure === "arbitrary argv0")
          ps = ps.replace('"$HOME/.goat/runtime/', '"arbitrary $HOME/.goat/runtime/');
        if (failure === "non-GOAT path")
          ps = ps.replace(
            "$HOME/.goat/runtime/goat/versions/",
            "$HOME/.other/runtime/goat/versions/",
          );
        let prefix = "";
        if (failure === "other UID")
          prefix = `if [ "$1 $2 $3 $4" = '-o uid= -p ${f.pid}' ]; then printf '9999999\\n'; exit 0; fi\n`;
        if (failure === "changed runner")
          prefix = `if [ "$1 $2 $3 $4" = '-o uid= -p ${f.pid}' ]; then printf '# changed during inspection\\n' >> '${f.state}/run-t3.sh'; fi\n`;
        if (failure.startsWith("start time changes")) {
          const condition = failure.endsWith("before kill")
            ? `[ -f '${f.state}/identity' ]`
            : `[ -e '${f.test}/start-inspected' ]`;
          prefix = `if [ "$1 $2 $3 $4" = '-o lstart= -p ${f.pid}' ]; then if ${condition}; then printf 'Thu Jan  1 00:00:00 1970\\n'; else touch '${f.test}/start-inspected'; /bin/ps "$@"; fi; exit 0; fi\n`;
        }
        yield* f.fs.writeFileString(psPath, ps.replace("#!/bin/sh\n", "#!/bin/sh\n" + prefix));
        const before = yield* f.snapshot;
        const result = yield* f.run("launch");
        assert.isTrue(Result.isFailure(result));
        yield* Effect.sync(() => process.kill(f.pid, 0));
        const after = yield* f.snapshot;
        if (failure === "start time changes before kill") {
          assert.equal(after.pid, before.pid);
          assert.equal(after.port, before.port);
          assert.equal(after.managed, before.managed);
          assert.equal(after.runtime, before.runtime);
          assert.equal(after.oldExecutable, before.oldExecutable);
          assert.equal(after.oldMarker, before.oldMarker);
          assert.equal(after.identity, null);
          assert.equal(after["run-t3.sh"], before["run-t3.sh"]);
        } else if (failure === "changed runner") {
          assert.isTrue(after["run-t3.sh"]!.startsWith(before["run-t3.sh"]!));
          assert.include(after["run-t3.sh"]!, "# changed during inspection\n");
          assert.deepEqual({ ...after, "run-t3.sh": null }, { ...before, "run-t3.sh": null });
        } else assert.deepEqual(after, before);
        if (linked !== undefined) assert.equal(yield* f.fs.readLink(linked), `${linked}.original`);
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        assert.notInclude(events, '"type":"stop"');
        assert.notInclude(events, '"type":"auth"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("legacy acquisition failure preserves all running-server files", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          descriptor404: true,
        });
        yield* f.fs.remove(`${f.state}/identity`);
        const cache = f.runner.archiveDirectory;
        const name = (yield* f.fs.readDirectory(cache)).find((name) => name.endsWith(".sha256"))!;
        yield* f.fs.writeFileString(`${cache}/${name}`, "invalid checksum\n");
        const before = yield* f.snapshot;
        assert.isTrue(Result.isFailure(yield* f.run("launch")));
        assert.deepEqual(yield* f.snapshot, before);
        yield* Effect.sync(() => process.kill(f.pid, 0));
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["idle", "busy", "unknown", "garbage", "idle,busy"] as const)(
      "startup refresh respects activity %s",
      (activity) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, activity);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          assert.isTrue(Result.isSuccess(result));
          if (Result.isSuccess(result)) {
            assert.equal(result.success.refresh, activity === "idle" ? "replaced" : undefined);
            assert.equal(
              result.success.pending?.reason,
              activity === "idle"
                ? undefined
                : activity === "busy" || activity === "idle,busy"
                  ? "busy"
                  : "unknown",
            );
            assert.equal(
              result.success.version,
              activity === "idle" ? ARCHIVE.archiveVersion : "1.2.2",
            );
          }
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          if (activity === "idle") {
            assert.include(events, '"type":"stop"');
            assert.include(
              yield* f.fs.readFileString(`${f.state}/identity`),
              `/versions/${ARCHIVE.archiveVersion}/goat`,
            );
            assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "2");
          } else {
            assert.deepEqual(yield* f.snapshot, before);
            yield* Effect.sync(() => process.kill(f.pid, 0));
            assert.notInclude(events, '"type":"stop"');
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
