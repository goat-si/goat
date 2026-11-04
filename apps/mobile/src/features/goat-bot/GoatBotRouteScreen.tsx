import { ChannelTaskId } from "@goat/contracts";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileBotPreview } from "./useMobileBotPreview";
import { GoatBotScreen } from "./GoatBotScreen";

export function GoatBotRouteScreen({ route }: StaticScreenProps<{ taskId?: string }>) {
  const focused = useIsFocused();
  const { botRef } = useMobileGoatBotHomeMode();
  const preview = useMobileBotPreview();
  const environmentId = botRef?.environmentId;
  const threadId = botRef?.threadId;
  const taskId = route.params?.taskId;
  const unreadAt = preview?.unread ? preview.at : null;
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // oxlint-disable-next-line goat/react-effect-budget -- Persist the visit while the main conversation is visible.
  useEffect(() => {
    if (focused && !taskId && environmentId && threadId && unreadAt) {
      void visit({ environmentId, input: { threadId, visitedAt: unreadAt } });
    }
  }, [focused, taskId, environmentId, threadId, unreadAt, visit]);
  return (
    <GoatBotScreen visible={focused} taskId={taskId ? ChannelTaskId.make(taskId) : undefined} />
  );
}
