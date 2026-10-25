/**
 * Whether a thread still has work open that its computer use control serves.
 *
 * @module ComputerUseOpenWork
 */
import type { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/** How often a live implied grant re-checks its run, so a run end that was missed still ends it. */
export const IMPLIED_RECHECK_MS = 2_000;

/**
 * Whether the thread still has a run, provider turn or native subagent open. Native subagents
 * work through the parent's provider session, and so its control, on their own child threads;
 * one can outlive a failed parent run. Delegated tasks hold controls of their own.
 */
const openRuns = Effect.fn("ComputerUseLeases.openWork")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const open = yield* sql<{ readonly one: number }>`
    WITH RECURSIVE native(child_thread_id, status) AS (
      SELECT s.child_thread_id, s.status FROM orchestration_v2_projection_subagents s
      WHERE s.thread_id = ${threadId} AND s.origin = 'provider_native'
      UNION
      SELECT s.child_thread_id, s.status FROM orchestration_v2_projection_subagents s
      JOIN native n ON s.thread_id = n.child_thread_id
      WHERE s.origin = 'provider_native'
    )
    SELECT 1 AS one FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId}
      AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
    UNION ALL
    SELECT 1 AS one FROM native WHERE status IN ('pending', 'running', 'waiting')
    UNION ALL
    SELECT 1 AS one FROM orchestration_v2_projection_provider_turns
    WHERE status IN ('pending', 'running')
      AND (thread_id = ${threadId} OR thread_id IN (SELECT child_thread_id FROM native))
    LIMIT 1
  `;
  return open.length > 0;
});

/** Which of these runs the projection shows ended, so their implied foreground ends (#1617). */
const endedRuns = Effect.fn("ComputerUseLeases.endedRuns")(function* (
  sql: SqlClient.SqlClient,
  runIds: ReadonlyArray<RunId>,
) {
  if (runIds.length === 0) return [];
  const ended = yield* sql<{ readonly run_id: string }>`
    SELECT run_id FROM orchestration_v2_projection_runs
    WHERE run_id IN ${sql.in(runIds)}
      AND status NOT IN ('preparing', 'queued', 'starting', 'running', 'waiting')
  `;
  return runIds.filter((runId) => ended.some((row) => row.run_id === runId));
});

interface ImpliedForeground {
  readonly impliedRuns: (threadId: ThreadId) => ReadonlyArray<RunId>;
  readonly revokeRun: (threadId: ThreadId, runId: RunId) => void;
}

/**
 * A run that ended loses the foreground it held without an approval, even while another run of
 * the thread is queued or running (#1617), and `revoked` tells proxies so they stop a script
 * already under way. Read, revocation and notice are one uninterruptible step, because a retry
 * would find nothing left to revoke; a failed read ends every implied grant of the thread.
 */
const revokeEndedRuns = Effect.fn("ComputerUseLeases.revokeEndedRuns")(function* (
  sql: SqlClient.SqlClient,
  foreground: ImpliedForeground,
  threadId: ThreadId,
  revoked: Effect.Effect<void>,
) {
  yield* Effect.uninterruptible(
    Effect.suspend(() => {
      const runs = foreground.impliedRuns(threadId);
      if (runs.length === 0) return Effect.void;
      return endedRuns(sql, runs).pipe(
        Effect.orElseSucceed(() => runs),
        Effect.flatMap((ended) => {
          for (const runId of ended) foreground.revokeRun(threadId, runId);
          return ended.length === 0 ? Effect.void : revoked;
        }),
      );
    }),
  );
});

/** Whether the thread still has work open, once runs that ended lost their implied foreground. */
export const threadOpenWork = Effect.fn("ComputerUseLeases.threadOpenWork")(function* (
  sql: SqlClient.SqlClient,
  foreground: ImpliedForeground,
  threadId: ThreadId,
  revoked: Effect.Effect<void>,
) {
  yield* revokeEndedRuns(sql, foreground, threadId, revoked);
  return yield* openRuns(sql, threadId);
});

interface RunEndControl {
  readonly controlId: string;
  readonly uses: number;
  readonly ended?: unknown;
  readonly idle?: boolean;
  readonly idleEpoch?: number;
}

/** What ComputerUseLeases does when a turn ends, over its controls and foreground state. */
export const makeRunEnd = <C extends RunEndControl, E>(options: {
  readonly sql: SqlClient.SqlClient;
  readonly foreground: ImpliedForeground & {
    readonly revokeControl: (threadId: ThreadId, controlId: string) => void;
  };
  readonly controls: Map<ThreadId, C>;
  readonly changed: Effect.Effect<void>;
  readonly error: (cause: SqlError.SqlError) => E;
}) => {
  const { sql, foreground, controls, changed } = options;
  /** Ends the implied foreground of runs that are over; see revokeEndedRuns. */
  const settle = (threadId: ThreadId) => revokeEndedRuns(sql, foreground, threadId, changed);
  /** Whether the thread still has work open; a revocation on the way publishes. */
  const openWork = (threadId: ThreadId) =>
    threadOpenWork(sql, foreground, threadId, changed).pipe(Effect.mapError(options.error));
  const turnEnded = Effect.fn("ComputerUseLeases.turnEnded")(function* (threadId: ThreadId) {
    const before = controls.get(threadId);
    if (before === undefined || before.ended !== undefined) return false;
    if (yield* openWork(threadId)) return false;
    // The read yields: a turn that minted or reused the control since then keeps it.
    const after = controls.get(threadId);
    if (
      after?.controlId !== before.controlId ||
      after.uses !== before.uses ||
      after.ended !== undefined ||
      after.idle === true
    )
      return false;
    foreground.revokeControl(threadId, after.controlId);
    controls.set(threadId, { ...after, idle: true, idleEpoch: (after.idleEpoch ?? 0) + 1 });
    yield* changed;
    return true;
  });
  return { settle, openWork, turnEnded };
};
