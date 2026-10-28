import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
export const makeDesktopControlWriter = Effect.fn("DesktopControlWriter.make")(function* <
  E,
>(options: {
  readonly write: (payload: Buffer) => Effect.Effect<void, E>;
  readonly overflow: () => E;
}) {
  const wake = yield* Queue.bounded<void>(1);
  const pending: Array<{
    payload: Buffer;
    key: string | undefined;
    waiters: Array<Deferred.Deferred<void, E>>;
  }> = [];
  let bytes = 0;
  let count = 0;
  let active = false;
  let executing: (typeof pending)[number] | undefined;
  let closed = false;
  const stop = Effect.gen(function* () {
    closed = true;
    if (executing)
      for (const waiter of executing.waiters) yield* Deferred.fail(waiter, options.overflow());
    for (const item of pending.splice(0)) {
      bytes -= item.payload.byteLength;
      count -= item.waiters.length;
      for (const waiter of item.waiters) yield* Deferred.fail(waiter, options.overflow());
    }
  });
  yield* Queue.take(wake).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const item = pending.shift();
        if (!item) return Effect.void;
        active = true;
        executing = item;
        return options.write(item.payload).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              active = false;
              executing = undefined;
              bytes -= item.payload.byteLength;
              count -= item.waiters.length;
              for (const waiter of item.waiters) yield* Deferred.done(waiter, exit);
              if (Exit.isFailure(exit)) yield* stop;
              if (pending.length > 0) Queue.offerUnsafe(wake, undefined);
            }),
          ),
        );
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  // Close admission before the scoped fiber is interrupted; a partial native frame is never reused.
  yield* Effect.addFinalizer(() => stop);
  const send = Effect.fn("DesktopControlWriter.send")(function* (payload: Buffer, key?: string) {
    const index = key === undefined ? -1 : pending.findIndex((item) => item.key === key);
    const previous = index < 0 ? undefined : pending[index];
    if (
      closed ||
      count >= 32 ||
      bytes - (previous?.payload.byteLength ?? 0) + payload.byteLength > 65536
    ) {
      yield* stop;
      return yield* Effect.fail(options.overflow());
    }
    const done = yield* Deferred.make<void, E>();
    count++;
    bytes += payload.byteLength - (previous?.payload.byteLength ?? 0);
    if (previous) {
      previous.payload = payload;
      previous.waiters.push(done);
    } else pending.push({ payload, key, waiters: [done] });
    Queue.offerUnsafe(wake, undefined);
    return yield* Deferred.await(done);
  });
  return { send, state: Effect.sync(() => ({ frames: count, bytes, active, closed })) };
});
