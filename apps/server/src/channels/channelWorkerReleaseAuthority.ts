import {
  ChannelInputId,
  ChannelTaskId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  isChannelWorkerLaunchMessageId,
  isChannelWorkerThreadId,
  workerLaunchIdsFor,
} from "./channelIds.ts";
import { makeRoutineWorkAuthority } from "./channelRoutineWorkAuthority.ts";

export class ChannelWorkerReleaseDenied extends Schema.TaggedError<ChannelWorkerReleaseDenied>()(
  "ChannelWorkerReleaseDenied",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export const makeChannelWorkerReleaseAuthority = Effect.fn("channel.makeWorkerReleaseAuthority")(
  function* (threads: ThreadManagement.ThreadManagementService["Service"]) {
    const sql = yield* SqlClient.SqlClient;
    const routineAuthority = yield* makeRoutineWorkAuthority();

    return Effect.fn("channel.authorizeWorkerRelease")(function* (
      threadId: ThreadId,
      runId: RunId,
    ) {
      if (!isChannelWorkerThreadId(threadId)) return;
      const { thread, runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
        runIds: [runId],
      });
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined)
        return yield* new ChannelWorkerReleaseDenied({
          reason: "The channel worker's run is missing.",
        });
      if (!isChannelWorkerLaunchMessageId(run.userMessageId)) return;

      let after = "";
      while (true) {
        // A launch may acquire its channel binding while workspace preparation is running.
        const rows = yield* sql<{
          readonly task_id: string;
          readonly generation: number;
          readonly routine_work: number | null;
          readonly input_id: string | null;
        }>`SELECT task_id, generation, json_extract(task_json, '$.routineWork') AS routine_work,
            json_extract(task_json, '$.originInputId') AS input_id
          FROM (
            SELECT task_id, generation, task_json FROM channel_tasks
            WHERE worker_thread_id = ${threadId} AND task_id > ${after}
            UNION ALL
            SELECT task_id, generation, task_json FROM channel_tasks
            WHERE task_id > ${after} AND status NOT IN ('completed', 'failed', 'cancelled')
              AND status = 'dispatching' AND worker_thread_id IS NULL
          )
          ORDER BY task_id LIMIT 64`;
        if (rows.length === 0)
          return yield* new ChannelWorkerReleaseDenied({
            reason: "The channel worker's task is missing.",
          });
        for (const row of rows) {
          after = row.task_id;
          const worker = workerLaunchIdsFor(ChannelTaskId.make(row.task_id), row.generation);
          if (worker.threadId !== threadId || worker.messageId !== run.userMessageId) continue;
          if (row.routine_work !== 1) return;
          if (row.input_id === null)
            return yield* new ChannelWorkerReleaseDenied({
              reason: "The GOAT Bot work trigger's input is missing.",
            });
          const grant = yield* routineAuthority(ChannelInputId.make(row.input_id));
          const reason =
            "error" in grant
              ? grant.error
              : grant.projectId !== thread.projectId
                ? "The GOAT Bot work trigger's project changed after this delivery arrived."
                : undefined;
          if (reason !== undefined) return yield* new ChannelWorkerReleaseDenied({ reason });
          return;
        }
      }
    });
  },
);

export const routineWorkerReleaseReason = (
  shell: OrchestrationV2ThreadShell | null,
  runId: RunId,
) =>
  shell?.latestRunId === runId &&
  shell.lastErrorCode === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
  shell.lastError?.startsWith("The GOAT Bot work trigger")
    ? shell.lastError
    : undefined;
