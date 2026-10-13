import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as RuntimeDrain from "./runtimeDrain.ts";
import * as RuntimeAdmission from "./runtimeAdmission.ts";
import * as RuntimeIdentity from "./runtimeIdentity.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";

const input = { expectedInstanceId: "this-start", targetVersion: "next", graceSeconds: 1 };
const setup = (activity: "idle" | "busy") =>
  Effect.gen(function* () {
    const checked = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const memory = yield* Effect.gen(function* () {
      return yield* ProjectionStore.ProjectionStoreV2;
    }).pipe(Effect.provide(ProjectionStore.layerMemory));
    const dependencies = Layer.mergeAll(
      RuntimeAdmission.layer,
      ServerLifecycleEvents.layer,
      Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: input.expectedInstanceId }),
      Layer.succeed(RuntimeDrain.RuntimeShutdown, {
        shutdown: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
      }),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        ...memory,
        getServerActivity: () => Deferred.succeed(checked, undefined).pipe(Effect.as(activity)),
      }),
    );
    const context = yield* Layer.build(RuntimeDrain.layer.pipe(Layer.provideMerge(dependencies)));
    return { context, checked, stopped };
  });

it.effect("idle drain rejects new dispatches and invokes delayed shutdown", () =>
  Effect.gen(function* () {
    const { context, checked, stopped } = yield* setup("idle");
    yield* Effect.gen(function* () {
      const drain = yield* RuntimeDrain.RuntimeDrain;
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      const result = yield* drain.request(input).pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      const rejected = yield* gate.admit(Effect.void).pipe(Effect.flip);
      assert.equal(rejected._tag, "ServerDrainingError");
      assert.deepEqual(yield* Fiber.join(result), {
        status: "drained",
        instanceId: "this-start",
        forced: false,
      });
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(stopped);
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("unforced deadline cancels and reopens admission", () =>
  Effect.gen(function* () {
    const { context, checked, stopped } = yield* setup("busy");
    yield* Effect.gen(function* () {
      const drain = yield* RuntimeDrain.RuntimeDrain;
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      const result = yield* drain.request(input).pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal((yield* Fiber.join(result)).status, "cancelled");
      assert.equal(yield* gate.admit(Effect.succeed("admitted")), "admitted");
      assert.equal(yield* Deferred.isDone(stopped), false);
      const snapshot = yield* (yield* ServerLifecycleEvents.ServerLifecycleEvents).snapshot;
      assert.equal(
        snapshot.events.find((event) => event.type === "runtimeDrain")?.payload.status,
        "cancelled",
      );
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("a joining force confirmation drains at the original deadline", () =>
  Effect.gen(function* () {
    const { context, checked, stopped } = yield* setup("busy");
    yield* Effect.gen(function* () {
      const drain = yield* RuntimeDrain.RuntimeDrain;
      const first = yield* drain.request(input).pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      const confirmed = yield* drain.request({ ...input, force: true }).pipe(
        Effect.forkScoped,
        Effect.tap(() => Effect.yieldNow),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* Fiber.join(first);
      assert.deepEqual(result, { status: "drained", instanceId: "this-start", forced: true });
      assert.deepEqual(yield* Fiber.join(confirmed), result);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(stopped);
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("wrong instance leaves admission and lifecycle untouched", () =>
  Effect.gen(function* () {
    const { context, checked } = yield* setup("idle");
    yield* Effect.gen(function* () {
      const result = yield* (yield* RuntimeDrain.RuntimeDrain).request({
        ...input,
        expectedInstanceId: "previous-start",
      });
      assert.deepEqual(result, {
        status: "instance-changed",
        instanceId: "this-start",
        forced: false,
      });
      yield* (yield* RuntimeAdmission.RuntimeAdmission).admit(Effect.void);
      assert.equal(yield* Deferred.isDone(checked), false);
      assert.equal(
        (yield* (yield* ServerLifecycleEvents.ServerLifecycleEvents).snapshot).sequence,
        0,
      );
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("drain waits for an admitted dispatch even when projections are idle", () =>
  Effect.gen(function* () {
    const { context, checked } = yield* setup("idle");
    yield* Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const admitted = yield* gate
        .admit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const result = yield* (yield* RuntimeDrain.RuntimeDrain)
        .request(input)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      assert.equal(yield* gate.inFlight, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(admitted);
      yield* TestClock.adjust(Duration.millis(100));
      assert.equal((yield* Fiber.join(result)).status, "drained");
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("continuations remain admitted and counted during a drain", () =>
  Effect.gen(function* () {
    const { context, checked } = yield* setup("busy");
    yield* Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      const result = yield* (yield* RuntimeDrain.RuntimeDrain)
        .request(input)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const continuation = yield* gate
        .admit(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))), {
          continuation: true,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.equal(yield* gate.inFlight, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(continuation);
      assert.equal(yield* gate.inFlight, 0);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal((yield* Fiber.join(result)).status, "cancelled");
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);
