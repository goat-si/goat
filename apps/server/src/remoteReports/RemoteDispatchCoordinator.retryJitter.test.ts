import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { database, fixture } from "./RemoteDispatchCoordinator.testkit.ts";

it.effect("remote outage retries use independent bounded jitter without relaunching", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let draws = 0;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "notify_only");
      yield* Queue.take(f.calls);
      yield* f.replyLatest(
        Effect.fail(
          new Ssh.SshRemoteDispatchError({ reason: "host_unavailable", message: "fixture" }),
        ),
      );
      yield* TestClock.adjust("2499 millis");
      assert.equal(yield* Queue.size(f.calls), 0);
      yield* TestClock.adjust("1 milli");
      assert.equal(yield* Queue.size(f.calls), 1);
      const second = yield* Queue.take(f.calls);
      assert.equal(second.call.arguments.afterSequence, 0);
      yield* Queue.offer(
        second.reply,
        Effect.fail(
          new Ssh.SshRemoteDispatchError({ reason: "host_unavailable", message: "fixture" }),
        ),
      );
      yield* TestClock.adjust("7499 millis");
      assert.equal(yield* Queue.size(f.calls), 0);
      yield* TestClock.adjust("1 milli");
      assert.equal(yield* Queue.size(f.calls), 1);
      assert.equal(draws, 2);
      assert.equal(f.launches.length, 1);
      assert.equal((yield* c.get(launched.correlationId))?.state, "running");
      assert.equal((yield* c.get(launched.correlationId))?.reportCursor, 0);
      yield* Queue.take(f.calls);
    }).pipe(
      Effect.provide(f.layer),
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => (draws++ === 0 ? 0 : 0.5),
      }),
      Effect.scoped,
    );
    yield* TestClock.adjust("1 hour");
    assert.equal(yield* Queue.size(f.calls), 0);
    assert.equal(draws, 2);
  }).pipe(Effect.provide(database)),
);

it.effect("host unavailability sleeps before retry and read-key refusal becomes lost", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "notify_only");
      yield* Queue.take(f.calls);
      yield* f.replyLatest(
        Effect.fail(
          new Ssh.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "fixture",
          }),
        ),
      );
      yield* TestClock.adjust("4 seconds");
      assert.equal(yield* Queue.size(f.calls), 0);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(f.calls);
      yield* f.replyLatest(
        Effect.fail(
          new Ssh.SshRemoteDispatchError({
            reason: "remote_refused",
            remoteCode: "capability_denied",
            message: "fixture",
          }),
        ),
      );
      yield* Queue.take(f.commits);
      assert.equal((yield* c.get(launched.correlationId))!.state, "lost");
    }).pipe(
      Effect.provide(f.layer),
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => 0.9999,
      }),
    );
  }).pipe(Effect.provide(database)),
);
