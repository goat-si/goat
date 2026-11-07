import type { ChannelTaskId, OrchestrationV2Run } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { commitTransition } from "./channelTaskWrites.ts";

/**
 * Binds the task to the run that took its message, lifting the completion fence the message set
 * in the same write. False when another write moved the task first; the next pass tries again.
 */
export const bindAfterSend = Effect.fn("ChannelBotSession.bindAfterSend")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  taskId: ChannelTaskId,
  own: ReadonlyArray<string>,
  run: OrchestrationV2Run,
  owner: string,
) {
  const latest = yield* ledger.getTask(taskId);
  if (latest?.task.worker === undefined) return true;
  const ownsFence =
    latest.pendingAnswerMessageId !== undefined && own.includes(latest.pendingAnswerMessageId);
  if (!ownsFence && latest.task.worker.runId === run.id) return true;
  const bound = yield* commitTransition(
    ledger,
    latest,
    { type: "task.worker.bound", payload: { worker: { ...latest.task.worker, runId: run.id } } },
    { owner, ...(ownsFence ? { pendingAnswerMessageId: null } : {}) },
  );
  return bound !== undefined;
});
