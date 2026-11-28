import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { isLoopbackEntry } from "./loopbackHost.ts";
import { connectionRoutes } from "./routes.ts";

/** Environments reached directly, such as the Home server, set up before HubProxy-only ones. */
export type EstablishmentPriority = "direct" | "proxied";

export type Admission<A> =
  | { readonly _tag: "Admitted"; readonly release: Effect.Effect<void> }
  | { readonly _tag: "Withdrawn"; readonly value: A };

/**
 * Waits for a connection setup slot, or for `whileQueued` to end the wait first. The slot is held
 * until `release`, the end of the scope, or the hold limit, so a host that never answers delays
 * the queue by the hold limit at most.
 */
export type EstablishmentSlot = <A, R>(
  whileQueued: Effect.Effect<A, never, R>,
) => Effect.Effect<Admission<A>, never, R | Scope.Scope>;

/** For a supervisor without a queue: every setup starts at once. */
export const admitAtOnce: EstablishmentSlot = <A>() =>
  Effect.succeed<Admission<A>>({ _tag: "Admitted", release: Effect.void });

interface Waiter {
  readonly rank: number;
  readonly admitted: Deferred.Deferred<void>;
}

const RANK: Record<EstablishmentPriority, number> = { direct: 0, proxied: 1 };

export function makeEstablishmentGate(options: {
  readonly slots: number;
  readonly holdLimit: Duration.Input;
}): (priority: EstablishmentPriority) => EstablishmentSlot {
  let available = options.slots;
  const waiters: Array<Waiter> = [];

  // A freed slot passes straight to the next waiter, so `available` is positive only while
  // nobody waits.
  const freeSlot = () => {
    const next = waiters.shift();
    if (next === undefined) available += 1;
    else Deferred.doneUnsafe(next.admitted, Effect.void);
  };
  const withdraw = (waiter: Waiter) =>
    Effect.sync(() => {
      const index = waiters.indexOf(waiter);
      if (index === -1) freeSlot();
      else waiters.splice(index, 1);
    });

  const acquire = <A, R>(
    priority: EstablishmentPriority,
    whileQueued: Effect.Effect<A, never, R>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (available > 0) {
          available -= 1;
        } else {
          const waiter: Waiter = { rank: RANK[priority], admitted: Deferred.makeUnsafe() };
          const after = waiters.findIndex((queued) => queued.rank > waiter.rank);
          waiters.splice(after === -1 ? waiters.length : after, 0, waiter);
          const outcome = yield* restore(
            Effect.raceFirst(
              Deferred.await(waiter.admitted).pipe(Effect.as<Admission<A> | null>(null)),
              whileQueued.pipe(Effect.map((value): Admission<A> => ({ _tag: "Withdrawn", value }))),
            ),
          ).pipe(Effect.onInterrupt(() => withdraw(waiter)));
          if (outcome !== null) {
            yield* withdraw(waiter);
            return outcome;
          }
        }
        let held = true;
        const release = Effect.sync(() => {
          if (!held) return;
          held = false;
          freeSlot();
        });
        yield* Effect.addFinalizer(() => release);
        return { _tag: "Admitted", release } satisfies Admission<A>;
      }),
    );

  return (priority) => (whileQueued) =>
    acquire(priority, whileQueued).pipe(
      Effect.tap((admission) =>
        admission._tag === "Admitted"
          ? Effect.sleep(options.holdLimit).pipe(
              Effect.andThen(admission.release),
              Effect.forkScoped,
            )
          : Effect.void,
      ),
    );
}

// Dozens of discovered HubProxy nodes would otherwise all set up at once through the Home server.
const ENVIRONMENT_SLOTS = { slots: 4, holdLimit: "5 seconds" } as const;

/** One registry's setup queue. The primary and loopback servers never wait in it. */
export function makeEnvironmentEstablishmentSlots() {
  const slot = makeEstablishmentGate(ENVIRONMENT_SLOTS);
  return (entry: ConnectionCatalogEntry): EstablishmentSlot | undefined => {
    if (entry.target._tag === "PrimaryConnectionTarget" || isLoopbackEntry(entry)) return undefined;
    const proxied = connectionRoutes(entry).every(
      (route) => route.target._tag === "HubProxyConnectionTarget",
    );
    return slot(proxied ? "proxied" : "direct");
  };
}
