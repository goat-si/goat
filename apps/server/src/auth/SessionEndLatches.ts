/**
 * Calls running on an MCP client session's authority, cut when SessionStore removes the session's
 * live grant (a revoke or a deleted row). The cut runs inside that removal, so it has interrupted
 * every such call before it returns. Expiry never cuts: a call admitted before it runs to its end.
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
  /** Whether the session's grant was removed (revoked or its row deleted). */
  readonly ended: Effect.Effect<boolean>;
}

interface Guarded {
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  cut: boolean;
}

/** Sessions removed before their call registered; the window is one request's verify. */
const REMEMBERED_REMOVALS = 10_000;

export const make = () => {
  // One entry per call in flight; each call removes its own entry when it ends.
  const guarded = new Map<AuthSessionId, Set<Guarded>>();
  // Insertion-ordered and capped: a call registers right after its request verified the session.
  const removed = new Set<AuthSessionId>();
  const isRemoved = (sessionId: AuthSessionId) => Effect.sync(() => removed.has(sessionId));

  /** Called by SessionStore right after it removed these grants. */
  const cut = (sessionIds: ReadonlyArray<AuthSessionId>) =>
    Effect.sync(() => {
      for (const sessionId of sessionIds) {
        removed.delete(sessionId);
        removed.add(sessionId);
        const oldest = removed.values().next();
        if (removed.size > REMEMBERED_REMOVALS && !oldest.done) removed.delete(oldest.value);
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
    ended: isRemoved(sessionId),
    // Untraced: it wraps every MCP tool call, which already has its own span.
    run: Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(effect);
          const call: Guarded = { fiber, cut: false };
          // Registered before removals are read: a removal either finds this call or is remembered.
          guarded.set(sessionId, (guarded.get(sessionId) ?? new Set()).add(call));
          return yield* Effect.gen(function* () {
            const exit = (yield* isRemoved(sessionId))
              ? undefined
              : yield* restore(Fiber.await(fiber)).pipe(
                  Effect.onInterrupt(() => Fiber.interrupt(fiber)),
                );
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
      );
    }),
  });

  return { cut, sessionEnd };
};
