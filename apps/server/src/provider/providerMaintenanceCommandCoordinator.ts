// @effect-diagnostics nodeBuiltinImport:off - Update leases coordinate Node server processes.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as KeyedLock from "@goat/shared/KeyedLock";
import { lock } from "proper-lockfile";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
}

class MachineLockError extends Schema.TaggedError<MachineLockError>()("MachineLockError", {
  held: Schema.Boolean,
  cause: Schema.Defect(),
}) {}

/** @internal */
export const machineLockFile = (lockKey: string, uid: number | undefined = process.getuid?.()) => {
  const owner = uid === undefined ? "" : `-${uid}`;
  const digest = NodeCrypto.createHash("sha256").update(lockKey).digest("hex").slice(0, 32);
  return NodePath.join(NodeOS.tmpdir(), `goat-provider-update${owner}-${digest}`);
};

const withMachineLock = <A, E, R>(
  lockKey: string,
  run: Effect.Effect<A, E, R>,
  makeLockError: () => E,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const compromised = yield* Deferred.make<never, E>();
      const services = yield* Effect.context<never>();
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(machineLockFile(lockKey), {
              realpath: false,
              stale: 60_000,
              update: 10_000,
              onCompromised: () =>
                Effect.runSyncWith(services)(Deferred.fail(compromised, makeLockError())),
            }),
          catch: (cause) =>
            new MachineLockError({
              held: (cause as { code?: unknown } | null)?.code === "ELOCKED",
              cause,
            }),
        }).pipe(
          Effect.retry({ while: (error) => error.held, schedule: Schedule.spaced("1 second") }),
          Effect.mapError(makeLockError),
        ),
        (release) => Effect.promise(() => release()).pipe(Effect.ignore),
      );
      return yield* Effect.raceFirst(run, Deferred.await(compromised));
    }),
  );

export const makeProviderMaintenanceCommandCoordinator = Effect.fn(
  "makeProviderMaintenanceCommandCoordinator",
)(function* <E>(input: {
  readonly makeAlreadyRunningError: (targetKey: string) => E;
  readonly makeLockError: () => E;
}) {
  const runningTargetsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const locks = yield* KeyedLock.make<string>();

  const acquireTarget = Effect.fn("acquireTarget")(function* (targetKey: string) {
    return yield* Ref.modify(runningTargetsRef, (runningTargets) => {
      if (runningTargets.has(targetKey)) {
        return [false, runningTargets] as const;
      }
      const next = new Set(runningTargets);
      next.add(targetKey);
      return [true, next] as const;
    });
  });

  const releaseTarget = (targetKey: string) =>
    Ref.update(runningTargetsRef, (runningTargets) => {
      const next = new Set(runningTargets);
      next.delete(targetKey);
      return next;
    });

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] =
    Effect.fn("providerMaintenanceCommandCoordinator.withCommandLock")(function* ({
      targetKey,
      lockKey,
      onQueued,
      run,
    }) {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      return yield* (onQueued ?? Effect.void).pipe(
        Effect.andThen(locks.withLock(lockKey, withMachineLock(lockKey, run, input.makeLockError))),
        Effect.ensuring(releaseTarget(targetKey)),
      );
    });

  return {
    withCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
