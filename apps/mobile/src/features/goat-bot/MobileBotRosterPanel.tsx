import { useState, type ReactNode } from "react";
import { goatBotName, type BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelTaskId } from "@goat/contracts";
import { Alert, Text, View } from "react-native";
import { MobileBotProfileSheet } from "./MobileBotProfileSheet";
import { MobileNewBotModel } from "./MobileNewBotModel";
import { MobileBotRosterView } from "./MobileBotRosterView";
import { useMobileBotRoster } from "./useMobileBotRoster";
import { useMobileBotPreview } from "./useMobileBotPreview";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileBotManage } from "./useMobileBotManage";
import { useMobileGoatBotMemberModelEditable } from "./useMobileGoatBotMemberModel";
import { uuidv4 } from "../../lib/uuid";

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
  const [sheet, setSheet] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly bot: BotProfile } | null
  >(null);
  const askAbout = (entry: BotRosterEntry) => {
    const bot = entry.profile;
    if (bot === null) return;
    const edit = { text: "Edit", onPress: () => setSheet({ mode: "edit", bot }) };
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
                canCreate: manage.canCreate,
                onNewBot: () => setSheet({ mode: "create" }),
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
        visible={props.visible}
      />
      {sheet !== null && roster.environmentId !== null ? (
        <BotSheet
          // A new sheet starts from its own bot's model.
          key={sheet.mode === "edit" ? sheet.bot.botId : "create"}
          sheet={sheet}
          environmentId={roster.environmentId}
          manage={manage}
          mainName={mainName}
          onCreated={(bot) => props.onOpenBot({ kind: "member", profile: bot })}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </View>
  );
}

function BotSheet(props: {
  readonly sheet: { readonly mode: "create" } | { readonly mode: "edit"; readonly bot: BotProfile };
  readonly environmentId: NonNullable<ReturnType<typeof useMobileBotRoster>["environmentId"]>;
  readonly manage: ReturnType<typeof useMobileBotManage>;
  readonly mainName: string;
  readonly onCreated: (bot: BotProfile) => void;
  readonly onClose: () => void;
}) {
  const { sheet, manage } = props;
  const initialModel = sheet.mode === "edit" ? sheet.bot.defaultModelSelection : null;
  const [model, setModel] = useState<BotProfile["defaultModelSelection"]>(initialModel);
  const [clientRequestId] = useState(uuidv4);
  // Only a member has a model of its own; the main bot's is the GOAT Bot model setting.
  const modelEditable =
    useMobileGoatBotMemberModelEditable(props.environmentId).editable &&
    sheet.mode === "edit" &&
    sheet.bot.role === "member";
  if (sheet.mode === "edit") {
    const modelChanged = modelEditable && !sameModel(model, initialModel);
    return (
      <MobileBotProfileSheet
        mode="edit"
        initial={sheet.bot}
        canSubmit={manage.canEdit}
        extraChanged={modelChanged}
        onClose={props.onClose}
        onSubmit={(changes) => manage.update(sheet.bot, changes, modelChanged ? model : undefined)}
      >
        {modelEditable ? (
          <MobileNewBotModel
            environmentId={props.environmentId}
            model={model}
            onChange={setModel}
            mainName={props.mainName}
          />
        ) : null}
      </MobileBotProfileSheet>
    );
  }
  return (
    <MobileBotProfileSheet
      mode="create"
      initial={{ name: "", avatar: null, purpose: "" }}
      canSubmit={manage.canCreate}
      onClose={props.onClose}
      onSubmit={async (changes) => {
        const result = await manage.create(changes, model, clientRequestId);
        if (typeof result === "string") return result;
        props.onCreated(result);
        return null;
      }}
    >
      <MobileNewBotModel
        environmentId={props.environmentId}
        model={model}
        onChange={setModel}
        mainName={props.mainName}
      />
    </MobileBotProfileSheet>
  );
}

function sameModel(
  left: BotProfile["defaultModelSelection"],
  right: BotProfile["defaultModelSelection"],
) {
  if (left === null || right === null) return left === right;
  return left.instanceId === right.instanceId && left.model === right.model;
}
