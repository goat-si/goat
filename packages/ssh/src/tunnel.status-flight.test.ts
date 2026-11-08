import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE, uploadTarget } from "./tunnel.fixture.ts";
import { fixture, signals, stopped, successfulStatus } from "./tunnel.runtime-status.fixture.ts";

const live = {
  ...stopped,
  ready: true,
  liveStatus: "live",
  liveVersion: ARCHIVE.archiveVersion,
  livePort: 3773,
  liveOwned: true,
  liveDrain: true,
  liveSignals: signals(ARCHIVE.archiveVersion),
  liveBinarySignals: signals(ARCHIVE.archiveVersion),
};

describe("concurrent SSH status reads", () => {
  const holdProbe = (f: ReturnType<typeof fixture>) =>
    Effect.gen(function* () {
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      f.gateProbe(gate);
      return gate;
    });

  it.effect("share one runtime probe for one host", () => {
    const f = fixture(live);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const gate = yield* holdProbe(f);
      const leader = yield* manager.status(uploadTarget).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const second = yield* manager
        .status(uploadTarget)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const third = yield* manager
        .status(uploadTarget)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate.release, undefined);
      const first = yield* Fiber.join(leader);
      assert.deepEqual(yield* Fiber.join(second), first);
      assert.deepEqual(yield* Fiber.join(third), first);
      assert.equal(f.calls.probes, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("elect a new probe when the caller running it is interrupted", () => {
    const f = fixture(live);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const gate = yield* holdProbe(f);
      const leader = yield* manager.status(uploadTarget).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const waiter = yield* manager
        .status(uploadTarget)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const interrupting = yield* Fiber.interrupt(leader).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(interrupting);
      assert.equal(successfulStatus(yield* Fiber.join(waiter)).state, "ready");
      assert.equal(f.calls.probes, 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("never join a probe that started before the host was disconnected", () => {
    const f = fixture(live);
    // Disconnect advances the resolved host's generation, not this alias-only request's.
    const aliasOnly = { alias: "devbox", hostname: "devbox", username: null, port: null };
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const gate = yield* holdProbe(f);
      // One effect value, run before and after: freshness is decided when it runs.
      const read = manager.status(aliasOnly);
      const stale = yield* read.pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* manager.disconnectEnvironment(aliasOnly);
      const fresh = yield* read.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(stale);
      yield* Fiber.join(fresh);
      assert.equal(f.calls.probes, 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
});
