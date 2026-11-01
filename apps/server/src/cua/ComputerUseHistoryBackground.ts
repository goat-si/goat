import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

const pending = new Map<string, Deferred.Deferred<void>>();
const tickets = new Map<string, { readonly threadId: string; readonly controlId: string }>();
const MAX_TICKETS = 10_000;

export const registerHistoryTicket = (id: string, threadId: string, controlId: string) =>
  Effect.sync(() => {
    if (tickets.size >= MAX_TICKETS) {
      const oldest = tickets.keys().next().value;
      if (oldest !== undefined) tickets.delete(oldest);
    }
    tickets.set(id, { threadId, controlId });
  });

export const claimHistoryTicket = (id: string, threadId: string, controlId: string) =>
  Effect.sync(() => {
    const ticket = tickets.get(id);
    if (ticket?.threadId !== threadId || ticket.controlId !== controlId) return false;
    tickets.delete(id);
    return true;
  });

export const settlementHistoryKey = (ticket: string) => `settlement:${ticket}`;
export const refusalHistoryKey = (
  threadId: string,
  controlId: string,
  connectionId: string,
  callId: string,
) => JSON.stringify([threadId, controlId, connectionId, callId]);

export const scheduleHistory = Effect.fn("ComputerUseHistory.schedule")(function* <E, R>(
  key: string | undefined,
  write: Effect.Effect<void, E, R>,
  scope?: Scope.Scope,
) {
  const done = yield* Deferred.make<void>();
  if (key !== undefined) pending.set(key, done);
  const task = write.pipe(
    Effect.interruptible,
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.logWarning("Computer use history write timed out")
        : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logWarning("Computer use history write failed", { cause })),
  );
  const fiber =
    scope === undefined ? yield* Effect.forkDetach(task) : yield* Effect.forkIn(task, scope);
  yield* Fiber.await(fiber).pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (key !== undefined && pending.get(key) === done) pending.delete(key);
      }),
    ),
    Effect.andThen(Deferred.succeed(done, undefined)),
    Effect.asVoid,
    Effect.forkDetach,
  );
});

export const awaitHistory = (key: string) =>
  Effect.suspend(() => {
    const write = pending.get(key);
    return write === undefined ? Effect.void : Deferred.await(write);
  });

export const awaitHistoryPrefix = (prefix: string) =>
  Effect.suspend(() =>
    Effect.forEach(
      [...pending.entries()].filter(([key]) => key.startsWith(prefix)),
      ([, write]) => Deferred.await(write),
      { discard: true, concurrency: "unbounded" },
    ),
  );
