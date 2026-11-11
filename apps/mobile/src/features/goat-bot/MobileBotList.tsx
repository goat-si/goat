import { useNavigationState } from "@react-navigation/native";
import { View } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { MobileBotRoster } from "./MobileBotRosterPanel";
import { MobileHomeSegments } from "./MobileBotRosterView";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

export function MobileHomeModeSegments() {
  const home = useMobileGoatBotHomeMode();
  return home.known ? <MobileHomeSegments mode={home.mode} onSelect={home.setMode} /> : null;
}

export function MobileBotList({
  showSegments = true,
  visible = true,
}: {
  readonly showSegments?: boolean;
  /** The list is on screen; a layout that keeps it mounted underneath passes false. */
  readonly visible?: boolean;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  const selectedKey = useNavigationState((state) => {
    const route = state.routes[state.index];
    const params = route?.params as
      | { taskId?: string; environmentId?: string; threadId?: string }
      | undefined;
    const botId = (params as { botId?: string } | undefined)?.botId;
    if (route?.name === "GoatBot")
      return params?.taskId ? `task:${params.taskId}` : botId ? `bot:${botId}` : "main";
    if (route?.name === "Thread" && params?.environmentId && params.threadId)
      return `coding:${params.environmentId}:${params.threadId}`;
    return null;
  });
  return (
    <View className="flex-1 bg-screen">
      <MobileBotRoster
        header={showSegments ? <MobileHomeModeSegments /> : null}
        selectedKey={selectedKey}
        onOpenBot={(bot) =>
          selectDetail({
            name: "GoatBot",
            params: bot.kind === "member" ? { botId: bot.profile.botId } : {},
          })
        }
        onOpenTask={(bot, taskId) =>
          selectDetail({
            name: "GoatBot",
            params: bot.kind === "member" ? { botId: bot.profile.botId, taskId } : { taskId },
          })
        }
        visible={visible}
      />
    </View>
  );
}
