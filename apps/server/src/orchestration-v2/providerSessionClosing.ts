import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export type Signal = Deferred.Deferred<void>;

export const make = Effect.fn("ProviderSessionManager.makeSessionClosing")(function* (
  scopes: Scope.Scope,
) {
  const sessionScope = yield* Scope.fork(scopes);
  const sessionClosed = yield* Deferred.make<void>();
  yield* Scope.addFinalizer(sessionScope, Deferred.done(sessionClosed, Exit.void));
  return { sessionScope, sessionClosed };
});

export const interrupt = <A, E, R>(events: Stream.Stream<A, E, R>, closed: Signal) =>
  events.pipe(Stream.interruptWhen(Deferred.await(closed)));
