import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const current = {
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
};
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "idle-only SSH replacement",
  () => {
    it.live.each(["older", "legacy", "incompatible"] as const)(
      "%s preserves every live file while busy, then replaces once at idle",
      (replacement) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...(replacement === "incompatible" ? { ssh: 999, orchestration: 999 } : current),
            candidateSignals: current,
          });
          if (replacement === "legacy") yield* f.fs.remove(`${f.state}/identity`);
          yield* f.fs.writeFileString(`${f.test}/activity`, "busy");
          const before = yield* f.snapshot;
          const first = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(first)) throw first.failure;
          assert.equal(first.success.pending?.reason, "busy");
          assert.equal(first.success.pending?.replacement, replacement);
          assert.equal(first.success.status, replacement === "incompatible" ? "pending" : "ready");
          assert.deepEqual(yield* f.snapshot, before);
          yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
          const second = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(second)) throw second.failure;
          assert.equal(second.success.status, "ready");
          assert.equal(second.success.refresh, "replaced");
          const events = yield* f.fs.readFileString(`${f.test}/events`);
          assert.equal(events.split('"type":"stop"').length - 1, 1);
          assert.notEqual((yield* f.snapshot).pid, before.pid);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["legacy", "incompatible"] as const)(
      "%s without a verified idle response stays pending and never commits ownership",
      (replacement) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...(replacement === "incompatible" ? { ssh: 999, orchestration: 999 } : current),
            candidateSignals: current,
          });
          if (replacement === "legacy") yield* f.fs.remove(`${f.state}/identity`);
          yield* f.fs.writeFileString(`${f.test}/activity`, "unknown");
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(result)) throw result.failure;
          assert.equal(result.success.pending?.reason, "unknown");
          assert.deepEqual(yield* f.snapshot, before);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([true, false])(
      "newer numeric-prerelease runtime is preserved (compatible=%s)",
      (compatible) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.3-preview.20260911.10",
            ...(compatible ? current : { ssh: 999, orchestration: 999 }),
            candidateSignals: current,
          });
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (compatible) {
            if (Result.isFailure(result)) throw result.failure;
            assert.equal(result.success.version, "1.2.3-preview.20260911.10");
          } else {
            if (Result.isSuccess(result)) throw new Error("Expected newer-incompatible refusal");
            assert.include(result.failure.message, "newer than this app");
          }
          assert.deepEqual(yield* f.snapshot, before);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live("an idle response for the wrong PID is unknown and preserves the live runtime", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
          candidateSignals: current,
        });
        yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
        yield* f.fs.writeFileString(`${f.test}/activity-pid`, String(f.pid + 1));
        const before = yield* f.snapshot;
        const result = yield* f.run("launch", false, {
          refreshOwnedRuntimeOnFirstConnection: true,
        });
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.pending?.reason, "unknown");
        assert.deepEqual(yield* f.snapshot, before);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["busy", "unknown"] as const)(
      "preliminary idle followed by final %s preserves every live file",
      (final) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...current,
            candidateSignals: current,
          });
          yield* f.fs.writeFileString(`${f.test}/activity`, `idle,${final}`);
          const before = yield* f.snapshot;
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isFailure(result)) throw result.failure;
          assert.equal(result.success.pending?.reason, final);
          assert.deepEqual(yield* f.snapshot, before);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["older", "legacy", "incompatible"] as const)(
      "%s stop failure preserves runner and rolls back prospective ownership",
      (replacement) =>
        Effect.gen(function* () {
          const f = yield* makeProtocolFixture({
            live: true,
            kind: "managed",
            oldVersion: "1.2.2",
            ...(replacement === "incompatible" ? { ssh: 999, orchestration: 999 } : current),
            candidateSignals: current,
          });
          if (replacement === "legacy") yield* f.fs.remove(`${f.state}/identity`);
          const before = yield* f.snapshot;
          f.setScriptPrefix(`kill() {
  if [ "$1" = '${f.pid}' ]; then return 1; fi
  command kill "$@"
}
`);
          const result = yield* f.run("launch", false, {
            refreshOwnedRuntimeOnFirstConnection: true,
          });
          if (Result.isSuccess(result)) throw new Error("Expected refused termination");
          assert.include(result.failure.message, "did not stop");
          assert.deepEqual(yield* f.snapshot, before);
          assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"type":"stop"');
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("compatible retained helpers without the new comparator remain reusable", () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          ...current,
          missingComparison: true,
          candidateSignals: current,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run("launch");
        if (Result.isFailure(result)) throw result.failure;
        assert.equal(result.success.status, "ready");
        assert.equal(result.success.version, "1.2.2");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
