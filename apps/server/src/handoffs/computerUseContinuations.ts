/**
 * A computer use request whose call is still waiting in its turn owns the person's answer:
 * the wake reactor delivers nothing for it, and once the call returns the answer it records that
 * durably and withdraws any wake already sent. Every step that reads or changes that ownership
 * runs under the Handoffs lock, so a wake is either sent before the call takes the answer (and
 * withdrawn by it) or never sent.
 *
 * @module computerUseContinuations
 */
import {
  CommandId,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type Handoff,
  type HandoffReadInput,
  isHandoffPending,
  MessageId,
  type ThreadId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- withdrawal command ids are random.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Semaphore from "effect/Semaphore";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const CONSUMED = { version: 1, kind: "computer_use_consumed" } as const;
const RESOLVED = ["completed", "declined", "cancelled", "expired"] as const;

export interface ComputerUseAnswer {
  readonly handoff: Handoff;
  /** The call returned this answer in its turn; no wake follows. */
  readonly consumed: boolean;
}

export const makeComputerUseContinuations = <E>(deps: {
  readonly lock: Semaphore.Semaphore;
  readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, E>;
  readonly expire: (input: HandoffReadInput) => Effect.Effect<Handoff, E>;
  readonly cancelAsAgent: (input: HandoffReadInput) => Effect.Effect<Handoff, E>;
  readonly consumed: (handoffId: string) => Effect.Effect<boolean, E>;
  readonly markConsumed: (handoffId: string) => Effect.Effect<void, E>;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly unavailable: (cause: unknown) => E;
}) =>
  Effect.gen(function* () {
    const answers = yield* PubSub.unbounded<string>();
    const owners = new Map<string, number>();
    const own = (id: string) => owners.set(id, (owners.get(id) ?? 0) + 1);
    const release = (id: string) => {
      const left = (owners.get(id) ?? 1) - 1;
      if (left > 0) owners.set(id, left);
      else owners.delete(id);
    };
    const locked = deps.lock.withPermits(1);

    /** Cancels a wake the reactor already sent, while it has not started acting. */
    const withdraw = Effect.fn("Handoffs.withdrawAnsweredWake")(function* (
      input: HandoffReadInput,
    ) {
      const wakes = new Set(
        RESOLVED.map((state) => MessageId.make(`message:handoff-wake:${input.handoffId}:${state}`)),
      );
      const records = yield* deps.threads
        .getThreadRecords(input.threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
        .pipe(Effect.mapError(deps.unavailable));
      for (const run of records.runs) {
        if (!wakes.has(run.userMessageId)) continue;
        const commandId = CommandId.make(
          `handoff:${input.handoffId}:answered-in-turn:${NodeCrypto.randomUUID()}`,
        );
        if (run.status === "queued")
          yield* deps.threads
            .dispatch({
              type: "queued-run.cancel",
              commandId,
              threadId: input.threadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(deps.unavailable));
        else if (run.status === "preparing" || run.status === "starting")
          yield* deps.threads
            .dispatch({
              type: "run.interrupt",
              commandId,
              threadId: input.threadId,
              runId: run.id,
              reason: "The turn that asked already received this answer.",
            })
            .pipe(Effect.mapError(deps.unavailable));
      }
    });

    /** Takes the answer for the call when `settle` says its turn can still use it. */
    const finish = (input: HandoffReadInput, handoff: Handoff, settle: Effect.Effect<boolean, E>) =>
      Effect.gen(function* () {
        const consumed = yield* settle;
        if (consumed) {
          yield* deps.markConsumed(input.handoffId);
          yield* withdraw(input);
        }
        return { handoff, consumed } satisfies ComputerUseAnswer;
      });

    /**
     * Waits until a person answers the request, it expires, or `until`. `settle` judges, under
     * the lock, whether the asking turn can still use an answer: only then is it consumed. A
     * request still pending at `until` stays open and wakes the thread when answered.
     */
    const awaitAnswer = Effect.fn("Handoffs.awaitComputerUseAnswer")(function* (
      input: HandoffReadInput & { readonly until: DateTime.Utc },
      settle: (handoff: Handoff) => Effect.Effect<boolean, E>,
    ) {
      // Subscribed before the first read, so an answer between them is not missed.
      const subscription = yield* PubSub.subscribe(answers);
      let held = false;
      const releaseOnce = () => {
        if (held) release(input.handoffId);
        held = false;
      };
      yield* locked(
        Effect.sync(() => {
          own(input.handoffId);
          held = true;
        }),
      );
      return yield* Effect.gen(function* () {
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
              if (!isHandoffPending(handoff.state)) {
                releaseOnce();
                return { done: yield* finish(input, handoff, settle(handoff)) };
              }
              if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(input.until)) {
                releaseOnce();
                return { done: { handoff, consumed: false } satisfies ComputerUseAnswer };
              }
              const wakeAt = Math.min(
                DateTime.toEpochMillis(input.until),
                handoff.expiresAt === null ? Infinity : DateTime.toEpochMillis(handoff.expiresAt),
              );
              return { wait: wakeAt - DateTime.toEpochMillis(now) };
            }),
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
        // A call that stops waiting (its turn was stopped) leaves the answer to the reactor.
        Effect.onExit(() => locked(Effect.sync(releaseOnce))),
      );
    }, Effect.scoped);

    return {
      awaitAnswer,
      /** Signals waiting calls that a request may have been answered. */
      answered: (handoffId: string) => PubSub.publish(answers, handoffId).pipe(Effect.asVoid),
      /** Sends a computer use wake only when no call owns or already returned the answer. */
      deliverWake: <A, E2>(handoff: Handoff, dispatch: Effect.Effect<A, E2>) =>
        locked(
          Effect.gen(function* () {
            if (owners.has(handoff.handoffId)) return;
            if (yield* deps.consumed(handoff.handoffId)) return;
            yield* dispatch;
          }),
        ),
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
  });
