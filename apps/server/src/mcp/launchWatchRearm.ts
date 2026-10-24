import type {
  OrchestratorMcpThreadRetryInput,
  OrchestratorMcpThreadRetryResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

type LaunchWatches = LaunchWatchService.LaunchWatchServiceShape;

const followRetriedRun = (
  launchWatches: LaunchWatches,
  input: Parameters<LaunchWatches["rearmRetried"]>[0],
) =>
  launchWatches.rearmRetried(input).pipe(
    Effect.catch((error) =>
      Effect.logWarning("launch watch: retry not followed", {
        threadId: input.threadId,
        cause: error,
      }),
    ),
  );

/**
 * The caller's own watch of a thread: its thread's, or for an outside caller
 * the launcherless watch its own launch made, never another caller's.
 */
export const watchKeyOf = (
  scope: McpInvocationScope,
  target: { readonly host: string | undefined; readonly threadId: ThreadId },
): LaunchWatchService.LaunchWatchKey =>
  scope.thread === undefined
    ? { launcherThreadId: null, owner: scope.requestNamespace, ...target }
    : { launcherThreadId: scope.thread.threadId, ...target };

/**
 * A send from a watching thread is followed like its launch: the run it
 * started or joined is reported when it ends. A send from outside any thread
 * re-arms the launcherless watch its launch made, so the completion webhook
 * hears about follow-up runs too. Bookkeeping must never fail the send itself.
 */
export const rearmAfterSend = (
  launchWatches: LaunchWatches,
  scope: McpInvocationScope,
  input: OrchestratorMcpThreadSendInput,
  result: OrchestratorMcpThreadSendResult,
) =>
  result.delivery === "relayed"
    ? Effect.void
    : launchWatches
        .rearm({
          ...watchKeyOf(scope, { host: input.host, threadId: input.threadId }),
          runId: result.runId,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("launch watch: send not followed", {
              threadId: input.threadId,
              cause: error,
            }),
          ),
        );

/**
 * A retry moves the same run back to preparing, so every watch that reported its failure
 * follows it again. An answer that only says the run is preparing is followed the same way;
 * a watch reports only ends it has not reported. Bookkeeping must never fail the retry itself.
 */
export const rearmAfterRetry = (
  launchWatches: LaunchWatches,
  input: OrchestratorMcpThreadRetryInput,
  result: OrchestratorMcpThreadRetryResult,
) =>
  followRetriedRun(launchWatches, {
    host: input.host,
    threadId: input.threadId,
    runId: result.runId,
  });

export type PreparedRunRetryServices =
  | ThreadLaunchService.ThreadLaunchService
  | LaunchWatchService.LaunchWatchService;

/**
 * Retry on a run that failed preparing its workspace, from a client: restarts the preparation
 * work the launch owns, then has the watches that reported the failure follow the run again.
 */
export const retryPreparedRun = Effect.fn("LaunchWatch.retryPreparedRun")(function* (
  command: ThreadLaunchService.ThreadLaunchPreparationInput,
) {
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const dispatched = yield* threadLaunch.retryPreparation(command);
  const launchWatches = yield* LaunchWatchService.LaunchWatchService;
  yield* followRetriedRun(launchWatches, {
    host: null,
    threadId: command.threadId,
    runId: command.runId,
  });
  return dispatched;
});
