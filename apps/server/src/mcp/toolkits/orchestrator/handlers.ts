import { OrchestratorMcpFailure } from "@goat/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import type { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { isTerminalRunStatus } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { admitLaunch, withPressure } from "../../pressureAdmission.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";

/** Whether a thread tool call goes to another machine. */
const reachesHost = <
  P extends { readonly host?: string | undefined; readonly allHosts?: boolean | undefined },
>(
  input: P,
) => input.host !== undefined || input.allHosts === true;

/** Threads on another machine are checked by that machine; it gets no local target to check. */
const localTargets = <
  P extends { readonly host?: string | undefined; readonly threadId: ThreadId },
>(
  input: P,
) => (input.host === undefined ? [input.threadId] : []);

/**
 * A local thread's structured run result. A thread on another machine gets
 * its result from that machine's own read.
 */
const localResult = (threadId: ThreadId, runId?: RunId | null) =>
  ThreadResultService.ThreadResultService.pipe(
    Effect.flatMap((results) => results.forRun(threadId, runId)),
    Effect.mapError(unavailable),
  );

const handlers = {
  orchestrator_capabilities: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.capabilities(scope, input);
    }),
  ),
  delegate_task: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pressure = yield* admitLaunch(input.target?.host ?? null);
        return withPressure(yield* service.delegateTask(scope, input), pressure);
      }),
    ),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  goat_review_findings_record: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.recordReviewFindings(scope, input);
    }),
  ),
  goat_review_findings_export: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.exportReviewFindings(scope, input);
    }),
  ),
  task_cancel: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.cancelTask(scope, input);
      }),
    ),
  ),
  goat_workflow_stop: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const { threads } = yield* readCaller();
          return yield* threads.stopWorkflow(input).pipe(
            Effect.as({}),
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  code:
                    cause.reason === "unavailable" || cause.reason === "stop-failed"
                      ? "orchestration_error"
                      : "invalid_request",
                  message: cause.message,
                }),
            ),
          );
        }),
    ),
  ),
  schedule_task: McpToolAccess.destructive(
    McpToolAccess.startsThreads(
      // A scheduled task runs with the caller's own modes.
      () => ({}),
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.scheduleTask(scope, input);
        }),
    ),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  update_scheduled_task: McpToolAccess.destructive(
    McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.updateScheduledTask(scope, input);
      }),
    ),
  ),
  delete_scheduled_task: McpToolAccess.destructive(
    McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.deleteScheduledTask(scope, input);
      }),
    ),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.createThreads(scope, input);
      }),
    ),
  ),
  goat_thread_list: McpToolAccess.readsOrReachesHost(reachesHost, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.listThreads(scope, input);
    }),
  ),
  goat_thread_read: McpToolAccess.readsOrReachesHost(reachesHost, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.readThread(scope, input);
    }),
  ),
  goat_thread_update: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
          return yield* service.update(scope, input);
        }),
    ),
  ),
  goat_thread_send: McpToolAccess.destructive(
    McpToolAccess.writesThreads(localTargets, (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* HostThreadsMcpService.HostThreadsMcpService;
        return yield* service.sendToThread(scope, input);
      }),
    ),
  ),
  goat_thread_wait: McpToolAccess.readsOrReachesHost(reachesHost, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      const waited = yield* service.waitForThread(scope, input);
      if (input.host !== undefined || waited.timedOut || waited.runId === null) return waited;
      const result = yield* localResult(input.threadId, waited.runId);
      return result === null || !isTerminalRunStatus(result.runStatus)
        ? waited
        : { ...waited, result };
    }),
  ),
  goat_thread_interrupt: McpToolAccess.destructive(
    McpToolAccess.writesThreads(localTargets, (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* HostThreadsMcpService.HostThreadsMcpService;
        return yield* service.interruptThread(scope, input);
      }),
    ),
  ),
  goat_thread_status: McpToolAccess.readsOrReachesHost(reachesHost, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.threadStatus(scope, input);
    }),
  ),
  goat_thread_replication_set: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.configureReplication(scope, input);
    }),
  ),
  goat_thread_checkpoint_capture: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* HostThreadsMcpService.HostThreadsMcpService;
        return yield* service.captureCheckpoint(scope, input);
      }),
  ),
  goat_thread_checkpoint_reconcile: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.reconcileCheckpoint(scope, input);
    }),
  ),
  goat_thread_checkpoint_restore: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.restoreCheckpoint(scope, input);
    }),
  ),
  goat_thread_handoff_host: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.recoverCheckpoint(scope, input);
    }),
  ),
  goat_thread_watch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.watchThread(scope, input);
    }),
  ),
  goat_thread_unwatch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.unwatchThread(scope, input);
    }),
  ),
  goat_thread_watch_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.listWatches(scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
