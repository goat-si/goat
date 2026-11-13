import type { OrchestrationV2Command, OrchestrationV2ThreadProjection } from "@goat/contracts";
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
    const index = runs.findLastIndex((candidate) => {
      const message = stampedMessage(projection, candidate.userMessageId);
      return (
        message !== undefined &&
        message.notification?.aboutRunId === command.notification?.aboutRunId &&
        message.notification?.source.kind === command.notification?.source.kind
      );
    });
    // A user message queued after that turn is a barrier: a newer result must not run before it.
    const barrier = runs
      .slice(index + 1)
      .some(
        (later) =>
          projection.messages.find((message) => message.id === later.userMessageId)?.createdBy ===
          "user",
      );
    const run = runs[index];
    return run === undefined || barrier ? ("own" as const) : { run };
  }
  const tail = runs.at(-1);
  return tail !== undefined && stampedMessage(projection, tail.userMessageId) !== undefined
    ? ("own" as const)
    : ("none" as const);
}
