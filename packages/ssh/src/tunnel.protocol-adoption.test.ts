import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const compatible = {
  live: true,
  oldVersion: "1.2.2",
  drain: true,
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
} as const;

const eventTypes = (raw: string) =>
  raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime ownership of a GOAT-managed server without launch records",
  () => {
    it.live("an idle orphan is replaced through its own drain, never signalled", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, kind: "orphan" });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        if (Result.isSuccess(result)) assert.equal(result.success.refresh, "replaced");
        const events = eventTypes(yield* f.fs.readFileString(`${f.test}/events`));
        for (const type of ["drain", "self-stop", "supervise"]) assert.include(events, type);
        assert.notInclude(events, "stop");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a busy orphan is adopted and kept serving; the refresh waits", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, kind: "orphan" });
        yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          assert.equal(result.success.pending?.reason, "busy");
        }
        const after = yield* f.snapshot;
        assert.equal(after.managed, "managed\n");
        assert.equal(after.pid, `${f.pid}\n`);
        assert.equal(after.port, `${f.port}\n`);
        assert.equal(
          after.identity,
          `${f.old}/goat serve --host 127.0.0.1 --port ${f.port} --base-dir ${f.home}/.goat\n`,
        );
        const events = eventTypes(yield* f.fs.readFileString(`${f.test}/events`));
        assert.notInclude(events, "drain");
        assert.notInclude(events, "stop");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("an owning attach without refresh adopts the orphan and keeps it running", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, kind: "orphan" });
        const result = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          assert.equal(result.success.port, f.port);
        }
        assert.equal((yield* f.snapshot).managed, "managed\n");
        assert.notInclude(eventTypes(yield* f.fs.readFileString(`${f.test}/events`)), "stop");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a secondary preparation never writes ownership records", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, live: true, kind: "orphan" });
        const before = yield* f.snapshot;
        // Pairing answers from the live server; only the owning launch may adopt it.
        yield* f.run("pairing");
        const after = yield* f.snapshot;
        assert.equal(after.managed, before.managed);
        assert.equal(after.pid, before.pid);
        assert.equal(after.identity, before.identity);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a foreign server stays external and is never drained", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, kind: "external" });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          assert.isUndefined(result.success.refresh);
        }
        assert.equal((yield* f.snapshot).managed, "external\n");
        const events = eventTypes(yield* f.fs.readFileString(`${f.test}/events`));
        assert.notInclude(events, "drain");
        assert.notInclude(events, "stop");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "records naming another live process refuse adoption and leave everything running",
      () =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({ ...compatible, kind: "orphan" });
          yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
          // The test worker is alive and is not the server: its records are not this server's.
          yield* f.fs.writeFileString(`${f.state}/pid`, `${process.pid}\n`);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          assert.isTrue(Result.isFailure(result));
          assert.deepEqual(yield* f.snapshot, before);
          const events = eventTypes(yield* f.fs.readFileString(`${f.test}/events`));
          assert.notInclude(events, "drain");
          assert.notInclude(events, "stop");
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    // A person restarting the runtime by hand on Windows recorded PowerShell's CommandLine for
    // the same process; every launch then refused the host until the file was fixed by hand.
    const handWrittenIdentity = (f: { old: string; port: number; home: string }) =>
      `"${f.old}/goat.exe"  "serve" "--host" "127.0.0.1" "--port" "${f.port}" "--base-dir" "${f.home}/.goat" \n`;

    it.live("a hand-written identity for GOAT's own serve is rewritten and the host attaches", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, kind: "managed" });
        const written = handWrittenIdentity(f);
        yield* f.fs.writeFileString(`${f.state}/identity`, written);
        const result = yield* f.run("launch");
        assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          assert.equal(result.success.port, f.port);
        }
        const after = yield* f.snapshot;
        assert.equal(
          after.identity,
          `${f.old}/goat serve --host 127.0.0.1 --port ${f.port} --base-dir ${f.home}/.goat\n`,
        );
        assert.equal(after.pid, `${f.pid}\n`);
        assert.equal(after.managed, "managed\n");
        assert.equal(yield* f.fs.readFileString(`${f.state}/identity.unverified`), written);
        const events = eventTypes(yield* f.fs.readFileString(`${f.test}/events`));
        assert.notInclude(events, "drain");
        assert.notInclude(events, "stop");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a mismatched identity for any other process is refused with the next step", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({ ...compatible, kind: "managed" });
        yield* f.fs.writeFileString(`${f.state}/identity`, handWrittenIdentity(f));
        yield* f.fs.writeFileString(
          `${f.home}/.test/foreign-command`,
          "/bin/tail -f /unrelated/log\n",
        );
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.include(String(result.failure), "ownership could not be verified");
          assert.include(String(result.failure), "stop it on the host and reconnect");
        }
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse(yield* f.fs.exists(`${f.state}/identity.unverified`));
        const events = eventTypes(yield* f.fs.readFileString(`${f.test}/events`));
        assert.notInclude(events, "drain");
        assert.notInclude(events, "stop");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
