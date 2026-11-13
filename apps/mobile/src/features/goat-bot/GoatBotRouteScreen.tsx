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
}: StaticScreenProps<{ taskId?: string; botId?: string; taskTitle?: string }>) {
  const focused = useIsFocused();
  const active = useAppActive();
  const foreground = useAppForeground();
  // A reply that arrives while the app is inactive (the app switcher, Control Center) or in the
  // background has not been seen, and no visit is written then. Only the background ends the
  // visit: a moment of inactivity keeps its unread boundary.
  const seen = focused && active;
  const { botRef } = useMobileGoatBotHomeMode();
  const botId = route.params?.botId;
  const { member, main, missing } = useMobileGoatBotMember(botId);
  const taskId = route.params?.taskId;
  const mainChat = !taskId && botId === undefined;
  const preview = useMobileBotPreview(botRef);
  const memberChat =
    !taskId && member !== null && member.state !== "deleted"
      ? { environmentId: member.environmentId, threadId: member.sessionThreadId }
      : null;
  const memberPreview = useMobileBotPreview(memberChat);
  const manage = useMobileBotManage(member?.environmentId ?? null, goatBotName(main));
  const environmentId = botRef?.environmentId;
  const threadId = botRef?.threadId;
  // The conversation this chat shows and reads: the main bot's or the member's own.
  const chat = mainChat
    ? environmentId && threadId
      ? { environmentId, threadId }
      : null
    : memberChat;
  const chatPreview = mainChat ? preview : memberPreview;
  const unreadAt = chatPreview?.unread ? chatPreview.at : null;
  const shell = useThreadShell(chat ? scopeThreadRef(chat.environmentId, chat.threadId) : null);
  const conversation = chat ? `${chat.environmentId}:${chat.threadId}` : null;
  const serverTracksVisits = shell?.lastVisitedAt !== undefined;
  const newestAt = chatPreview?.at ?? null;
  const localRead = useGoatBotLocalRead(conversation);
  // Where the person had read up to when they opened the chat, taken before the visit moves it.
  const readSnapshot = useGoatBotVisitSnapshot({
    focused: focused && foreground && chat !== null,
    reading: seen,
    conversation,
    loaded: shell !== null && chatPreview !== null,
    lastVisitedAt: serverTracksVisits ? (shell?.lastVisitedAt ?? null) : localRead,
    newestAt,
  });
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const chatEnvironmentId = chat?.environmentId;
  const chatThreadId = chat?.threadId;
  // A member's chat marks its own conversation read, as the main chat does, so its roster row and
  // waiting count follow what the person has seen.
  // oxlint-disable-next-line goat/react-effect-budget -- Persist the visit while the conversation is visible.
  useEffect(() => {
    if (!seen || !chatEnvironmentId || !chatThreadId || !readSnapshot) return;
    if (!serverTracksVisits) {
      if (conversation !== null && newestAt !== null)
        recordGoatBotLocalRead(conversation, newestAt);
    } else if (unreadAt) {
      void visit({
        environmentId: chatEnvironmentId,
        input: { threadId: chatThreadId, visitedAt: unreadAt },
      });
    }
  }, [
    seen,
    chatEnvironmentId,
    chatThreadId,
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
      foreground={foreground}
      seen={seen}
      member={member}
      main={main}
      onRestoreMember={
        member !== null && member.state === "deleted" && manage.canManage
          ? () => manage.restore(member)
          : undefined
      }
      taskId={taskId ? ChannelTaskId.make(taskId) : undefined}
      taskTitle={route.params?.taskTitle}
      readSnapshot={chat !== null ? readSnapshot : null}
    />
  );
}
