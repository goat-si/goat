import type {
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@goat/contracts";
import { LAUNCH_WATCH_MESSAGE_PREFIX } from "../../mcp/launchWatch.ts";
import { queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";
import { isNoticeMessage, parseNotices } from "../TurnDigest.ts";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const stampedMessage = (projection: Projection, messageId: string) => {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  return message !== undefined &&
    isNoticeMessage(message) &&
    message.notification?.aboutRunId !== undefined &&
    parseNotices(message.id, message.text).every((notice) =>
      notice.id.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX),
    )
    ? message
    : undefined;
};

export function launchWakeFoldTarget(projection: Projection, command: Dispatch) {
  const runs = queuedRunsInDeliveryOrder(projection);
  if (
    command.messageId.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX) &&
    command.notification?.aboutRunId !== undefined
  ) {
    const run = runs.findLast((candidate) => {
      const message = stampedMessage(projection, candidate.userMessageId);
      return (
        message !== undefined &&
        message.notification?.aboutRunId === command.notification?.aboutRunId &&
        message.notification?.source.kind === command.notification?.source.kind
      );
    });
    return run === undefined ? ("own" as const) : { run };
  }
  const tail = runs.at(-1);
  return tail !== undefined && stampedMessage(projection, tail.userMessageId) !== undefined
    ? ("own" as const)
    : ("none" as const);
}

export const LAUNCH_WAKE_KEY_WARNING = 8;
export function launchWakeKeys(projection: Projection) {
  return new Set(
    queuedRunsInDeliveryOrder(projection).flatMap((run) => {
      const key = stampedMessage(projection, run.userMessageId)?.notification?.aboutRunId;
      return key === undefined ? [] : [key];
    }),
  );
}
export function launchWakeKeyCrossing(
  projection: Projection,
  messageId: string,
  aboutRunId: RunId,
) {
  const keys = launchWakeKeys(projection);
  if (keys.size !== LAUNCH_WAKE_KEY_WARNING + 1) return undefined;
  const matching = queuedRunsInDeliveryOrder(projection).filter(
    (run) => stampedMessage(projection, run.userMessageId)?.notification?.aboutRunId === aboutRunId,
  );
  return matching.length === 1 && matching[0]?.userMessageId === messageId ? keys.size : undefined;
}
