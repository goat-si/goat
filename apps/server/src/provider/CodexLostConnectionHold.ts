/**
 * A turn left running in a process a goal block keeps, after its connection drops, holds its
 * thread's next start until Codex reports it ended or the process is verified gone.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { isVerifiedCodexProcessLoss } from "../orchestration-v2/Adapters/CodexSurvivorSessionLoss.ts";
import type {
  CodexInstanceRecordKey,
  CodexStopObligation,
  CodexSurvivors,
} from "./CodexSurvivors.ts";

/** How often a held turn is checked; each check opens one short connection to the process. */
export const LOST_CONNECTION_CHECK_INTERVAL = Duration.seconds(15);

/**
 * Records the hold and watches the turn until it ends. Returns false, recording nothing, when the
 * process is verified gone: its turns ended with it.
 */
export const holdLostConnectionTurn = Effect.fn("CodexLostConnectionHold.hold")(function* (input: {
  readonly survivors: Pick<
    CodexSurvivors["Service"],
    "classifyRecord" | "recordStopObligation" | "clearStopObligation" | "readExistingTurn"
  >;
  readonly record: CodexInstanceRecordKey;
  readonly stop: CodexStopObligation;
  /** Outlives the session whose connection dropped. */
  readonly scope: Scope.Scope;
}) {
  const { survivors, record, stop } = input;
  const gone = survivors.classifyRecord(record).pipe(
    Effect.map(isVerifiedCodexProcessLoss),
    Effect.orElseSucceed(() => false),
  );
  if (yield* gone) return false;
  yield* survivors.recordStopObligation(record, stop);
  const ended = Effect.gen(function* () {
    const turn = yield* (
      survivors.readExistingTurn?.(record, stop.nativeThreadId, stop.nativeTurnId) ??
      Effect.succeed("running" as const)
    ).pipe(Effect.option);
    // A turn Codex no longer lists may still run past the page it read, so only an end it reports
    // or the process being gone releases the thread.
    if (Option.isSome(turn) && turn.value !== "running" && turn.value !== "unknown") return true;
    return yield* gone;
  });
  yield* ended.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(LOST_CONNECTION_CHECK_INTERVAL),
      until: (done) => done,
    }),
    Effect.andThen(survivors.clearStopObligation(record, stop)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not release a Codex turn that outlived its connection", {
        threadId: stop.threadId,
        cause,
      }),
    ),
    Effect.forkIn(input.scope, { startImmediately: true }),
  );
  return true;
});
