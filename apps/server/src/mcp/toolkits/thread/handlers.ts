import {
  OrchestratorMcpFailure,
  ThreadId,
  type CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@goat/contracts";
import { modelSelectionCommandType } from "@goat/shared/model";
import * as Effect from "effect/Effect";

import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PendingQuestionsMcpService from "../../PendingQuestionsMcpService.ts";
import { dispatchFailure, newCommandId, readThread, unavailable } from "../../threadAccess.ts";
import * as ThreadSearchMcpService from "../../ThreadSearchMcpService.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  goat_thread_report_result: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "goat_thread_report_result"),
        ),
      );
      const results = yield* ThreadResultService.ThreadResultService;
      return yield* results
        .report(scope.thread.threadId, input)
        .pipe(
          Effect.mapError((error) =>
            error.reason === "run_not_found"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
              : unavailable(),
          ),
        );
    }),
  ),
  run_scheduled_task_now: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
        if (!tasks.some((task) => task.id === input.taskId))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The scheduled task was not found.",
          });
        const { task } = yield* scheduler
          .runNow({ id: input.taskId })
          .pipe(Effect.mapError(unavailable));
        return {
          taskId: task.id,
          threadId: task.threadId,
          lastRunStatus: task.lastRunStatus,
          runCount: task.runCount,
          nextRunAt: task.nextRunAt,
        };
      }),
    ),
  ),
  // Reaching another machine uses this machine's SSH keys, as goat_thread_list does.
  goat_thread_search: McpToolAccess.readsOrReachesHost(
    (input) => input.host !== undefined || input.hosts !== undefined || input.allHosts === true,
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const search = yield* ThreadSearchMcpService.ThreadSearchMcpService;
        return yield* search.search(scope, input);
      }),
  ),
  goat_thread_fork: McpToolAccess.destructive(
    writesThread((input) =>
      Effect.gen(function* () {
        const { threads, projection } = yield* readThread(input.threadId);
        const commandId = yield* newCommandId();
        const targetThreadId = ThreadId.make(`${commandId}:fork`);
        const result = yield* threads
          .dispatch({
            type: "thread.fork",
            commandId,
            sourceThreadId: projection.thread.id,
            targetThreadId,
            sourcePoint: input.sourcePoint,
            ...(input.title === undefined ? {} : { title: input.title }),
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId };
      }),
    ),
  ),
  goat_thread_merge_back: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.targetThreadId, input.sourceThreadId],
      (input) =>
        Effect.gen(function* () {
          const context = yield* readThread(input.targetThreadId);
          const source = yield* readThread(input.sourceThreadId);
          const result = yield* context.threads
            .dispatch({
              type: "thread.merge_back",
              commandId: yield* newCommandId(),
              sourceThreadId: source.projection.thread.id,
              targetThreadId: input.targetThreadId,
              sourcePoint: input.sourcePoint,
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId: input.targetThreadId };
        }),
    ),
  ),
  goat_thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  goat_thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  ),
  goat_thread_configure: McpToolAccess.destructive(
    writesThread((input) =>
      Effect.gen(function* () {
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
        const result = yield* threads
          .dispatch({
            type,
            threadId: thread.id,
            commandId: yield* newCommandId(),
            modelSelection: input.modelSelection,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  goat_pending_request_list: McpToolAccess.readsOrReachesHost(
    (input) =>
      input.host !== undefined ||
      (input.scope === "launched" &&
        input.launcherThreadId === undefined &&
        input.launcherEnvironmentId === undefined),
    (input) =>
      Effect.gen(function* () {
        const service = yield* PendingQuestionsMcpService.PendingQuestionsMcpService;
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return yield* service.list(scope, input);
      }),
  ),
  goat_pending_request_read: McpToolAccess.readsOrReachesHost(
    (input) => input.host !== undefined,
    (input) =>
      Effect.gen(function* () {
        const service = yield* PendingQuestionsMcpService.PendingQuestionsMcpService;
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return yield* service.read(scope, input);
      }),
  ),
  goat_pending_request_respond: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => (input.host === undefined ? [input.threadId] : []),
      (input) =>
        Effect.gen(function* () {
          const service = yield* PendingQuestionsMcpService.PendingQuestionsMcpService;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          return yield* service.respond(scope, input);
        }),
      {
        refusalSuffix:
          " This question needs a person: forward it to the user in your own thread, or let them answer it in the asking thread.",
      },
    ),
  ),
  goat_queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  goat_queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  goat_queue_edit: McpToolAccess.destructive(
    writesThread((input) =>
      dispatch(input.threadId, (common) => ({
        ...common,
        type: "queued-run.edit",
        runId: input.queuedRunId,
        text: input.text,
      })),
    ),
  ),
  goat_queue_cancel: McpToolAccess.destructive(
    writesThread((input) =>
      dispatch(input.threadId, (common) => ({
        ...common,
        type: "queued-run.cancel",
        runId: input.queuedRunId,
      })),
    ),
  ),
  goat_queue_reorder: McpToolAccess.destructive(
    writesThread((input) =>
      dispatch(input.threadId, (common) => ({
        ...common,
        type: "queued-run.reorder",
        runId: input.queuedRunId,
        beforeRunId: input.beforeRunId,
      })),
    ),
  ),
  goat_queue_promote_to_steer: McpToolAccess.destructive(
    writesThread((input) =>
      dispatch(input.threadId, (common) => ({
        ...common,
        type: "queued-message.promote-to-steer",
        queuedRunId: input.queuedRunId,
        targetRunId: input.targetRunId,
      })),
    ),
  ),
  goat_thread_organize: McpToolAccess.destructive(
    writesThread((input) =>
      Effect.gen(function* () {
        const { threads, projection, caller } = yield* readThread(input.threadId);
        const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
        if (input.action === "settle") {
          return yield* threads
            .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
            .pipe(Effect.mapError(dispatchFailure));
        }
        let command: OrchestrationV2Command;
        switch (input.action) {
          case "snooze":
            if (input.snoozedUntil === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "snooze requires snoozedUntil.",
              });
            }
            command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
            break;
          case "unsnooze":
          case "unsettle":
            command = { ...common, type: `thread.${input.action}`, reason: "user" };
            break;
          case "mark_unread":
            command = { ...common, type: "thread.mark-unread" };
            break;
          default:
            command = { ...common, type: `thread.${input.action}` };
        }
        const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
});
