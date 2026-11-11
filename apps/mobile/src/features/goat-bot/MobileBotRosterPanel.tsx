import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { goatBotName, type BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelTaskId } from "@goat/contracts";
import { Alert, Text, View } from "react-native";
import { MobileBotEditSheet } from "./MobileBotEditSheet";
import { MobileBotRosterView } from "./MobileBotRosterView";
import {
  dismissNewBot,
  newBotOperation,
  registerNewBotOpener,
  retryNewBot,
  settleListedNewBot,
  startNewBot,
  subscribeNewBots,
  type CreateNewBot,
} from "./mobileNewBots";
import { MobileNewBotStatus } from "./MobileNewBotStatus";
import { useMobileBotRoster } from "./useMobileBotRoster";
import { useMobileBotPreview } from "./useMobileBotPreview";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileBotManage } from "./useMobileBotManage";

export function MobileBotRoster(props: {
  header?: ReactNode;
  selectedKey: string | null;
  onOpenBot: (bot: BotRosterEntry) => void;
  onOpenTask?: (bot: BotRosterEntry, taskId: ChannelTaskId) => void;
  visible?: boolean;
}) {
  const roster = useMobileBotRoster();
  const preview = useMobileBotPreview(useMobileGoatBotHomeMode().botRef);
  const mainName = goatBotName(roster.groups.main);
  const manage = useMobileBotManage(roster.environmentId, mainName);
  const [editing, setEditing] = useState<BotProfile | null>(null);
  const environmentId = roster.environmentId;
  const operation = useSyncExternalStore(subscribeNewBots, () => newBotOperation(environmentId));
  const create: CreateNewBot = (name, clientRequestId) =>
    manage.create({ name, avatar: null, purpose: "" }, null, clientRequestId);
  const { onOpenBot } = props;
  const visible = props.visible !== false;
  // oxlint-disable-next-line goat/react-effect-budget -- A create answers after the tap; only a roster still on screen for that environment opens its chat.
  useEffect(() => {
    if (!visible || environmentId === null) return;
    return registerNewBotOpener(environmentId, (bot) =>
      onOpenBot({ kind: "member", profile: bot }),
    );
  }, [visible, environmentId, onOpenBot]);
  const listed = roster.listedBots;
  const createdId = operation?.phase === "created" ? operation.bot.botId : null;
  const refreshBots = roster.refreshBots;
  const refreshedFor = useRef<string | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- The created bot's own row arrives with the next list read; until then its status row stands in.
  useEffect(() => {
    if (environmentId === null || createdId === null || listed === null) return;
    const ids = new Set(listed.map((bot) => bot.botId));
    if (ids.has(createdId)) settleListedNewBot(environmentId, ids);
    else if (refreshBots !== null && refreshedFor.current !== createdId) {
      // One read per created bot; a list that still lacks it keeps the status row and its error.
      refreshedFor.current = createdId;
      refreshBots();
    }
  }, [environmentId, createdId, listed, refreshBots]);
  const askAbout = (entry: BotRosterEntry) => {
    const bot = entry.profile;
    if (bot === null) return;
    const edit = { text: "Edit", onPress: () => setEditing(bot) };
    const cancel = { text: "Cancel", style: "cancel" as const };
    if (entry.kind === "main") {
      if (manage.canEdit) Alert.alert(bot.name, undefined, [edit, cancel]);
      return;
    }
    if (!manage.canManage) return;
    Alert.alert(bot.name, undefined, [
      ...(manage.canEdit ? [edit] : []),
      {
        text: bot.hidden === true ? "Show" : "Hide",
        onPress: () => void manage.hide(bot, bot.hidden !== true),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          Alert.alert(`Delete ${bot.name}?`, "Its conversation is archived; you can restore it.", [
            cancel,
            { text: "Delete", style: "destructive", onPress: () => void manage.remove(bot) },
          ]),
      },
      cancel,
    ]);
  };
  return (
    <View className="flex-1">
      <MobileBotRosterView
        header={
          <>
            {props.header}
            {roster.error ? (
              <Text className="px-4 text-danger-foreground">{roster.error}</Text>
            ) : null}
          </>
        }
        selectedKey={props.selectedKey}
        bots={roster.bots}
        members={
          roster.supportsMembers
            ? {
                hidden: roster.groups.hidden,
                deleted: roster.groups.deleted,
                // The generated name needs the whole list, hidden and deleted included.
                canCreate: manage.canCreate && listed !== null && operation === null,
                onNewBot: () => {
                  if (environmentId !== null && listed !== null)
                    startNewBot(environmentId, listed, create);
                },
                onLongPressBot: askAbout,
                canRestore: manage.canManage,
                onRestoreDeleted: (bot) =>
                  Alert.alert(`Restore ${bot.name}?`, "Its conversation comes back.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Restore", onPress: () => void manage.restore(bot) },
                  ]),
              }
            : undefined
        }
        slackEnabled={roster.slackEnabled}
        preview={preview?.text}
        unread={preview?.unread}
        onOpenBot={props.onOpenBot}
        onOpenTask={props.onOpenTask}
        onUnknownBot={roster.refreshBots ?? undefined}
        visible={props.visible}
        newBotRow={
          operation !== null && environmentId !== null ? (
            <MobileNewBotStatus
              operation={operation}
              onRetry={() => retryNewBot(environmentId, create)}
              onDismiss={() => dismissNewBot(environmentId)}
              onOpen={() =>
                operation.phase === "created" &&
                onOpenBot({ kind: "member", profile: operation.bot })
              }
            />
          ) : null
        }
      />
      {editing !== null && environmentId !== null ? (
        <MobileBotEditSheet
          key={editing.botId}
          bot={editing}
          environmentId={environmentId}
          manage={manage}
          mainName={mainName}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </View>
  );
}
