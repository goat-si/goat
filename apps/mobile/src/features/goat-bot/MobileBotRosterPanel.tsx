import type { ReactNode } from "react";
import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { BotThreadRow, ChannelUpdateTaskViewInput } from "@goat/contracts";
import { Alert, Text, View } from "react-native";
import { MobileBotRosterView } from "./MobileBotRosterView";
import { useMobileBotRoster } from "./useMobileBotRoster";
import { useMobileBotPreview } from "./useMobileBotPreview";

export function MobileBotRoster(props: {
  header?: ReactNode;
  selectedKey: string | null;
  onOpenBot: (bot: BotRosterEntry) => void;
  onOpenChild: (row: BotThreadRow) => void;
}) {
  const roster = useMobileBotRoster(props.selectedKey);
  const preview = useMobileBotPreview();
  const update = (input: ChannelUpdateTaskViewInput) => {
    void roster.update(input).catch((error: unknown) => {
      Alert.alert(
        "Could not update task",
        error instanceof Error ? error.message : "Please try again.",
      );
    });
  };
  return (
    <View className="flex-1">
      {roster.error ? <Text className="px-4 text-danger-foreground">{roster.error}</Text> : null}
      <MobileBotRosterView
        header={props.header}
        bots={roster.bots}
        rows={roster.children.rows}
        hasMore={roster.children.hasMore}
        slackEnabled={roster.slackEnabled}
        preview={preview?.text}
        unread={preview?.unread}
        onOpenBot={props.onOpenBot}
        onOpenChild={props.onOpenChild}
        onShowMore={roster.showMore}
        onLongPressTask={(row) =>
          Alert.alert(row.task.title, undefined, [
            {
              text: row.view.pinnedAt ? "Unpin" : "Pin",
              onPress: () => update({ taskId: row.task.taskId, pinned: !row.view.pinnedAt }),
            },
            {
              text: row.view.doneAt ? "Reopen" : "Mark done",
              onPress: () => update({ taskId: row.task.taskId, done: !row.view.doneAt }),
            },
            {
              text: "Mark read",
              onPress: () => update({ taskId: row.task.taskId, readThrough: row.lastActivityAt }),
            },
            { text: "Cancel", style: "cancel" },
          ])
        }
      />
    </View>
  );
}
