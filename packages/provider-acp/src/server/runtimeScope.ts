import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

/**
 * Forks the scope that holds an ACP runtime's resources, and makes the owner's release wait until
 * every finalizer of that scope has finished.
 *
 * A transport termination closes the runtime scope from a detached fiber. Effect marks a closing
 * scope closed and detaches it from its parent before running its finalizers, so a later close
 * returns at once. Without this barrier, an owner release could finish while the agent process is
 * still exiting and holding its cwd.
 */
export const forkRuntimeScope = Effect.fn("AcpSessionRuntime.forkRuntimeScope")(function* () {
  const owner = yield* Scope.Scope;
  const runtimeScope = yield* Scope.fork(owner);
  const finalized = yield* Deferred.make<void>();
  // Registered first, so it runs after every finalizer added later.
  yield* Scope.addFinalizer(runtimeScope, Deferred.succeed(finalized, undefined));
  yield* Scope.addFinalizerExit(owner, (exit) =>
    Scope.close(runtimeScope, exit).pipe(Effect.andThen(Deferred.await(finalized))),
  );
  return runtimeScope;
});
