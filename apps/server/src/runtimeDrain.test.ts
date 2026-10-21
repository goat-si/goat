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
const setup = (
  activity: "idle" | "busy",
  admitted?: string,
  arbitrating?: {
    readonly started: Deferred.Deferred<void>;
    readonly gate: Deferred.Deferred<void>;
  },
) =>
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
    const arbiter =
      admitted === undefined
        ? Layer.empty
        : Layer.succeed(RuntimeDrain.RuntimeUpdateArbiter, {
            admit: (request) =>
              Effect.gen(function* () {
                if (request.automatic === true && arbitrating !== undefined) {
                  yield* Deferred.succeed(arbitrating.started, undefined);
                  yield* Deferred.await(arbitrating.gate);
                }
                return request.automatic !== true || request.targetVersion === admitted;
              }),
          });
    const context = yield* Layer.build(
      RuntimeDrain.layer.pipe(Layer.provideMerge(Layer.merge(dependencies, arbiter))),
    );
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

it.effect("one cancelled drain cannot reopen admission held by another update", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.RuntimeAdmission;
    yield* gate.beginDrain;
    yield* gate.beginDrain;
    yield* gate.resume;
    assert.equal((yield* gate.admit(Effect.void).pipe(Effect.flip))._tag, "ServerDrainingError");
    yield* gate.resume;
    yield* gate.admit(Effect.void);
  }).pipe(Effect.provide(RuntimeAdmission.layer)),
);

it.effect("a dropped automatic refresh is cancelled without closing admission", () =>
  Effect.gen(function* () {
    const { context, checked, stopped } = yield* setup("idle", "newest");
    yield* Effect.gen(function* () {
      const drain = yield* RuntimeDrain.RuntimeDrain;
      const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      // Client B asks for an older build than the target the runtime arbitrated for.
      assert.deepEqual(
        yield* drain.request({ ...input, targetVersion: "older", automatic: true }),
        {
          status: "cancelled",
          instanceId: "this-start",
          forced: false,
        },
      );
      yield* (yield* RuntimeAdmission.RuntimeAdmission).admit(Effect.void);
      assert.equal(yield* Deferred.isDone(checked), false);
      assert.equal((yield* lifecycle.snapshot).sequence, 0);
      // Client A's request for the winning target drains as before.
      const result = yield* drain
        .request({ ...input, targetVersion: "newest", automatic: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      assert.equal((yield* Fiber.join(result)).status, "drained");
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(stopped);
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("a refresh that would be dropped joins a drain that is already active", () =>
  Effect.gen(function* () {
    const { context, checked, stopped } = yield* setup("busy", "newest");
    yield* Effect.gen(function* () {
      const drain = yield* RuntimeDrain.RuntimeDrain;
      // A confirmed drain is under way; it ends drained at its deadline.
      const first = yield* drain
        .request({ ...input, targetVersion: "newest", force: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      // A reconciliation retry after a lost response must observe the real drain, never a
      // made-up cancellation while admission is closed.
      const retry = yield* drain
        .request({ ...input, targetVersion: "older", automatic: true })
        .pipe(
          Effect.forkScoped,
          Effect.tap(() => Effect.yieldNow),
        );
      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* Fiber.join(first);
      assert.deepEqual(result, { status: "drained", instanceId: "this-start", forced: true });
      assert.deepEqual(yield* Fiber.join(retry), result);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(stopped);
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);

it.effect("a refresh still being arbitrated joins a drain another request started", () =>
  Effect.gen(function* () {
    const arbitrating = {
      started: yield* Deferred.make<void>(),
      gate: yield* Deferred.make<void>(),
    };
    const { context, checked, stopped } = yield* setup("busy", "newest", arbitrating);
    yield* Effect.gen(function* () {
      const drain = yield* RuntimeDrain.RuntimeDrain;
      const dropped = yield* drain
        .request({ ...input, targetVersion: "older", automatic: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(arbitrating.started);
      // While it is arbitrated, a confirmed update starts a drain.
      const confirmed = yield* drain
        .request({ ...input, targetVersion: "newest", force: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checked);
      yield* Deferred.succeed(arbitrating.gate, undefined);
      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* Fiber.join(confirmed);
      assert.deepEqual(result, { status: "drained", instanceId: "this-start", forced: true });
      assert.deepEqual(yield* Fiber.join(dropped), result);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(stopped);
    }).pipe(Effect.provide(context));
  }).pipe(Effect.scoped),
);
