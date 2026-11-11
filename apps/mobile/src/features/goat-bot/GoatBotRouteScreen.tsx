import { scopeThreadRef } from "@goat/client-runtime/environment";
import { ChannelTaskId } from "@goat/contracts";
import { goatBotName } from "@goat/client-runtime/goatBot";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { useAppActive, useAppForeground } from "../../lib/appState";
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
  const active = useAppActive();
  const foreground = useAppForeground();
  // A reply that arrives while the app is inactive (the app switcher, Control Center) or in the
  // background has not been seen, and no visit is written then. Only the background ends the
  // visit: a moment of inactivity keeps its unread boundary.
  const seen = focused && active;
  const { botRef } = useMobileGoatBotHomeMode();
  const preview = useMobileBotPreview();
  const botId = route.params?.botId;
  const { member, main, missing } = useMobileGoatBotMember(botId);
  const manage = useMobileBotManage(member?.environmentId ?? null, goatBotName(main));
  const environmentId = botRef?.environmentId;
  const threadId = botRef?.threadId;
  const taskId = route.params?.taskId;
  const unreadAt = preview?.unread ? preview.at : null;
  const mainChat = !taskId && botId === undefined;
  const shell = useThreadShell(
    environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null,
  );
  const conversation = environmentId && threadId ? `${environmentId}:${threadId}` : null;
  const serverTracksVisits = shell?.lastVisitedAt !== undefined;
  const newestAt = preview?.at ?? null;
  const localRead = useGoatBotLocalRead(conversation);
  // Where the person had read up to when they opened the chat, taken before the visit moves it.
  const readSnapshot = useGoatBotVisitSnapshot({
    focused: focused && foreground && mainChat,
    reading: seen,
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
