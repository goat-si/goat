import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  RemoteTaskError,
  recordRemoteTaskResult,
  recoverUnknownRemoteTaskLaunch,
} from "./recordRemoteTaskResult.ts";
import { publicRow } from "./remoteDispatchModel.ts";
import { decodeRemoteDispatchRows } from "./remoteDispatchRow.ts";

/** At startup, gives every task launch whose outcome was lost a result, so its parent never waits. */
export const recoverUncertainTasks = Effect.fn("remoteReports.recoverUncertainTasks")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const storage = (cause: unknown) => new RemoteTaskError({ stage: "storage", cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uncertainTasks = yield* sql`SELECT * FROM remote_dispatches WHERE kind = 'task'
    AND state IN ('launching', 'lost')`.pipe(
    Effect.flatMap(decodeRemoteDispatchRows),
    Effect.mapError(storage),
  );
  for (const r of uncertainTasks) {
    const record = publicRow(r);
    if (record.task === null) continue;
    const task = { ...record, task: record.task };
    yield* Effect.gen(function* () {
      const { subagents } = yield* threads.getThreadRecords(r.origin_thread_id, ["subagents"]);
      if (subagents.some((candidate) => candidate.id === r.task_id && candidate.result !== null)) {
        // The result already landed; only a row stuck in launching still needs closing.
        if (r.state === "launching")
          yield* sql`UPDATE remote_dispatches SET state = 'lost', updated_at = ${yield* now}
            WHERE correlation_id = ${r.correlation_id}`;
        return;
      }
      if (r.launched_run_id === null) yield* recoverUnknownRemoteTaskLaunch(task);
      else
        yield* recordRemoteTaskResult({
          ...task,
          status: "failed",
          summary: "The remote task's thread or report binding is unavailable.",
        });
      yield* sql`UPDATE remote_dispatches SET state = 'lost', last_error = ${r.launched_run_id === null ? "launch outcome unknown" : "Remote task binding or thread is unavailable."},
        updated_at = ${yield* now} WHERE correlation_id = ${r.correlation_id}`;
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Remote task recovery failed; continuing.", {
          correlationId: r.correlation_id,
        }),
      ),
    );
  }
});
