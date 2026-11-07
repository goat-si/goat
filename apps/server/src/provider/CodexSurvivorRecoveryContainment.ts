import { latestProviderTurnForAttempt, type ThreadId } from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RecoveryFailure from "./CodexSurvivorRecoveryFailure.ts";
import type { CodexSurvivors } from "./CodexSurvivors.ts";

export type RecoveryRun = ProjectionStore.ProjectionRuntimeRecoveryState["runs"][number];

/**
 * Runs one thread's survivor recovery. An inconsistent record blocks that thread, with its identity
 * treated as unknown, and recovery continues for the others; same data blocks it on every start.
 */
export const containRecoveryThread = <E, R>(input: {
  readonly threadId: ThreadId;
  readonly survivors: CodexSurvivors["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
  readonly run: () => RecoveryRun | undefined;
  readonly onBlocked: Effect.Effect<void>;
  readonly recover: Effect.Effect<void, E, R>;
}) =>
  input.recover.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => blockInconsistentThread({ ...input, run: input.run(), cause }),
    ),
  );

const blockInconsistentThread = Effect.fn("CodexSurvivorRecovery.blockInconsistentThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly survivors: CodexSurvivors["Service"];
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly sink: EventSink.EventSinkV2["Service"];
    readonly ids: IdAllocator.IdAllocatorV2["Service"];
    readonly run: RecoveryRun | undefined;
    readonly onBlocked: Effect.Effect<void>;
    readonly cause: Cause.Cause<unknown>;
  }) {
    const { threadId, run } = input;
    yield* Effect.logWarning("Codex survivor recovery blocked a thread with inconsistent records", {
      threadId,
      cause: input.cause,
    });
    yield* input.onBlocked;
    if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
    if (!run?.activeAttemptId) return;
    const attemptId = run.activeAttemptId;
    yield* Effect.gen(function* () {
      const own = yield* input.projections.getThreadRecords(threadId, ["providerTurns"], {
        ancestryRunIds: [run.id],
      });
      const turn = latestProviderTurnForAttempt(own.providerTurns, attemptId);
      if (turn) yield* RecoveryFailure.reportUnverified({ ...input, run, turn });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
      ),
    );
  },
);
