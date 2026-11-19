import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { PiRpcConnection, PiRpcRecord } from "./rpc.ts";
import type { startScopedPiConnection } from "./startConnection.ts";

type Started = Effect.Success<ReturnType<typeof startScopedPiConnection>>;
export const makeActivationRecovery = Effect.fnUntraced(function* (input: {
  initial: Started;
  initiallyAttached: boolean;
  start: () => ReturnType<typeof startScopedPiConnection>;
  stopped: () => boolean;
  cancelPrompts: (at: DateTime.Utc) => Effect.Effect<void>;
  onReplace: (started: Started) => void;
}) {
  let started = input.initial;
  let pending = input.initiallyAttached;
  let requested = false;
  const done = yield* Deferred.make<void>();
  const request = Effect.fnUntraced(function* (record: PiRpcRecord, timeoutMs: number) {
    if (!pending || requested) return yield* started.connection.request(record, timeoutMs);
    requested = true;
    return yield* started.connection.request(record, timeoutMs).pipe(
      Effect.catchTags({
        PiRpcError: Effect.fnUntraced(function* (error) {
          if (input.stopped() || (error.operation !== "read" && error.operation !== "write"))
            return yield* error;
          yield* Queue.fail(started.connection.events, error);
          yield* Scope.close(started.scope, Exit.void);
          yield* input.cancelPrompts(yield* DateTime.now);
          started = yield* input.start();
          input.onReplace(started);
          if (input.stopped()) {
            yield* started.connection.terminate;
            return yield* error;
          }
          return yield* started.connection.request(record, timeoutMs);
        }),
      }),
      Effect.ensuring(
        Effect.gen(function* () {
          pending = false;
          yield* Deferred.succeed(done, undefined);
        }),
      ),
    );
  });
  const readEvent = Effect.fnUntraced(function* (connection: PiRpcConnection) {
    return yield* Queue.take(connection.events).pipe(
      Effect.catchTags({
        PiRpcError: Effect.fnUntraced(function* (error) {
          if (pending) yield* Deferred.await(done);
          if (connection !== started.connection) return undefined;
          return yield* error;
        }),
      }),
    );
  });
  return { request, readEvent, isPending: () => pending };
});
