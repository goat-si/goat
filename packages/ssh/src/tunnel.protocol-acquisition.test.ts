import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { remoteShell, ARCHIVE, nativeScripts } from "./tunnel.fixture.ts";
import { protocolExecutable, makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "accepts own not-running tokens and exact legacy fallback for $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          for (const missingCommand of [false, true]) {
            const f = yield* makeProtocolFixture({
              live: false,
              kind: "managed",
              oldVersion: ARCHIVE.archiveVersion,
              ssh: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestration: ORCHESTRATION_PROTOCOL_VERSION,
              missingCommand,
            });
            // A legacy helper cannot inspect remembered state; test cold absence with no runtime/identity files.
            const result = yield* f.run(entry);
            assert.isTrue(Result.isSuccess(result));
            assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        [
          {
            ownTokens: `unknown ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0`,
          },
          {
            ownTokens: `1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} garbage garbage`,
          },
          {
            liveTokens: `live unknown ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 1234`,
          },
          {
            liveTokens: `live 1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} garbage garbage`,
          },
        ].map((injected) => ({ entry, injected })),
      ),
    )("rejects malformed Node $entry tokens: $injected", ({ entry, injected }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const cli = `${f.home}/fixture-cli.cjs`;
        yield* f.fs.writeFileString(
          cli,
          protocolExecutable(
            "1.2.3",
            {
              ssh: SSH_RUNTIME_PROTOCOL_VERSION,
              orchestration: ORCHESTRATION_PROTOCOL_VERSION,
              ...injected,
            },
            f.state,
          ),
        );
        const scripts = yield* nativeScripts({ nodeScriptPath: cli });
        const key = f.state.slice(f.state.lastIndexOf("/") + 1);
        const script = scripts[entry];
        const before = yield* f.snapshot;
        const child = yield* f.realSpawner.spawn(
          ChildProcess.make(remoteShell, ["-s", "--", key], {
            env: { HOME: f.home, PATH: process.env.PATH ?? "", LC_ALL: "C" },
            extendEnv: false,
            stdin: { stream: Stream.make(new TextEncoder().encode(script)), endOnDone: true },
          }),
        );
        const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString);
        assert.notEqual(Number(yield* child.exitCode), 0);
        assert.include(stderr, "Malformed");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "start", "stop"]) assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        [
          `live unknown ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 1234`,
          `live 1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} garbage garbage`,
        ].map((liveTokens) => ({
          entry,
          liveTokens,
        })),
      ),
    )("rejects malformed archive live tokens before $entry: $liveTokens", ({ entry, liveTokens }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          liveTokens,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "start", "stop"]) assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (
          [
            { missingCommand: true },
            { ssh: SSH_RUNTIME_PROTOCOL_VERSION },
            { ssh: 99, orchestration: ORCHESTRATION_PROTOCOL_VERSION },
          ] as const
        ).map((metadata) => ({ entry, metadata })),
      ),
    )("acquires exact $entry for dormant incompatible metadata $metadata", ({ entry, metadata }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ...metadata,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success.version, ARCHIVE.archiveVersion);
        assert.equal(f.counters().uploads, 1);
        assert.equal(f.counters().gh, 0);
        assert.isAbove(f.counters().cacheReads, 0);
        const after = yield* f.snapshot;
        assert.equal(after.oldExecutable, before.oldExecutable);
        assert.equal(after.oldMarker, before.oldMarker);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "rejects explicit protocol mismatch at the exact requested $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: false,
            kind: "managed",
            oldVersion: ARCHIVE.archiveVersion,
            ssh: 99,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const before = yield* f.snapshot;
          assert.isTrue(Result.isFailure(yield* f.run(entry)));
          assert.deepEqual(yield* f.snapshot, before);
          assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        (["goat", ".install-complete"] as const).map((remove) => ({ entry, remove })),
      ),
    )("rejects selected $remove disappearance before $entry", ({ entry, remove }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        let removed = false;
        f.setBeforeCommand((script) => {
          if (removed || !script.includes('RUNNER_FILE="$STATE_DIR/run-t3.sh"')) return Effect.void;
          removed = true;
          return f.fs.remove(`${f.old}/${remove}`);
        });
        assert.isTrue(Result.isFailure(yield* f.run(entry)));
        assert.isTrue(removed);
        for (const file of ["run-t3.sh", "pid", "port", "managed"])
          assert.equal(yield* f.fs.readFileString(`${f.state}/${file}`), before[file]);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        assert.notInclude(events, '"type":"auth"');
        assert.notInclude(events, '"type":"stop"');
        const files = yield* f.fs.readDirectory(f.state);
        assert.isFalse(files.some((file) => file.includes(".next.") || file.endsWith(".pin")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live(
      "validates the requested runtime before drain and publishes it before supervised startup",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            drain: true,
            ssh: 99,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run("launch");
          assert.isTrue(Result.isSuccess(result));
          if (Result.isSuccess(result))
            assert.equal(result.success.version, ARCHIVE.archiveVersion);
          const after = yield* f.snapshot;
          assert.notEqual(after.pid, before.pid);
          assert.equal(after.oldExecutable, before.oldExecutable);
          assert.equal(after.oldMarker, before.oldMarker);
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const validation = events.findIndex(
            (event) => event.type === "version" && event.version === ARCHIVE.archiveVersion,
          );
          const stop = events.findIndex((event) => event.type === "drain");
          const start = events.findLastIndex((event) => event.type === "start");
          assert.isAtLeast(validation, 0);
          assert.isAtLeast(stop, 0);
          assert.isBelow(validation, stop);
          assert.isFalse(events.some((event) => event.type === "stop"));
          assert.isTrue(events.some((event) => event.type === "self-stop"));
          assert.isTrue(
            events.some((event) => event.type === "supervise" && event.status === "replaced"),
          );
          assert.isBelow(stop, start);
          assert.include(events[start].runner, `T3_ARCHIVE_VERSION='${ARCHIVE.archiveVersion}'`);
          assert.equal(f.counters().uploads, 1);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
