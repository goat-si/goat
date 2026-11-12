import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadUnwatchResult,
  type OrchestratorMcpThreadWatchInput,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import { AGENT_DISMISS_AFTER_MS } from "../remoteReports/remoteDispatchDismiss.ts";
import { storeFailure } from "./hostThreadsResults.ts";
import type * as LaunchWatchService from "./LaunchWatchService.ts";

/**
 * Removes the caller's watch. On another host it also stops the caller's own report tracking of
 * that thread once its host has not answered for AGENT_DISMISS_AFTER_MS; reports from a host
 * that answers, or that only blipped, keep arriving.
 */
export const unwatchLaunch = Effect.fn("HostThreadsMcpService.unwatchLaunch")(function* (input: {
  readonly launchWatches: LaunchWatchService.LaunchWatchServiceShape;
  readonly coordinator: RemoteDispatchCoordinator.RemoteDispatchCoordinator["Service"];
  /** The calling thread, from its invocation scope; never an argument. */
  readonly launcherThreadId: ThreadId;
  readonly target: OrchestratorMcpThreadWatchInput;
}) {
  const { host, threadId } = input.target;
  const removed = yield* input.launchWatches
    .unwatch({ launcherThreadId: input.launcherThreadId, host, threadId })
    .pipe(Effect.mapError(storeFailure));
  if (host === undefined) return { threadId, removed } satisfies OrchestratorMcpThreadUnwatchResult;
  const stopped = yield* input.coordinator
    .dismiss({
      host,
      remoteThreadId: threadId,
      originThreadId: input.launcherThreadId,
      unreachableForMs: AGENT_DISMISS_AFTER_MS,
    })
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message:
              "The watch was removed, but GOAT could not stop following this thread's reports.",
          }),
      ),
    );
  return {
    host,
    threadId,
    removed,
    reportsStopped: stopped.length > 0,
  } satisfies OrchestratorMcpThreadUnwatchResult;
});
