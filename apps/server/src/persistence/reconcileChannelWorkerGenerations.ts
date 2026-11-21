import type { ChannelTaskId, ThreadId } from "@goat/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { workerLaunchIdsFor } from "../channels/channelIds.ts";

const PAGE_SIZE = 128;

interface WorkerGeneration {
  readonly task_id: ChannelTaskId;
  readonly generation: number;
  readonly worker_thread_id: ThreadId;
}

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
    const pending = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs
      WHERE ${preparing} AND thread_id GLOB 'channel-worker:*' LIMIT 1`;
    if (pending.length === 0) return;

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

    // An unbound preparation can only be matched by deriving its thread id from the task.
    let afterRow = 0;
    while (true) {
      const tasks = yield* sql<{
        readonly row_id: number;
        readonly task_id: ChannelTaskId;
        readonly generation: number;
        readonly indexed_thread: ThreadId | null;
        readonly indexed_generation: number | null;
      }>`SELECT t.rowid AS row_id, t.task_id, t.generation,
          w.worker_thread_id AS indexed_thread, w.generation AS indexed_generation
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
                task_id: task.task_id,
                generation: task.generation,
                worker_thread_id: worker.threadId,
              },
            ];
      });
      if (candidates.length === 0) continue;
      const prepared = yield* sql<{ readonly thread_id: ThreadId }>`
        SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
        WHERE ${preparing} AND thread_id IN ${sql.in(candidates.map((row) => row.worker_thread_id))}`;
      const preparedThreads = new Set(prepared.map((row) => row.thread_id));
      yield* write(candidates.filter((row) => preparedThreads.has(row.worker_thread_id)));
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not repair prepared channel workers", { cause }),
  ),
);
