import {
  OrchestratorMcpFailure,
  type OriginBoundForceStopInput,
  type OriginBoundForceStopResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { assertTargetWithinLimits, type CallerLimits, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ORIGIN_FORCE_STOP_PREFIX } from "../orchestration-v2/runTerminationCause.ts";
import { boundOriginLabel } from "./originBinding.ts";

/**
 * goat#2338, on the host: the origin that launched this thread as a task Force stops the task's
 * run once it ignored the cancel. Every refusal stops nothing.
 */
export const originBoundForceStop = Effect.fn("remoteReports.originBoundForceStop")(function* (
  input: OriginBoundForceStopInput,
  limits: CallerLimits,
) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const originLabel = yield* boundOriginLabel(sql, input);
  const shell = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null)
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The bound thread was not found.",
    });
  yield* assertTargetWithinLimits(limits, shell);
  const forced = yield* threads
    .forceStopUnresponsiveRun({
      threadId: input.threadId,
      runId: input.runId,
      reason: `${ORIGIN_FORCE_STOP_PREFIX}${originLabel}`,
      subject: `thread ${input.threadId}`,
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "DelegatedForceStopRefused"
          ? new OrchestratorMcpFailure({ code: "task_not_cancellable", message: error.message })
          : error._tag === "OrchestrationV2ForceStopThreadError" && error.reason !== undefined
            ? new OrchestratorMcpFailure({
                code: "task_not_cancellable",
                message: `${error.reason}: ${error.message}`,
              })
            : unavailable(),
      ),
    );
  return {
    outcome: forced.outcome,
    sharedWithThreadIds: forced.sharedWithThreadIds,
  } satisfies OriginBoundForceStopResult;
});
