import type { ChannelTaskId, ThreadId } from "@goat/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { workerLaunchIdsFor } from "../channels/channelIds.ts";

const PAGE_SIZE = 128;

type WorkerGeneration = {
  readonly task_id: ChannelTaskId;
  readonly generation: number;
  readonly worker_thread_id: ThreadId;
};

export const reconcileChannelWorkerGenerations = Effect.fn("reconcileChannelWorkerGenerations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const write = (workers: ReadonlyArray<WorkerGeneration>) =>
      Arr.isReadonlyArrayNonEmpty(workers)
        ? sql`INSERT INTO channel_worker_generations ${sql.insert(workers)}
            ON CONFLICT (task_id) DO UPDATE SET worker_thread_id = excluded.worker_thread_id,
              generation = excluded.generation`
        : Effect.void;

    // The status list lets SQLite use the partial recovery index.
    const preparing = sql`status = 'preparing' AND
      status IN ('queued', 'preparing', 'starting', 'running', 'waiting')`;
    let afterThread = "";
    let afterTask = "";
    while (true) {
      const workers = yield* sql<WorkerGeneration>`
        WITH preparations AS (
          SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE ${preparing} AND thread_id GLOB 'channel-worker:*' AND thread_id >= ${afterThread}
        )
        SELECT DISTINCT t.task_id, t.generation, t.worker_thread_id
        FROM preparations p
        CROSS JOIN channel_tasks t ON t.worker_thread_id = p.thread_id
        LEFT JOIN channel_worker_generations w ON w.task_id = t.task_id
          AND w.generation = t.generation AND w.worker_thread_id = p.thread_id
        WHERE (p.thread_id, t.task_id) > (${afterThread}, ${afterTask}) AND w.task_id IS NULL
        ORDER BY p.thread_id, t.task_id LIMIT ${PAGE_SIZE}`;
      if (!Arr.isReadonlyArrayNonEmpty(workers)) break;
      const last = Arr.lastNonEmpty(workers);
      afterThread = last.worker_thread_id;
      afterTask = last.task_id;
      yield* write(
        workers.filter(
          (worker) =>
            workerLaunchIdsFor(worker.task_id, worker.generation).threadId ===
            worker.worker_thread_id,
        ),
      );
    }

    // A local dispatch claim can survive a restart before the worker's run exists.
    let afterRow = 0;
    while (true) {
      const tasks = yield* sql<{
        readonly row_id: number;
        readonly task_id: ChannelTaskId;
        readonly generation: number;
        readonly indexed_thread: ThreadId | null;
        readonly indexed_generation: number | null;
        readonly local_claim: 1 | 0;
      }>`SELECT t.rowid AS row_id, t.task_id, t.generation,
          w.worker_thread_id AS indexed_thread, w.generation AS indexed_generation,
          CASE WHEN json_valid(t.task_json) THEN
            json_type(t.task_json, '$.target') IS 'object'
              AND json_type(t.task_json, '$.target.remote') IS NULL
          ELSE 0 END AS local_claim
        FROM channel_tasks t LEFT JOIN channel_worker_generations w ON w.task_id = t.task_id
        WHERE t.status = 'dispatching' AND t.status NOT IN ('completed', 'failed', 'cancelled')
          AND t.rowid > ${afterRow} AND t.worker_thread_id IS NULL
        ORDER BY t.rowid LIMIT ${PAGE_SIZE}`;
      if (!Arr.isReadonlyArrayNonEmpty(tasks)) break;
      afterRow = Arr.lastNonEmpty(tasks).row_id;
      const candidates = tasks.flatMap((task) => {
        const worker = workerLaunchIdsFor(task.task_id, task.generation);
        return task.indexed_thread === worker.threadId &&
          task.indexed_generation === task.generation
          ? []
          : [
              {
                localClaim: task.local_claim === 1,
                row: {
                  task_id: task.task_id,
                  generation: task.generation,
                  worker_thread_id: worker.threadId,
                },
              },
            ];
      });
      const unconfirmed = candidates.flatMap(({ localClaim, row }) =>
        localClaim ? [] : [row.worker_thread_id],
      );
      const prepared =
        unconfirmed.length === 0
          ? []
          : yield* sql<{ readonly thread_id: ThreadId }>`
              SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
              WHERE ${preparing} AND thread_id IN ${sql.in(unconfirmed)}`;
      const preparedThreads = new Set(prepared.map((row) => row.thread_id));
      yield* write(
        candidates.flatMap(({ localClaim, row }) =>
          localClaim || preparedThreads.has(row.worker_thread_id) ? [row] : [],
        ),
      );
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not repair channel worker generations", { cause }),
  ),
);
