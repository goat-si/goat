import {
  ChannelInputId,
  ChannelTaskId,
  MessageId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { EventSinkWriteError } from "../orchestration-v2/EventSinkShape.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CommitGuard, CommitGuardRefused } from "../orchestration-v2/goat/CommitGuard.ts";
import {
  isChannelWorkerLaunchMessageId,
  isChannelWorkerThreadId,
  workerLaunchIdsFor,
} from "./channelIds.ts";
import { makeRoutineWorkAuthority } from "./channelRoutineWorkAuthority.ts";

export const CHANNEL_WORKER_RELEASE_DENIED = "channel_worker_release_denied";
const isGuardRefusal = Schema.is(CommitGuardRefused);
const isEventSinkWriteError = Schema.is(EventSinkWriteError);

export class ChannelWorkerReleaseDenied extends Schema.TaggedError<ChannelWorkerReleaseDenied>()(
  "ChannelWorkerReleaseDenied",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

const isReleaseDenial = Schema.is(ChannelWorkerReleaseDenied);

export const makePreparedWorkerRelease = Effect.fn("channel.makePreparedWorkerRelease")(function* (
  dispatch: ThreadManagement.ThreadManagementService["Service"]["dispatch"],
) {
  const sql = yield* SqlClient.SqlClient;
  const routineAuthority = yield* makeRoutineWorkAuthority();

  const authorize = Effect.fn("channel.authorizeWorkerRelease")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const [run] = yield* sql<{
      readonly project_id: string;
      readonly message_id: string;
      readonly author: string | null;
    }>`
        SELECT t.project_id, json_extract(r.payload_json, '$.userMessageId') AS message_id,
          COALESCE(json_extract(m.payload_json, '$.createdBy'),
            json_extract(t.payload_json, '$.createdBy')) AS author
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        LEFT JOIN orchestration_v2_projection_messages m
          ON m.thread_id = r.thread_id AND m.message_id = json_extract(r.payload_json, '$.userMessageId')
        WHERE r.run_id = ${runId} AND r.thread_id = ${threadId}`;
    if (run === undefined)
      return yield* new ChannelWorkerReleaseDenied({
        reason: "The channel worker's run is missing.",
      });
    // Client launches stamp their author server-side even when the client supplies both ids.
    if (run.author !== "system" || !isChannelWorkerLaunchMessageId(MessageId.make(run.message_id)))
      return;

    let after = "";
    while (true) {
      // A launch may acquire its channel binding while workspace preparation is running.
      const rows = yield* sql<{
        readonly task_id: string;
        readonly generation: number;
        readonly status: string;
        readonly routine_work: number | null;
        readonly input_id: string | null;
      }>`SELECT task_id, generation, status, json_extract(task_json, '$.routineWork') AS routine_work,
            json_extract(task_json, '$.originInputId') AS input_id
          FROM (
            SELECT task_id, generation, status, task_json FROM channel_tasks
            WHERE worker_thread_id = ${threadId} AND task_id > ${after}
            UNION ALL
            SELECT task_id, generation, status, task_json FROM channel_tasks
            WHERE task_id > ${after} AND status = 'dispatching' AND worker_thread_id IS NULL
          )
          ORDER BY task_id LIMIT 64`;
      if (rows.length === 0)
        return yield* new ChannelWorkerReleaseDenied({
          reason: "The GOAT Bot work trigger's task generation is missing.",
        });
      for (const row of rows) {
        after = row.task_id;
        const worker = workerLaunchIdsFor(ChannelTaskId.make(row.task_id), row.generation);
        if (worker.threadId !== threadId || worker.messageId !== run.message_id) continue;
        if (row.routine_work !== 1) return;
        if (!["dispatching", "running", "waiting_input"].includes(row.status))
          return yield* new ChannelWorkerReleaseDenied({
            reason: "The GOAT Bot work trigger's task generation is no longer active.",
          });
        if (row.input_id === null)
          return yield* new ChannelWorkerReleaseDenied({
            reason: "The GOAT Bot work trigger's input is missing.",
          });
        const grant = yield* routineAuthority(ChannelInputId.make(row.input_id));
        const reason =
          "error" in grant
            ? grant.error
            : grant.projectId !== run.project_id
              ? "The GOAT Bot work trigger's project changed after this delivery arrived."
              : undefined;
        if (reason !== undefined) return yield* new ChannelWorkerReleaseDenied({ reason });
        return;
      }
    }
  });

  return Effect.fn("channel.releasePreparedWorker")(function* <E>(
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.release" }>,
    dispatchError: (cause: unknown) => E,
  ) {
    if (!isChannelWorkerThreadId(command.threadId))
      return yield* dispatch(command).pipe(Effect.mapError(dispatchError));
    const check = authorize(command.threadId, command.runId);
    yield* check;
    const commitCheck = check.pipe(
      Effect.mapError(
        (cause) =>
          new CommitGuardRefused({
            code: CHANNEL_WORKER_RELEASE_DENIED,
            reason: isReleaseDenial(cause)
              ? cause.reason
              : "The GOAT Bot work trigger's authority could not be verified.",
          }),
      ),
    );
    const inherited = yield* CommitGuard;
    return yield* dispatch(command).pipe(
      Effect.provideService(CommitGuard, (input) => {
        const outer = inherited?.(input);
        if (input.commandId !== command.commandId || input.commandType !== command.type)
          return outer;
        return (events) => Effect.andThen(outer?.(events) ?? Effect.void, commitCheck);
      }),
      Effect.mapError((error) => {
        const cause =
          error._tag === "OrchestratorDispatchError" && isEventSinkWriteError(error.cause)
            ? error.cause.cause
            : undefined;
        return isGuardRefusal(cause) && cause.code === CHANNEL_WORKER_RELEASE_DENIED
          ? new ChannelWorkerReleaseDenied({ reason: cause.reason })
          : dispatchError(error);
      }),
    );
  });
});

export const routineWorkerReleaseReason = (
  shell: OrchestrationV2ThreadShell | null,
  runId: RunId,
) =>
  shell?.latestRunId === runId &&
  (shell.lastErrorCode === CHANNEL_WORKER_RELEASE_DENIED ||
    (shell.lastErrorCode === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
      shell.lastError?.startsWith("The GOAT Bot work trigger")))
    ? shell.lastError
    : undefined;
