import { ChannelTaskId } from "@goat/contracts";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileBotPreview } from "./useMobileBotPreview";
import { useMobileGoatBotMember } from "./useMobileBotRoster";
import { useMobileBotManage } from "./useMobileBotManage";
import { GoatBotScreen } from "./GoatBotScreen";

export function GoatBotRouteScreen({
  route,
}: StaticScreenProps<{ taskId?: string; botId?: string }>) {
  const focused = useIsFocused();
  const { botRef } = useMobileGoatBotHomeMode();
  const preview = useMobileBotPreview();
  const botId = route.params?.botId;
  const { member, main, missing } = useMobileGoatBotMember(botId);
  const manage = useMobileBotManage(member?.environmentId ?? null);
  const environmentId = botRef?.environmentId;
  const threadId = botRef?.threadId;
  const taskId = route.params?.taskId;
  const unreadAt = preview?.unread ? preview.at : null;
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // oxlint-disable-next-line goat/react-effect-budget -- Persist the visit while the main conversation is visible.
  useEffect(() => {
    if (focused && !taskId && botId === undefined && environmentId && threadId && unreadAt) {
      void visit({ environmentId, input: { threadId, visitedAt: unreadAt } });
    }
  }, [focused, taskId, botId, environmentId, threadId, unreadAt, visit]);
  // A named member never falls back to the main bot's conversation.
  if (botId !== undefined && member === null)
    return (
      <View className="flex-1 items-center justify-center bg-screen px-6">
        <Text className="text-center text-foreground-muted">
          {missing ? "This bot isn't available." : "Loading…"}
        </Text>
      </View>
    );
  return (
    <GoatBotScreen
      visible={focused}
      member={member}
      main={main}
      onRestoreMember={
        member !== null && member.state === "deleted" && manage.canManage
          ? () => manage.restore(member)
          : undefined
      }
      taskId={taskId ? ChannelTaskId.make(taskId) : undefined}
    />
  );
}
