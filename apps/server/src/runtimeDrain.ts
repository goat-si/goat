import {
  RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
  RUNTIME_DRAIN_MAX_GRACE_SECONDS,
  type RuntimeDrainRequest,
  type RuntimeDrainResult,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as RuntimeAdmission from "./runtimeAdmission.ts";
import * as RuntimeIdentity from "./runtimeIdentity.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";

export class RuntimeShutdown extends Context.Service<
  RuntimeShutdown,
  { readonly shutdown: Effect.Effect<void> }
>()("goat/runtimeDrain/RuntimeShutdown") {}
export const layerShutdown = Layer.succeed(RuntimeShutdown, {
  shutdown: Effect.sync(() => {
    process.kill(process.pid, "SIGTERM");
  }),
});

export class RuntimeDrain extends Context.Service<
  RuntimeDrain,
  {
    readonly request: (input: RuntimeDrainRequest) => Effect.Effect<RuntimeDrainResult>;
  }
>()("goat/runtimeDrain") {}

/**
 * Arbitrates automatic idle refreshes from clients; see `SshRuntimeAutoUpdate.admitDrain`.
 * Without it every request proceeds as it always did.
 */
export class RuntimeUpdateArbiter extends Context.Service<
  RuntimeUpdateArbiter,
  { readonly admit: (input: RuntimeDrainRequest) => Effect.Effect<boolean> }
>()("goat/runtimeDrain/RuntimeUpdateArbiter") {}

interface ActiveDrain {
  readonly result: Deferred.Deferred<RuntimeDrainResult>;
  readonly targetVersion: string;
  readonly deadline: number;
  status: "draining" | "cancelled" | "drained";
  forced: boolean;
}

const make = Effect.gen(function* () {
  const { instanceId } = yield* RuntimeIdentity.RuntimeIdentity;
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const shutdown = yield* RuntimeShutdown;
  const scope = yield* Scope.Scope;
  const arbiter = yield* Effect.serviceOption(RuntimeUpdateArbiter);
  let active: ActiveDrain | undefined;

  const publish = (drain: ActiveDrain, status: "draining" | "cancelled" | "drained") =>
    lifecycle.publish({
      version: 1,
      type: "runtimeDrain",
      payload: {
        status,
        targetVersion: drain.targetVersion,
        deadline: DateTime.formatIso(DateTime.makeUnsafe(drain.deadline)),
        forced: drain.forced,
      },
    });
  const run = (drain: ActiveDrain) =>
    Effect.gen(function* () {
      yield* publish(drain, "draining");
      let status: "drained" | "cancelled";
      while (true) {
        const inFlight = yield* admission.inFlight;
        const activity = yield* projections
          .getServerActivity()
          .pipe(Effect.catch(() => Effect.succeed("busy" as const)));
        if (inFlight === 0 && activity === "idle") {
          status = "drained";
          break;
        }
        const now = yield* Clock.currentTimeMillis;
        if (now >= drain.deadline) {
          status = drain.forced ? "drained" : "cancelled";
          break;
        }
        yield* Effect.sleep(Math.min(100, drain.deadline - now));
      }
      drain.status = status;
      yield* publish(drain, status);
      if (status === "cancelled") {
        yield* admission.resume;
        active = undefined;
      }
      yield* Deferred.succeed(drain.result, { status, instanceId, forced: drain.forced });
      if (status === "drained") {
        // Keep admission closed while HTTP flushes, then use normal restart recovery shutdown.
        yield* Effect.sleep(250);
        yield* shutdown.shutdown;
      }
    });

  return RuntimeDrain.of({
    request: (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (input.expectedInstanceId !== instanceId)
            return { status: "instance-changed" as const, instanceId, forced: false };
          const join = (drain: ActiveDrain) =>
            Effect.gen(function* () {
              if (drain.status === "draining" && input.force === true && !drain.forced) {
                drain.forced = true;
                yield* publish(drain, "draining");
              }
              return yield* restore(Deferred.await(drain.result));
            });
          if (active !== undefined) return yield* join(active);
          // Arbitration only decides whether to start a drain; a retry joins an active one.
          const admitted = Option.isNone(arbiter) || (yield* arbiter.value.admit(input));
          const now = yield* Clock.currentTimeMillis;
          const result = yield* Deferred.make<RuntimeDrainResult>();
          // Arbitration can wait on I/O, so another request may have started a drain meanwhile.
          // From this check to claiming the slot nothing yields.
          if (active !== undefined) return yield* join(active);
          // A dropped refresh never closes admission; the client keeps its attachment and retries.
          if (!admitted) return { status: "cancelled" as const, instanceId, forced: false };
          const drain: ActiveDrain = {
            status: "draining",
            result,
            targetVersion: input.targetVersion,
            deadline:
              now +
              Math.max(
                0,
                Math.min(
                  input.graceSeconds ?? RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
                  RUNTIME_DRAIN_MAX_GRACE_SECONDS,
                ),
              ) *
                1000,
            forced: input.force === true,
          };
          active = drain;
          yield* admission.beginDrain;
          yield* Effect.forkIn(run(drain), scope, { startImmediately: true });
          return yield* restore(Deferred.await(result));
        }),
      ),
  });
});

export const layer = Layer.effect(RuntimeDrain, make);
