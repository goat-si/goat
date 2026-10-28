import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

const SERVER_EXIT_CODE_FATAL_PERSISTENCE = 80;

export class FatalPersistenceError extends Schema.TaggedError<FatalPersistenceError>()(
  "FatalPersistenceError",
  { cause: Schema.Defect() },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_FATAL_PERSISTENCE;

  override get message() {
    return "Server persistence failed permanently. Commands are disabled; reconnect after the server restarts.";
  }
}

export const isFatalPersistenceError = Schema.is(FatalPersistenceError);

interface Owner {
  readonly report: (cause: unknown) => void;
  readonly check: Effect.Effect<void, FatalPersistenceError>;
  readonly awaitFailure: Effect.Effect<FatalPersistenceError>;
}

export class PersistenceRecoveryOwner extends Context.Reference<Owner | undefined>(
  "goat/persistence/PersistenceRecoveryOwner",
  { defaultValue: () => undefined },
) {}

interface ExitBoundary {
  readonly armHardExit: (expire: () => void) => void;
  readonly exit: (code: number) => void;
}

const processBoundary: ExitBoundary = {
  armHardExit: (expire) => {
    // This alarm must survive an uninterruptible application finalizer.
    // @effect-diagnostics-next-line globalTimers:off -- independent of closing Effect scopes.
    setTimeout(expire, 5_000);
  },
  exit: (code) => process.exit(code),
};

export const run = Effect.fn("PersistenceRecoveryOwner.run")(function* <A, E, R>(
  application: Effect.Effect<A, E, R>,
  boundary: ExitBoundary = processBoundary,
) {
  const failed = yield* Deferred.make<FatalPersistenceError>();
  let failure: FatalPersistenceError | undefined;
  const owner: Owner = {
    report: (cause) => {
      if (failure !== undefined) return;
      failure = new FatalPersistenceError({ cause });
      boundary.armHardExit(() => boundary.exit(SERVER_EXIT_CODE_FATAL_PERSISTENCE));
      Deferred.doneUnsafe(failed, Effect.succeed(failure));
    },
    check: Effect.suspend(() => (failure === undefined ? Effect.void : Effect.fail(failure))),
    awaitFailure: Deferred.await(failed),
  };
  const fatal = owner.awaitFailure.pipe(
    Effect.tap(() =>
      Effect.logFatal(
        "Server persistence failed permanently; disabling commands and exiting 80. No uncertain operation will be replayed.",
      ),
    ),
    Effect.flatMap(Effect.fail),
  );
  return yield* Effect.raceFirst(Effect.scoped(application), fatal).pipe(
    Effect.provideService(PersistenceRecoveryOwner, owner),
    Effect.ensuring(
      Effect.sync(() => {
        // Scope closure cannot confirm native provider retirement, so never reconstruct here.
        if (failure !== undefined) boundary.exit(SERVER_EXIT_CODE_FATAL_PERSISTENCE);
      }),
    ),
  );
});
