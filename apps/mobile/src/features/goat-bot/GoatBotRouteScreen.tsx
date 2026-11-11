import { scopeThreadRef } from "@goat/client-runtime/environment";
import { ChannelTaskId } from "@goat/contracts";
import { goatBotName } from "@goat/client-runtime/goatBot";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { useAppForeground } from "../../lib/appState";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileBotPreview } from "./useMobileBotPreview";
import { useMobileGoatBotMember } from "./useMobileBotRoster";
import { useMobileBotManage } from "./useMobileBotManage";
import { GoatBotScreen } from "./GoatBotScreen";
import {
  recordGoatBotLocalRead,
  useGoatBotLocalRead,
  useGoatBotVisitSnapshot,
} from "./useGoatBotVisitSnapshot";

export function GoatBotRouteScreen({
  route,
}: StaticScreenProps<{ taskId?: string; botId?: string }>) {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  // A reply that arrives while the app is in the background has not been seen.
  const seen = focused && foreground;
  const { botRef } = useMobileGoatBotHomeMode();
  const botId = route.params?.botId;
  const { member, main, missing } = useMobileGoatBotMember(botId);
  const taskId = route.params?.taskId;
  const mainChat = !taskId && botId === undefined;
  const preview = useMobileBotPreview(botRef);
  // A member's chat marks its own conversation read, as the main chat does, so its roster row and
  // waiting count follow what the person has seen.
  const memberChat =
    !taskId && member !== null && member.state !== "deleted"
      ? { environmentId: member.environmentId, threadId: member.sessionThreadId }
      : null;
  const memberPreview = useMobileBotPreview(memberChat);
  const manage = useMobileBotManage(member?.environmentId ?? null, goatBotName(main));
  const environmentId = botRef?.environmentId;
  const threadId = botRef?.threadId;
  const unreadAt = preview?.unread ? preview.at : null;
  const shell = useThreadShell(
    environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null,
  );
  const conversation = environmentId && threadId ? `${environmentId}:${threadId}` : null;
  const serverTracksVisits = shell?.lastVisitedAt !== undefined;
  const newestAt = preview?.at ?? null;
  const localRead = useGoatBotLocalRead(conversation);
  // Where the person had read up to when they opened the chat, taken before the visit moves it.
  const readSnapshot = useGoatBotVisitSnapshot({
    focused: seen && mainChat,
    conversation,
    loaded: shell !== null && preview !== null,
    lastVisitedAt: serverTracksVisits ? (shell?.lastVisitedAt ?? null) : localRead,
    newestAt,
  });
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // oxlint-disable-next-line goat/react-effect-budget -- Persist the visit while the main conversation is visible.
  useEffect(() => {
    if (!seen || !mainChat || !environmentId || !threadId || !readSnapshot) return;
    if (!serverTracksVisits) {
      if (conversation !== null && newestAt !== null)
        recordGoatBotLocalRead(conversation, newestAt);
    } else if (unreadAt) {
      void visit({ environmentId, input: { threadId, visitedAt: unreadAt } });
    }
  }, [
    seen,
    mainChat,
    environmentId,
    threadId,
    unreadAt,
    readSnapshot,
    visit,
    serverTracksVisits,
    conversation,
    newestAt,
  ]);
  const memberUnreadAt = memberPreview?.unread ? memberPreview.at : null;
  const memberEnvironmentId = memberChat?.environmentId;
  const memberThreadId = memberChat?.threadId;
  // oxlint-disable-next-line goat/react-effect-budget -- Persist the visit while a member's conversation is visible.
  useEffect(() => {
    if (!seen || !memberEnvironmentId || !memberThreadId || !memberUnreadAt) return;
    void visit({
      environmentId: memberEnvironmentId,
      input: { threadId: memberThreadId, visitedAt: memberUnreadAt },
    });
  }, [seen, memberEnvironmentId, memberThreadId, memberUnreadAt, visit]);
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
      readSnapshot={mainChat ? readSnapshot : null}
    />
  );
}
