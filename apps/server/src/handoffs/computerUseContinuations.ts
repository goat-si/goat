/**
 * A computer use request whose call is waiting in its turn owns the person's answer: the wake
 * reactor sends nothing for it while the call owns it. When the call returns an answer that came
 * in while it owned the request, it records that durably, so no later reconcile wakes the thread
 * for it; if the call then fails or is interrupted, it removes that record again and the reactor
 * delivers the wake it never sent. Until that removal succeeds, the answer stays given back in
 * memory, so a store that cannot remove the record right then does not keep the thread asleep.
 * Ownership, answers, expiry and wake delivery all run under the Handoffs lock.
 *
 * @module computerUseContinuations
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type Handoff,
  type HandoffError,
  type HandoffReadInput,
  isHandoffPending,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import type * as Semaphore from "effect/Semaphore";

export const CONSUMED = { version: 1, kind: "computer_use_consumed" } as const;
// A person's Stop after approving; it keeps the reactor quiet, so no call's record replaces it.
const ENDED = "computer_use_ended";

export interface ComputerUseAnswer {
  readonly handoff: Handoff;
  /** The asking turn can still act on this answer; when false, a later turn gets it. */
  readonly usable: boolean;
}

type E = HandoffError;

const logged = (message: string, handoffId: string) =>
  Effect.catchCause((cause: unknown) => Effect.logWarning(message, { handoffId, cause }));

export const makeComputerUseContinuations = Effect.fn("Handoffs.computerUseContinuations")(
  function* (deps: {
    readonly lock: Semaphore.Semaphore;
    readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, E>;
    readonly expire: (input: HandoffReadInput) => Effect.Effect<Handoff, E>;
    readonly cancelAsAgent: (input: HandoffReadInput) => Effect.Effect<Handoff, E>;
    /** The kind of the request's private record, if it has one. */
    readonly recordKind: (handoffId: string) => Effect.Effect<string | null | undefined, E>;
    readonly markConsumed: (handoffId: string) => Effect.Effect<void, E>;
    readonly removeRecord: (handoffId: string) => Effect.Effect<void, E>;
  }) {
    const answers = yield* PubSub.unbounded<string>();
    const owners = new Map<string, number>();
    // Answers a failed call recorded and gave back; their record no longer stops a wake.
    const givenBack = new Set<string>();
    const locked = deps.lock.withPermits(1);
    const consumed = (id: string) =>
      deps.recordKind(id).pipe(Effect.map((kind) => kind === CONSUMED.kind));
    /** False when a person's Stop is already on record: that record stays. */
    const markConsumed = Effect.fn("Handoffs.markComputerUseConsumed")(function* (id: string) {
      if ((yield* deps.recordKind(id)) === ENDED) return false;
      yield* deps.markConsumed(id);
      return true;
    });
    /** Removes only this call's record; a Stop recorded since then stays. */
    const clearConsumed = Effect.fn("Handoffs.clearComputerUseConsumed")(function* (id: string) {
      if (yield* consumed(id)) yield* deps.removeRecord(id);
    });

    /**
     * Waits until a person answers the request, it expires, or `until`. `settle` judges, under
     * the lock, whether the asking turn can still use an answer. A request still pending at
     * `until` stays open and wakes the thread when answered.
     */
    const awaitAnswer = Effect.fn("Handoffs.awaitComputerUseAnswer")(function* (
      input: HandoffReadInput & { readonly until: DateTime.Utc },
      settle: (handoff: Handoff) => Effect.Effect<boolean, E>,
    ) {
      // Subscribed before ownership, so an answer after it is never missed.
      const subscription = yield* PubSub.subscribe(answers);
      let held = false;
      let recorded = false;
      // Only an answer that came in while this call owned the request was never woken for.
      let ownedWhilePending = false;
      const release = () => {
        if (!held) return;
        held = false;
        const left = (owners.get(input.handoffId) ?? 1) - 1;
        if (left > 0) owners.set(input.handoffId, left);
        else owners.delete(input.handoffId);
      };
      const finish = Effect.fn("Handoffs.finishComputerUseAnswer")(function* (handoff: Handoff) {
        release();
        const usable = yield* settle(handoff);
        if (usable && ownedWhilePending)
          recorded = yield* markConsumed(input.handoffId).pipe(
            logged("an answered computer use request was not recorded", input.handoffId),
            Effect.map((done) => done === true),
          );
        return { handoff, usable } satisfies ComputerUseAnswer;
      });
      return yield* Effect.gen(function* () {
        // Inside the exit handler, so a call stopped or failing here still gives ownership up.
        yield* locked(
          Effect.gen(function* () {
            owners.set(input.handoffId, (owners.get(input.handoffId) ?? 0) + 1);
            held = true;
            ownedWhilePending = isHandoffPending((yield* deps.read(input)).state);
          }),
        );
        for (;;) {
          const step = yield* locked(
            Effect.gen(function* () {
              let handoff = yield* deps.read(input);
              const now = yield* DateTime.now;
              if (
                isHandoffPending(handoff.state) &&
                handoff.expiresAt !== null &&
                DateTime.toEpochMillis(handoff.expiresAt) <= DateTime.toEpochMillis(now)
              )
                handoff = yield* deps.expire(input);
              if (!isHandoffPending(handoff.state)) return { done: yield* finish(handoff) };
              if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(input.until)) {
                release();
                return { done: { handoff, usable: false } satisfies ComputerUseAnswer };
              }
              const wakeAt = Math.min(
                DateTime.toEpochMillis(input.until),
                handoff.expiresAt === null ? Infinity : DateTime.toEpochMillis(handoff.expiresAt),
              );
              return { wait: wakeAt - DateTime.toEpochMillis(now) };
            }).pipe(Effect.uninterruptible),
          );
          if ("done" in step) return step.done;
          yield* Effect.race(
            PubSub.take(subscription).pipe(
              Effect.repeat({ until: (id) => id === input.handoffId }),
              Effect.asVoid,
            ),
            Effect.sleep(step.wait),
          );
        }
      }).pipe(
        // A call that does not return its answer gives it back: the reactor wakes for it.
        Effect.onExit((exit) =>
          locked(
            Effect.gen(function* () {
              release();
              if (!recorded || Exit.isSuccess(exit)) return;
              givenBack.add(input.handoffId);
              yield* clearConsumed(input.handoffId).pipe(
                Effect.tap(() => Effect.sync(() => givenBack.delete(input.handoffId))),
                logged("a computer use answer record could not be removed", input.handoffId),
              );
            }),
          ),
        ),
      );
    }, Effect.scoped);

    return {
      awaitAnswer,
      /** Signals waiting calls that a request may have been answered. */
      answered: (handoffId: string) => PubSub.publish(answers, handoffId).pipe(Effect.asVoid),
      /** Sends a computer use wake only when no call owns or already returned the answer. */
      deliverWake: <E2>(handoff: Handoff, dispatch: Effect.Effect<boolean, E2>) =>
        locked(
          Effect.gen(function* () {
            if (owners.has(handoff.handoffId)) return;
            const returned =
              !givenBack.has(handoff.handoffId) && (yield* consumed(handoff.handoffId));
            if (returned) return;
            // Once sent, the wake's own message stops any further one.
            if (yield* dispatch) givenBack.delete(handoff.handoffId);
          }),
        ),
      /** A person ended the request; its given-back answer no longer needs a wake. */
      forget: (handoffId: string) => Effect.sync(() => void givenBack.delete(handoffId)),
      /**
       * A newer, different request replaces the thread's other pending ones, ended by the agent so
       * nothing wakes; their waiting calls report it. Runs inside create, under the lock.
       */
      supersede: Effect.fn("Handoffs.supersedeComputerUse")(function* (
        threadId: ThreadId,
        pending: ReadonlyArray<Handoff>,
        keep: string,
      ) {
        for (const handoff of pending) {
          if (handoff.handoffId === keep || handoff.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH)
            continue;
          yield* deps.cancelAsAgent({ threadId, handoffId: handoff.handoffId });
          yield* PubSub.publish(answers, handoff.handoffId);
        }
      }),
    };
  },
);
