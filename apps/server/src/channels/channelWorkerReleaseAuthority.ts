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
import { EventSinkWriteError, type EventSinkV2Shape } from "../orchestration-v2/EventSinkShape.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CommitGuardRefused } from "../orchestration-v2/goat/CommitGuard.ts";
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

const makeChannelWorkerReleaseAuthority = Effect.fn("channel.makeWorkerReleaseAuthority")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const routineAuthority = yield* makeRoutineWorkAuthority();

    return Effect.fn("channel.authorizeWorkerRelease")(function* (
      threadId: ThreadId,
      runId: RunId,
    ) {
      const [run] = yield* sql<{
        readonly project_id: string;
        readonly message_id: string;
        readonly author: string | null;
        readonly task_id: string | null;
        readonly generation: number | null;
        readonly status: string | null;
        readonly routine_work: number | null;
        readonly input_id: string | null;
      }>`
        SELECT t.project_id, json_extract(r.payload_json, '$.userMessageId') AS message_id,
          COALESCE(json_extract(m.payload_json, '$.createdBy'),
            json_extract(t.payload_json, '$.createdBy')) AS author,
          task.task_id, task.generation, task.status,
          json_extract(task.task_json, '$.routineWork') AS routine_work,
          json_extract(task.task_json, '$.originInputId') AS input_id
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        LEFT JOIN orchestration_v2_projection_messages m
          ON m.thread_id = r.thread_id AND m.message_id = json_extract(r.payload_json, '$.userMessageId')
        LEFT JOIN channel_worker_generations w ON w.worker_thread_id = r.thread_id
        LEFT JOIN channel_tasks task ON task.task_id = w.task_id AND task.generation = w.generation
          AND (task.worker_thread_id = r.thread_id OR
            (task.worker_thread_id IS NULL AND task.status = 'dispatching'))
        WHERE r.run_id = ${runId} AND r.thread_id = ${threadId}`;
      if (run === undefined)
        return yield* new ChannelWorkerReleaseDenied({
          reason: "The channel worker's run is missing.",
        });
      // Client launches stamp their author server-side even when the client supplies both ids.
      if (
        run.author !== "system" ||
        !isChannelWorkerLaunchMessageId(MessageId.make(run.message_id))
      )
        return;

      if (
        run.task_id === null ||
        run.generation === null ||
        workerLaunchIdsFor(ChannelTaskId.make(run.task_id), run.generation).messageId !==
          run.message_id
      )
        return yield* new ChannelWorkerReleaseDenied({
          reason: "The GOAT Bot work trigger's task generation is missing.",
        });
      if (run.routine_work !== 1) return;
      if (
        run.status !== "dispatching" &&
        run.status !== "running" &&
        run.status !== "waiting_input"
      )
        return yield* new ChannelWorkerReleaseDenied({
          reason: "The GOAT Bot work trigger's task generation is no longer active.",
        });
      if (run.input_id === null)
        return yield* new ChannelWorkerReleaseDenied({
          reason: "The GOAT Bot work trigger's input is missing.",
        });
      const grant = yield* routineAuthority(ChannelInputId.make(run.input_id));
      const reason =
        "error" in grant
          ? grant.error
          : grant.projectId !== run.project_id
            ? "The GOAT Bot work trigger's project changed after this delivery arrived."
            : undefined;
      if (reason !== undefined) return yield* new ChannelWorkerReleaseDenied({ reason });
    });
  },
);

export const makeChannelWorkerCommitGuard = Effect.fn("channel.makeWorkerCommitGuard")(
  function* () {
    const authorize = yield* makeChannelWorkerReleaseAuthority();
    return (
      input: Pick<
        Parameters<EventSinkV2Shape["commitCommand"]>[0],
        "commandType" | "threadId" | "effects"
      >,
    ) => {
      if (input.commandType !== "prepared-run.release" || !isChannelWorkerThreadId(input.threadId))
        return Effect.void;
      const start = input.effects.find(
        ({ request }) => request.type === "provider-turn.start",
      )?.request;
      if (start?.type !== "provider-turn.start") return Effect.void;
      return authorize(input.threadId, start.runId).pipe(
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
    };
  },
);

export const makePreparedWorkerRelease = Effect.fn("channel.makePreparedWorkerRelease")(function* (
  dispatch: ThreadManagement.ThreadManagementService["Service"]["dispatch"],
) {
  const authorize = yield* makeChannelWorkerReleaseAuthority();
  return Effect.fn("channel.releasePreparedWorker")(function* <E>(
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.release" }>,
    dispatchError: (cause: unknown) => E,
  ) {
    if (isChannelWorkerThreadId(command.threadId))
      yield* authorize(command.threadId, command.runId);
    return yield* dispatch(command).pipe(
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
