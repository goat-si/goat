/**
 * remoteTaskFollowUp - a send to the thread of one of the caller's remote tasks that already has
 * its result. Like a follow-up to a finished child here, the run it starts there is a new task,
 * followed by its own dispatch record and waking the parent when it ends.
 *
 * @module remoteTaskFollowUp
 */
// @effect-diagnostics nodeBuiltinImport:off - derive stable dispatch ids and private read keys.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  type NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type ThreadId,
} from "@goat/contracts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { followUpOwnerRun } from "../orchestration-v2/goat/OrchestratorRunState.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as Coordinator from "./RemoteDispatchCoordinator.ts";
import type { RemoteDispatchError } from "./remoteDispatchModel.ts";

export interface RemoteFollowUpInput {
  readonly originThreadId: ThreadId;
  readonly host: string;
  readonly request: Pick<OrchestratorMcpThreadSendInput, "message" | "clientRequestId">;
  readonly sent: OrchestratorMcpThreadSendResult;
}
export type RemoteFollowUp = (
  input: RemoteFollowUpInput,
) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure | RemoteDispatchError>;

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const notRecorded = (clientRequestId: string | undefined) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      clientRequestId === undefined
        ? "The message was sent, but its task was not recorded; read the thread for its answer instead of sending it again."
        : "The message was sent, but its task was not recorded; send it again with the same clientRequestId to record it.",
  });

/**
 * Records the follow-up's dispatch row and task, then hands the row to `start`. A steer joins a
 * run that is already some task's, or no one's, so only a started or queued run is a follow-up.
 */
export const recordRemoteFollowUp = Effect.fn("remoteReports.recordRemoteFollowUp")(function* (
  input: RemoteFollowUpInput,
  start: (correlationId: string) => Effect.Effect<void>,
) {
  const { sent, host } = input;
  if (sent.delivery !== "started" && sent.delivery !== "queued") return sent;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;
  const parent = yield* threads
    .getThreadRecords(input.originThreadId, ["runs", "subagents"])
    .pipe(Effect.orElseSucceed(() => undefined));
  const finished = parent?.subagents.findLast(
    (task) =>
      task.remote?.host === host && task.remote.threadId === sent.threadId && task.result !== null,
  );
  // Bound as a follow-up here is: a background caller's foreground run may have ended.
  const owner = parent === undefined ? null : followUpOwnerRun(parent.runs);
  const modelSelection =
    finished?.modelSelection ??
    (finished?.model == null
      ? undefined
      : { instanceId: finished.providerInstanceId, model: finished.model });
  const shell = yield* threads
    .getThreadShell(input.originThreadId)
    .pipe(Effect.orElseSucceed(() => null));
  const task = input.request.message.trim();
  if (
    finished === undefined ||
    modelSelection === undefined ||
    owner === null ||
    owner.rootNodeId === null ||
    shell === null ||
    task.length === 0
  )
    return sent;
  // The message id there is the send's, so a retry that reached the same send records once.
  const correlationId = `rr-followup-${NodeCrypto.createHash("sha256")
    .update(`${input.originThreadId}\u001f${host}\u001f${sent.messageId}`)
    .digest("hex")
    .slice(0, 32)}`;
  const commandId = CommandId.make(`remote-task-follow-up:${correlationId}`);
  const taskId: NodeId = derive.delegatedTaskNode({ commandId });
  const at = DateTime.formatIso(yield* DateTime.now);
  const failed = Effect.fail(notRecorded(input.request.clientRequestId));
  // Followed through goat_thread_wait on its own run: the reports there belong to the first task.
  const inserted = yield* sql<{
    readonly correlation_id: string;
  }>`INSERT OR IGNORE INTO remote_dispatches
    (correlation_id, kind, origin_thread_id, host, remote_thread_id, launched_run_id, read_key,
      delivery, reports_supported, state, task_id, parent_run_id, relay_send, created_at,
      updated_at, memory_grant_ceiling)
    VALUES (${correlationId}, 'task', ${input.originThreadId}, ${host}, ${sent.threadId},
      ${sent.runId}, ${NodeCrypto.randomBytes(32).toString("hex")}, 'wake', 0, 'running',
      ${taskId}, ${owner.id}, 0, ${at}, ${at}, ${finished.memoryGrantCeiling ?? "none"})
    RETURNING correlation_id`.pipe(Effect.catch(() => failed));
  yield* threads
    .dispatch({
      type: "delegated_task.remote.register",
      commandId,
      parentThreadId: input.originThreadId,
      parentRunId: owner.id,
      parentNodeId: owner.rootNodeId,
      parentModelSelection: owner.modelSelection,
      memoryGrantCeiling: finished.memoryGrantCeiling ?? "none",
      task,
      ...(finished.title === null ? {} : { title: finished.title }),
      ...(finished.role === undefined ? {} : { role: finished.role }),
      modelSelection,
      driver: finished.driver,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      createdBy: "agent",
      creationSource: "mcp",
      completionWake: "always",
      remote: { host, threadId: sent.threadId, correlationId },
    })
    .pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("remote task follow-up not recorded", {
          originThreadId: input.originThreadId,
          cause,
        }),
      ),
      // Only the row this call wrote goes: a replay's row already backs a recorded task.
      Effect.catch(() =>
        (inserted.length === 0
          ? Effect.void
          : sql`DELETE FROM remote_dispatches WHERE correlation_id = ${correlationId}`.pipe(
              Effect.ignore,
            )
        ).pipe(Effect.andThen(failed)),
      ),
    );
  yield* start(correlationId);
  return { ...sent, taskId };
});

/** After a send through a host: a follow-up to a finished remote task of the caller is a task. */
export const followUpRemoteTask = (
  coordinator: Coordinator.RemoteDispatchCoordinator["Service"],
  scope: McpInvocationScope,
  host: string | undefined,
  request: RemoteFollowUpInput["request"],
  sent: OrchestratorMcpThreadSendResult,
): Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure> =>
  host === undefined || scope.thread === undefined || sent.delivery === "relayed"
    ? Effect.succeed(sent)
    : coordinator
        .followUp({ originThreadId: scope.thread.threadId, host, request, sent })
        .pipe(
          Effect.mapError((error) =>
            isMcpFailure(error) ? error : notRecorded(request.clientRequestId),
          ),
        );
