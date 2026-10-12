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
  orchestrator_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.capabilities(scope);
    }),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  goat_workflow_stop: McpToolAccess.writesThreads(
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
  schedule_task: McpToolAccess.startsThreads(
    // A scheduled task runs with the caller's own modes.
    () => ({}),
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.scheduleTask(scope, input);
      }),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  update_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  goat_thread_list: McpToolAccess.readsOrReachesHost(reachesHost, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.listThreads(scope, input);
    }),
  ),
  // Reading a child's finished result also acknowledges its delivery to the
  // reader's own thread. That is bookkeeping on the caller's own subagent, not
  // a change to anything it reads, so this stays a read.
  goat_thread_read: McpToolAccess.readsOrReachesHost(reachesHost, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      const read = yield* service.readThread(scope, input);
      if (input.host !== undefined) return read;
      return { ...read, result: yield* localResult(input.threadId, read.thread.latestRunId) };
    }),
  ),
  goat_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  goat_thread_send: McpToolAccess.writesThreads(localTargets, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.sendToThread(scope, input);
    }),
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
  goat_thread_interrupt: McpToolAccess.writesThreads(localTargets, (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* HostThreadsMcpService.HostThreadsMcpService;
      return yield* service.interruptThread(scope, input);
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
