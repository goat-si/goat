import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const MAX_IN_FLIGHT = 2048;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export const makeShellDeltaLoads = Effect.fn("ShellDeltaLoads.make")(function* <A, E>() {
  const scope = yield* Effect.scope;
  const inFlight = new Map<number, Deferred.Deferred<A, E>>();
  // Replay sends later events after a cached delta when the projection changes again.
  const cache = new Map<number, { readonly value: A; readonly bytes: number }>();
  let cachedBytes = 0;
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      cache.clear();
      const pending = [...inFlight.values()];
      inFlight.clear();
      return pending;
    }).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending, (done) => Deferred.interrupt(done), { discard: true }),
      ),
    ),
  );

  const remember = (sequence: number, value: A) => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return;
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_CACHE_BYTES) return;
    cache.set(sequence, { value, bytes });
    cachedBytes += bytes;
    while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      const removed = cache.get(oldest);
      cache.delete(oldest);
      if (removed !== undefined) cachedBytes -= removed.bytes;
    }
  };

  const run = Effect.fn("ShellDeltaLoads.run")(function* <T extends { readonly sequence: number }>(
    events: ReadonlyArray<T>,
    load: (events: ReadonlyArray<T>) => Effect.Effect<ReadonlyArray<A>, E>,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.interrupt;
        const newCount = events.filter(
          (event) => !cache.has(event.sequence) && !inFlight.has(event.sequence),
        ).length;
        if (inFlight.size + newCount > MAX_IN_FLIGHT) return yield* restore(load(events));

        const owned: Array<{ readonly event: T; readonly done: Deferred.Deferred<A, E> }> = [];
        const slots = events.map((event) => {
          const cached = cache.get(event.sequence);
          if (cached !== undefined) return { cached: cached.value } as const;
          let done = inFlight.get(event.sequence);
          if (done === undefined) {
            done = Deferred.makeUnsafe<A, E>();
            inFlight.set(event.sequence, done);
            owned.push({ event, done });
          }
          return { done } as const;
        });
        if (owned.length > 0) {
          yield* Effect.suspend(() => load(owned.map(({ event }) => event))).pipe(
            Effect.flatMap((items) =>
              Effect.gen(function* () {
                if (items.length !== owned.length)
                  return yield* Effect.die("shell delta count mismatch");
                for (const [index, slot] of owned.entries()) {
                  const value = items[index] as A;
                  remember(slot.event.sequence, value);
                  if (inFlight.get(slot.event.sequence) === slot.done)
                    inFlight.delete(slot.event.sequence);
                  yield* Deferred.succeed(slot.done, value);
                }
              }),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.forEach(
                    owned,
                    ({ event, done }) => {
                      if (inFlight.get(event.sequence) === done) inFlight.delete(event.sequence);
                      return Deferred.done(done, Exit.failCause(exit.cause));
                    },
                    { discard: true },
                  )
                : Effect.void,
            ),
            Effect.forkIn(scope),
          );
        }
        return yield* restore(
          Effect.forEach(slots, (slot) =>
            "cached" in slot ? Effect.succeed(slot.cached) : Deferred.await(slot.done),
          ),
        );
      }),
    );
  });
  return { run };
});
