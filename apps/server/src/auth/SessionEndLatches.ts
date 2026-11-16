/**
 * Calls running on an MCP client session's authority, cut when SessionStore removes the session's
 * live grant. The cut runs inside that removal, so a revoke has interrupted every such call before
 * it returns, whichever path removed the grant.
 */
import type { AuthSessionId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

export interface SessionEnd {
  /**
   * Runs work as a child fiber until it finishes, or none once the session ends: revoked, removed
   * or expired. The caller interrupting the run interrupts the work too.
   */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
  /** Whether the session's live grant is gone, read from memory. */
  readonly ended: Effect.Effect<boolean>;
}

interface Guarded {
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  cut: boolean;
}

/** `expiresAt` reads the live grant's deadline; undefined once the grant is gone. */
export const make = (
  expiresAt: (sessionId: AuthSessionId) => Effect.Effect<number | undefined>,
) => {
  // One entry per call in flight; each call removes its own entry when it ends.
  const guarded = new Map<AuthSessionId, Set<Guarded>>();
  const remaining = (sessionId: AuthSessionId) =>
    Effect.flatMap(expiresAt(sessionId), (at) =>
      at === undefined ? Effect.succeed(0) : Effect.map(Clock.currentTimeMillis, (now) => at - now),
    );

  /** Called by SessionStore right after it removed these grants. */
  const cut = (sessionIds: ReadonlyArray<AuthSessionId>) =>
    Effect.sync(() => {
      for (const sessionId of sessionIds) {
        const calls = guarded.get(sessionId);
        if (calls === undefined) continue;
        guarded.delete(sessionId);
        for (const call of calls) {
          call.cut = true;
          call.fiber.interruptUnsafe();
        }
      }
    });

  const sessionEnd = (sessionId: AuthSessionId): SessionEnd => ({
    ended: Effect.map(remaining(sessionId), (left) => left <= 0),
    run: (effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(effect);
          const call: Guarded = { fiber, cut: false };
          // Registered before the grant is read: a removal either finds this call or left no grant.
          guarded.set(sessionId, (guarded.get(sessionId) ?? new Set()).add(call));
          return yield* Effect.gen(function* () {
            const left = yield* remaining(sessionId);
            const exit =
              left <= 0
                ? undefined
                : yield* restore(
                    Fiber.await(fiber).pipe(
                      Effect.raceFirst(Effect.as(Effect.sleep(Duration.millis(left)), undefined)),
                    ),
                  ).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
            if (exit === undefined) {
              call.cut = true;
              yield* Fiber.interrupt(fiber);
              return Option.none();
            }
            if (call.cut && exit._tag === "Failure" && Cause.hasInterrupts(exit.cause))
              return Option.none();
            return Option.some(yield* exit);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const calls = guarded.get(sessionId);
                calls?.delete(call);
                if (calls?.size === 0) guarded.delete(sessionId);
              }),
            ),
          );
        }),
      ),
  });

  return { cut, sessionEnd };
};
