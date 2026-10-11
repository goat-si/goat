import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { protocolExecutable, makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

/* eslint-disable no-useless-escape -- Preserve the original test body bytes during this split. */
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    it.live("rejects an upstream SSH helper identity with protocol 1", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: 1, // Upstream helper identity intentionally remains incompatible.
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", true);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(String(result.failure), "is incompatible; it was left running");
        assert.deepEqual(yield* f.snapshot, before);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["launch", "pairing", "mcp"] as const).flatMap((entry) =>
        [false, true].map((live) => ({ entry, live })),
      ),
    )("reuses older compatible $entry; live=$live", ({ entry, live }) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live,
          kind: "external",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          if (live && entry === "launch") assert.equal(result.success.port, f.port);
        }
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const after = yield* f.snapshot;
        assert.equal(after.oldExecutable, before.oldExecutable);
        assert.equal(after.oldMarker, before.oldMarker);
        if (live) assert.equal(after.runtime, before.runtime);
        const events = (yield* f.fs.readFileString(`${f.test}/events`))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.isFalse(events.some((event) => event.type === "stop"));
        if (entry !== "launch")
          assert.equal(events.findLast((event) => event.type === "auth")?.version, "1.2.2");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each((["launch", "pairing", "mcp"] as const).map((entry) => ({ entry })))(
      "preserves incompatible shared server for $entry",
      ({ entry }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ssh: 99,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run(entry, true);
          assert.isTrue(Result.isFailure(result));
          assert.deepEqual(yield* f.snapshot, before);
          const response = yield* Effect.promise(() =>
            // @effect-diagnostics-next-line globalFetchInEffect:off - real fixture loopback observation.
            fetch(`http://127.0.0.1:${f.port}/.well-known/t3/environment`),
          );
          assert.equal(response.status, 200);
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.notInclude(events, '"type":"stop"');
          assert.notInclude(events, '"type":"auth"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(
      (["archive", "node"] as const).flatMap((mode) =>
        [true, false].map((descriptor404) => ({ mode, descriptor404 })),
      ),
    )(
      "adopts only verified legacy archives; mode=$mode unknown=$descriptor404",
      ({ mode, descriptor404 }) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            descriptor404,
            ssh: SSH_RUNTIME_PROTOCOL_VERSION,
            orchestration: ORCHESTRATION_PROTOCOL_VERSION,
            nodeMode: mode === "node",
          });
          yield* f.fs.remove(`${f.state}/identity`);
          const nextEntry = `${f.home}/new dev's entry.cjs`;
          if (mode === "node")
            yield* f.fs.writeFileString(
              nextEntry,
              protocolExecutable(
                "1.2.3",
                {
                  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
                  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
                  nodeReadiness: true,
                },
                f.state,
              ),
            );
          const bin = `${f.test}/trace-bin`;
          yield* f.fs.makeDirectory(bin);
          const ps = mode === "node" ? "/bin/ps" : `${f.test}/identity-bin/ps`;
          yield* f.fs.writeFileString(
            `${bin}/ps`,
            `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
if(args[3]===${JSON.stringify(String(f.pid))}) fs.appendFileSync(${JSON.stringify(`${f.test}/events`)},JSON.stringify({type:'verify',identity:fs.existsSync(${JSON.stringify(`${f.state}/identity`)})?fs.readFileSync(${JSON.stringify(`${f.state}/identity`)},'utf8'):null})+'\\n');
process.stdout.write(cp.execFileSync(${JSON.stringify(ps)},args));
`,
          );
          yield* f.fs.chmod(`${bin}/ps`, 0o700);
          f.setRemotePath(`${bin}:${process.env.PATH ?? ""}`);
          const before = yield* f.snapshot;
          const result = yield* f.run(
            "launch",
            false,
            mode === "node" && descriptor404 ? { nodeScriptPath: nextEntry } : {},
          );
          if (mode === "node") {
            assert.isTrue(Result.isFailure(result));
            if (Result.isFailure(result)) assert.include(String(result.failure), `kill ${f.pid}`);
            assert.deepEqual(yield* f.snapshot, before);
            yield* Effect.sync(() => process.kill(f.pid, 0));
            assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '\"type\":\"stop\"');
            return;
          }
          assert.isTrue(Result.isSuccess(result));
          const events = (yield* f.fs.readFileString(`${f.test}/events`))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const stopped = events.findIndex((event) => event.type === "stop");
          assert.isAbove(stopped, 0);
          assert.isTrue(
            events
              .slice(0, stopped)
              .some((event) => event.type === "verify" && event.identity !== null),
          );
          assert.isTrue(
            events
              .slice(0, stopped)
              .some(
                (event) => event.type === "version" && event.version === ARCHIVE.archiveVersion,
              ),
          );
          assert.notEqual((yield* f.fs.readFileString(`${f.state}/pid`)).trim(), String(f.pid));
          const identity = yield* f.fs.readFileString(`${f.state}/identity`);
          assert.include(identity, `/versions/${ARCHIVE.archiveVersion}/goat`);
          assert.include(identity, `--base-dir ${f.home}/.goat`);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      "external",
      "absent marker",
      "dead pid",
      "wrong port",
      "wrong base dir",
      "wrong version",
      "malformed assignment",
      "duplicate assignment",
      "prefix command",
      "suffix command",
      "conflicting identity",
    ] as const)("preserves an unverifiable legacy server: %s", (failure) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          descriptor404: true,
        });
        yield* f.fs.remove(`${f.state}/identity`);
        if (failure === "external") yield* f.fs.writeFileString(`${f.state}/managed`, "external\n");
        if (failure === "absent marker") yield* f.fs.remove(`${f.state}/managed`);
        if (failure === "dead pid") yield* f.fs.writeFileString(`${f.state}/pid`, "424242\n");
        if (failure === "wrong port")
          yield* f.fs.writeFileString(
            `${f.state}/port`,
            String(f.port === 65535 ? 1234 : f.port + 1) + "\n",
          );
        if (failure === "conflicting identity")
          yield* f.fs.writeFileString(`${f.state}/identity`, "conflicting identity\n");
        if (["wrong version", "malformed assignment", "duplicate assignment"].includes(failure)) {
          const runner = yield* f.fs.readFileString(`${f.state}/run-t3.sh`);
          yield* f.fs.writeFileString(
            `${f.state}/run-t3.sh`,
            failure === "wrong version"
              ? runner.replace("T3_ARCHIVE_VERSION='1.2.2'", "T3_ARCHIVE_VERSION='1.2.1'")
              : failure === "malformed assignment"
                ? runner.replace("T3_ARCHIVE_VERSION='1.2.2'", "T3_ARCHIVE_VERSION=1.2.2")
                : runner + "\nT3_ARCHIVE_VERSION='1.2.2'\n",
          );
        }
        if (["wrong base dir", "prefix command", "suffix command"].includes(failure)) {
          const ps = yield* f.fs.readFileString(`${f.test}/identity-bin/ps`);
          yield* f.fs.writeFileString(
            `${f.test}/identity-bin/ps`,
            failure === "wrong base dir"
              ? ps.replace("--base-dir $HOME/.goat", "--base-dir /other/userdata")
              : failure === "prefix command"
                ? ps.replace('"$HOME/.goat/runtime/', '"tail -f $HOME/.goat/runtime/')
                : ps.replace('--base-dir $HOME/.goat"', '--base-dir $HOME/.goat --extra"'),
          );
        }
        const before = yield* f.snapshot;
        const result = yield* f.run("launch");
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* f.snapshot, before);
        yield* Effect.sync(() => process.kill(f.pid, 0));
        assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
