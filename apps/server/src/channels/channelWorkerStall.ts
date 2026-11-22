import type { ChannelTask } from "@goat/contracts";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor } from "./channelIds.ts";

/**
 * How long a running run can sit without thread activity before it is stalled. Same bound as
 * fleet thread health (`STALL_AFTER_MS`).
 */
export const STALLED_AFTER_MS = 20 * 60_000;

const stallNotice = (title: string) =>
  '"' +
  title +
  '" has made no progress for ' +
  STALLED_AFTER_MS / 60_000 +
  ' minutes. It may be stuck: say "stop" to stop it, or keep waiting.';

/** One notice per quiet period. A later period has a new activity time, so it notifies again. */
export const stallDelivery = (
  task: ChannelTask,
  runId: string,
  activityAt: string,
): ChannelLedger.ChannelOutboxInsert => {
  const causeKey = "stall:" + task.taskId + ":" + runId + ":" + activityAt;
  const deliveryId = deliveryIdFor(causeKey);
  const mentionActorId =
    task.originAddress.kind === "slack" ? task.requester.externalActorId : undefined;
  return {
    deliveryId,
    causeKey,
    taskId: task.taskId,
    message: {
      deliveryId,
      destination: task.originAddress,
      kind: "receipt",
      text: stallNotice(task.title),
      taskId: task.taskId,
      taskVersion: task.version,
      ...(mentionActorId === undefined ? {} : { mentionActorId }),
    },
  };
};
