import {
  CommandId,
  type OrchestrationV2ProviderFailure,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ThreadManagement from "../ThreadManagementService.ts";
import { CommitGuard, CommitGuardRefused, type CommitGuardSelector } from "./CommitGuard.ts";
import type { PreparationClaims } from "./PreparationClaims.ts";

/**
 * A run's generation: the highest sequence of its run.created and run.updated events, the only
 * events that change its status, so it moves on every transition into or out of "preparing". Binds
 * thread, before, run. The WHERE repeats the partial index's condition; INDEXED BY fails if it moves.
 */
export const generationOf = (thread: string, before: string, run: string) => `
    SELECT event.sequence FROM orchestration_events AS event
      INDEXED BY idx_orchestration_events_agent_stream_sequence
    WHERE event.application_event_version = 2 AND event.aggregate_kind = 'thread'
      AND event.stream_id = ${thread} AND event.sequence < ${before}
      AND event.event_type IN ('run.created', 'run.updated')
      AND json_extract(event.payload_json, '$.id') = ${run}
    ORDER BY event.sequence DESC LIMIT 1`;

export const STRETCH_CHANGED = "preparation-stretch-changed";
export const OWNED = "preparation-owned";
const GENERATION_UNREADABLE = "preparation-generation-unreadable";

type Threads = ThreadManagement.ThreadManagementService["Service"];
type Claims = PreparationClaims["Service"];
type FailCommand = Extract<
  Parameters<Threads["dispatch"]>[0],
  { readonly type: "prepared-run.fail" }
>;

/**
 * Commits the fail only if, inside its own transaction, the run's generation before the fail's
 * events still equals the one the sender read, and, with `unlessOwned`, nothing owns the run.
 * Other commands keep the guard this fiber inherited.
 */
const guardFor =
  (
    claims: Claims,
    fail: FailCommand,
    expected: { readonly generation: number; readonly unlessOwned: boolean },
    inherited: CommitGuardSelector | undefined,
  ): CommitGuardSelector =>
  (command) => {
    if (command.commandId !== fail.commandId || command.commandType !== "prepared-run.fail")
      return inherited?.(command);
    return (storedEvents) =>
      Effect.gen(function* () {
        const first = storedEvents[0];
        // No events: nothing is failed here, so only the inherited guard has a say.
        if (first === undefined) return yield* inherited?.(command)?.(storedEvents) ?? Effect.void;
        const now = yield* claims
          .generation(fail.threadId, fail.runId, first.sequence)
          .pipe(Effect.mapError(() => new CommitGuardRefused({ reason: GENERATION_UNREADABLE })));
        if (now !== expected.generation)
          return yield* new CommitGuardRefused({ reason: STRETCH_CHANGED });
        if (expected.unlessOwned && (yield* claims.isOwned(fail.threadId, fail.runId)))
          return yield* new CommitGuardRefused({ reason: OWNED });
      });
  };

/** Dispatches a prepared-run.fail that commits only for the stretch the sender read. */
export const dispatchGuardedFail = Effect.fn("PreparationStretch.dispatchGuardedFail")(function* (
  threads: Threads,
  claims: Claims,
  fail: FailCommand,
  expected: { readonly generation: number; readonly unlessOwned: boolean },
) {
  const inherited = yield* CommitGuard;
  return yield* threads
    .dispatch(fail)
    .pipe(Effect.provideService(CommitGuard, guardFor(claims, fail, expected, inherited)));
});

const isRefused = Schema.is(CommitGuardRefused);

/** The reason a commit guard refused, found through the dispatch and event sink errors. */
export const refusalReason = <E>(cause: Cause.Cause<E>): string | undefined => {
  let error: unknown = Option.getOrUndefined(Cause.findErrorOption(cause));
  for (let depth = 0; depth < 3 && error !== undefined; depth++) {
    if (isRefused(error)) return error.reason;
    error =
      typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  }
  return undefined;
};

/**
 * Fails the run for its preparation, guarded by the generation the preparation read before it
 * found the run "preparing". Without a run or that generation it fails nothing and logs.
 */
export const failOwnedRun = Effect.fn("PreparationStretch.failOwnedRun")(function* (input: {
  readonly threads: Threads;
  readonly claims: Claims;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly generation: number | null;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly cause: unknown;
}) {
  const context = { commandId: input.commandId, threadId: input.threadId, cause: input.cause };
  if (input.runId === null || input.generation === null)
    return yield* Effect.logWarning("Thread workspace preparation failed", context);
  yield* dispatchGuardedFail(
    input.threads,
    input.claims,
    {
      type: "prepared-run.fail",
      commandId: CommandId.make(`${input.commandId}:fail`),
      threadId: input.threadId,
      runId: input.runId,
      failure: input.failure,
    },
    { generation: input.generation, unlessOwned: false },
  ).pipe(
    Effect.catchCause((persistCause) => {
      const reason = refusalReason(persistCause);
      return reason === undefined
        ? Effect.logWarning("Failed to persist thread workspace preparation failure", {
            ...context,
            persistCause,
          })
        : Effect.logInfo("The run left this preparation, so its failure is not recorded", {
            ...context,
            reason,
          });
    }),
  );
});
