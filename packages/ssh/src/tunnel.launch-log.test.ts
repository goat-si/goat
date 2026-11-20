import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

it.live("a failed launch does not report an earlier launch's diagnostics", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    yield* f.fs.writeFileString(`${f.state}/server.log`, "EARLIER_LAUNCH_DIAGNOSTIC\n");
    yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
    const result = yield* f.run("launch");
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.notInclude(String(result.failure), "EARLIER_LAUNCH_DIAGNOSTIC");
      assert.include(String(result.failure), "It wrote nothing to");
    }
    assert.include(
      yield* f.fs.readFileString(`${f.state}/server.log`),
      "EARLIER_LAUNCH_DIAGNOSTIC",
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("keeps only the bounded tail of the previous log on a fresh launch", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    yield* f.fs.writeFileString(`${f.state}/server.log`, `${"x".repeat(1_048_576)}ROLLBACK_TAIL\n`);
    yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
    const result = yield* f.run("launch");
    assert.isTrue(Result.isFailure(result));
    const log = yield* f.fs.readFileString(`${f.state}/server.log`);
    assert.isAtMost(Buffer.byteLength(log), 1_048_576);
    assert.include(log, "ROLLBACK_TAIL");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("launches even when replacing the old log fails", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    yield* f.fs.writeFileString(`${f.state}/server.log`, "EARLIER_LOG\n");
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/mv`,
      '#!/bin/sh\ncase "$1" in */server-log-next.*) printf blocked >"$HOME/.test/mv-blocked"; exit 1 ;; *) exec /bin/mv "$@" ;; esac\n',
      { mode: 0o755 },
    );
    const result = yield* f.run("launch");
    assert.isTrue(yield* f.fs.exists(`${f.test}/mv-blocked`));
    assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
    assert.include(yield* f.fs.readFileString(`${f.state}/server.log`), "EARLIER_LOG");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("a failed launch excludes old output when replacing its log fails", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    yield* f.fs.writeFileString(`${f.state}/server.log`, "EARLIER_LOG\n");
    yield* f.fs.writeFileString(`${f.test}/fail-start-${ARCHIVE.archiveVersion}`, "1");
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/mv`,
      '#!/bin/sh\ncase "$1" in */server-log-next.*) printf blocked >"$HOME/.test/mv-blocked"; exit 1 ;; *) exec /bin/mv "$@" ;; esac\n',
      { mode: 0o755 },
    );
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/nohup`,
      '#!/bin/sh\nprintf "CURRENT_DIAGNOSTIC\\n"\nexec /usr/bin/nohup "$@"\n',
      { mode: 0o755 },
    );
    const result = yield* f.run("launch");
    assert.isTrue(yield* f.fs.exists(`${f.test}/mv-blocked`));
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.notInclude(String(result.failure), "EARLIER_LOG");
      assert.include(String(result.failure), "CURRENT_DIAGNOSTIC");
    }
    assert.include(yield* f.fs.readFileString(`${f.state}/server.log`), "EARLIER_LOG");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
