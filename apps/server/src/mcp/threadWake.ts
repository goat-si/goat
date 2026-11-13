import type { ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { launchWakeKeyCrossing } from "../orchestration-v2/goat/launchWakeFolds.ts";
import { LAUNCH_WATCH_MESSAGE_PREFIX } from "./launchWatch.ts";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { LaunchWatchWake } from "./launchWatch.ts";

/**
 * Wakes a thread with a server message queued after its active run: the path launch watches
 * use for a finished or waiting launch, and handoffs use when a person answers. The wake's ids
 * are deterministic per event, so a replayed dispatch is a receipt, not a second message.
 */
export const wakeThread = Effect.fn("threadWake.wakeThread")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
  message: LaunchWatchWake,
) {
  const result = yield* threads.dispatch({
    type: "message.dispatch",
    commandId: message.commandId,
    threadId,
    messageId: message.messageId,
    text: message.text,
    notification: message.notification,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  });
  const key = message.notification.aboutRunId;
  if (message.messageId.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX) && key !== undefined) {
    // This diagnostic is best-effort when wakes arrive concurrently.
    const records = yield* threads
      .getThreadRecords(threadId, ["runs", "messages"])
      .pipe(Effect.option);
    if (Option.isSome(records)) {
      const count = launchWakeKeyCrossing(records.value, message.messageId, key);
      if (count !== undefined)
        yield* Effect.logWarning(`Thread ${threadId} has ${count} queued launch wake keys`);
    }
  }
  return result;
});

/**
 * Orchestrator refusals a retry cannot change. A previously rejected command
 * is not one of them: the orchestrator also records a command that failed for
 * a passing reason as rejected, so the wake is retried under a fresh id.
 */
const PERMANENT_DISPATCH_ERRORS = new Set([
  "OrchestratorCommandRejectedError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadAboveModeLimitError",
]);

export const isPermanentDispatchFailure = (cause: Cause.Cause<unknown>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      PERMANENT_DISPATCH_ERRORS.has(String(error._tag)),
  });
