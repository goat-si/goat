/**
 * Admissions of MCP requests on client sessions. Each request's admission is recorded inside the
 * verify that accepted it and lives until the request ends. A removal of the session's grant (a
 * revoke or a deleted row) marks every admission of that session, registered or not, and interrupts
 * the calls running under it, inside the removal itself. Expiry never cuts.
 */
import type { AuthSessionId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

export interface SessionEnd {
  /**
   * Runs work as a child fiber until it finishes, or none once the session's grant is removed. The
   * caller interrupting the run interrupts the work too.
   */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
  /** Ends the admission when its request ends. */
  readonly release: Effect.Effect<void>;
}

interface Admission {
  removed: boolean;
  readonly calls: Set<Fiber.Fiber<unknown, unknown>>;
}

export const make = () => {
  // One entry per request in flight; each request releases its own when it ends.
  const admissions = new Map<AuthSessionId, Set<Admission>>();

  /** Called by SessionStore right after it removed these grants for a revoke or a deleted row. */
  const cut = (sessionIds: ReadonlyArray<AuthSessionId>) =>
    Effect.sync(() => {
      for (const sessionId of sessionIds)
        for (const admission of admissions.get(sessionId) ?? []) {
          admission.removed = true;
          for (const fiber of admission.calls) fiber.interruptUnsafe();
        }
    });

  /** Records a request's admission; `markRemoved` is for a removal the verify fence saw first. */
  const admit = (sessionId: AuthSessionId) => {
    const admission: Admission = { removed: false, calls: new Set() };
    admissions.set(sessionId, (admissions.get(sessionId) ?? new Set()).add(admission));
    const sessionEnd: SessionEnd = {
      release: Effect.sync(() => {
        const current = admissions.get(sessionId);
        current?.delete(admission);
        if (current?.size === 0) admissions.delete(sessionId);
      }),
      // Untraced: it wraps every MCP tool call, which already has its own span.
      run: Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(effect);
            // Added before the mark is read: a removal either finds this call or already marked it.
            admission.calls.add(fiber);
            return yield* Effect.gen(function* () {
              const exit = admission.removed
                ? undefined
                : yield* restore(Fiber.await(fiber)).pipe(
                    Effect.onInterrupt(() => Fiber.interrupt(fiber)),
                  );
              if (exit === undefined) {
                yield* Fiber.interrupt(fiber);
                return Option.none();
              }
              if (admission.removed && exit._tag === "Failure" && Cause.hasInterrupts(exit.cause))
                return Option.none();
              return Option.some(yield* exit);
            }).pipe(Effect.ensuring(Effect.sync(() => admission.calls.delete(fiber))));
          }),
        );
      }),
    };
    return {
      sessionEnd,
      markRemoved: () => {
        admission.removed = true;
      },
    };
  };

  /** Admissions held now; for diagnostics and tests. */
  const inFlight = Effect.sync(() => {
    let count = 0;
    for (const current of admissions.values()) count += current.size;
    return count;
  });

  return { cut, admit, inFlight };
};
