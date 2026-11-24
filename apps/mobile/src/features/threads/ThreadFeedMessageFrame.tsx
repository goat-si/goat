import type { EnvironmentId, ThreadId } from "@goat/contracts";
import type { ReactNode } from "react";
import type { ColorValue } from "react-native";
import { isCompactionCommandFeedEntry, type ThreadFeedRow } from "./pending-thread-feed";
import { ThreadModelSwitchDivider } from "./thread-handoff-row";
import { ThreadFeedReplyProbe } from "./ThreadFeedReplyProbe";
import { TurnMemoryDetails } from "./TurnMemoryDetails";

export function ThreadFeedMessageFrame({
  entry,
  environmentId,
  threadId,
  iconColor,
  children,
}: {
  entry: ThreadFeedRow;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  iconColor: ColorValue;
  children: ReactNode;
}) {
  return (
    <>
      {entry.type === "message" && entry.message.role === "assistant" ? (
        <ThreadFeedReplyProbe
          environmentId={String(environmentId)}
          threadId={String(threadId)}
          messageId={String(entry.message.id)}
          length={entry.message.text.length}
        />
      ) : null}
      {entry.type === "message" &&
      !isCompactionCommandFeedEntry(entry) &&
      entry.message.projectedItem?.item.type === "user_message" &&
      entry.message.projectedItem.item.modelSwitch ? (
        <ThreadModelSwitchDivider
          environmentId={environmentId}
          modelSwitch={entry.message.projectedItem.item.modelSwitch}
          iconColor={iconColor}
        />
      ) : null}
      {children}
      {entry.type === "message" &&
      entry.message.role === "user" &&
      entry.message.runId &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer" ? (
        <TurnMemoryDetails
          environmentId={environmentId}
          threadId={entry.message.projectedItem?.item.threadId ?? threadId}
          runId={entry.message.runId}
        />
      ) : null}
    </>
  );
}
