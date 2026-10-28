import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

const decodeSignal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);

/** The client-chosen WebRTC session id carried by serve-sim offer and close requests. */
export const signalSessionId = (body: string) =>
  Option.map(decodeSignal(body), (signal) => signal.sessionId);

// A revoked peer keeps its slot and is retried, at most a minute apart, until the helper confirms.
const CLOSE_RETRY = Schedule.spaced("1 second").pipe(
  Schedule.modifyDelay(({ attempt }) =>
    Effect.succeed(Math.min(1000 * 2 ** Math.min(attempt - 1, 6), 60_000)),
  ),
);

// One client views a handful of devices; further offers wait until a peer closes.
const MAX_PEERS_PER_SESSION = 16;

interface Watcher {
  readonly owner: string;
  readonly fiber: Fiber.Fiber<void>;
}

/**
 * An established WebRTC peer streams without further GOAT requests, so each one is closed
 * upstream when the GOAT session that opened it loses authority. A successful client close
 * cancels the watch. Each session holds at most MAX_PEERS_PER_SESSION slots, counting offers
 * in flight; no watch is ever dropped to make room.
 */
export const make = (scope: Scope.Scope) => {
  const watchers = new Map<string, Watcher>();
  const slots = new Map<string, number>();
  const adjust = (owner: string, delta: number) => {
    const next = (slots.get(owner) ?? 0) + delta;
    if (next > 0) slots.set(owner, next);
    else slots.delete(owner);
  };
  const reserve = (owner: string) =>
    Effect.sync(() => {
      if ((slots.get(owner) ?? 0) >= MAX_PEERS_PER_SESSION) return false;
      adjust(owner, 1);
      return true;
    });
  const release = (owner: string) => Effect.sync(() => adjust(owner, -1));
  const closed = (key: string) =>
    Effect.suspend(() => {
      const watcher = watchers.get(key);
      if (!watcher) return Effect.void;
      watchers.delete(key);
      adjust(watcher.owner, -1);
      return Fiber.interrupt(watcher.fiber);
    });
  /** Turns a reserved slot into a watch on an accepted offer. */
  const opened = Effect.fn("DeviceWebRtcPeers.opened")(function* <E>(
    owner: string,
    key: string,
    ended: Effect.Effect<void>,
    closeUpstream: Effect.Effect<unknown, E>,
  ) {
    const registered = yield* Deferred.make<Fiber.Fiber<void>>();
    const fiber = yield* Deferred.await(registered).pipe(
      Effect.flatMap((self) =>
        ended.pipe(
          // The slot stays held until the helper confirms the close.
          Effect.andThen(
            closeUpstream.pipe(
              Effect.timeout("5 seconds"),
              Effect.tapError((cause) =>
                Effect.logWarning("Retrying the close of a revoked device WebRTC peer", { cause }),
              ),
              Effect.retry(CLOSE_RETRY),
              Effect.asVoid,
              Effect.catch((cause) =>
                Effect.logError("Could not close a revoked device WebRTC peer", { cause }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (watchers.get(key)?.fiber !== self) return;
              watchers.delete(key);
              adjust(owner, -1);
            }),
          ),
        ),
      ),
      Effect.forkIn(scope),
    );
    // A repeated offer for the same peer replaces its watch and frees the older slot.
    const previous = yield* Effect.sync(() => {
      const current = watchers.get(key);
      watchers.set(key, { owner, fiber });
      if (current) adjust(current.owner, -1);
      return current;
    });
    yield* Deferred.succeed(registered, fiber);
    if (previous) yield* Fiber.interrupt(previous.fiber);
  });
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  const serialize = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        locks.set(key, entry);
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users--;
          if (entry.users === 0) locks.delete(key);
        }),
    );
  return { reserve, release, opened, closed, serialize };
};
