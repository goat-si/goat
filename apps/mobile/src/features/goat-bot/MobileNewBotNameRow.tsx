import { isGeneratedBotName } from "@goat/client-runtime/goatBot";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useState, type ReactNode } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { MobileBotEditSheet } from "./MobileBotEditSheet";
import { dismissBotNameRow, useBotNameRowDismissed } from "./mobileBotNameRowDismissed";
import { useMobileBotManage } from "./useMobileBotManage";

/**
 * Editing a member from its chat. The name row shows above the message box while the bot still has
 * a generated name ("New bot", "New bot 2"…), this person may edit it, it is not deleted, and this
 * device has not dismissed it; it reads only that state, so it shows the same on any visit or
 * device. Edit bot (the home sheet's entry, and the row's More) opens the full sheet.
 */
export function useMobileBotEditing(member: BotProfile | null, mainName: string) {
  const environmentId: EnvironmentId | null = member?.environmentId ?? null;
  const manage = useMobileBotManage(environmentId, mainName);
  const editable = member !== null && member.state !== "deleted" && manage.canEdit;
  const dismissed = useBotNameRowDismissed(environmentId, member?.botId ?? null);
  const [editing, setEditing] = useState<{
    readonly botId: string;
    readonly draftName?: string;
  } | null>(null);
  const nameRow: ReactNode =
    editable && dismissed === false && isGeneratedBotName(member.name) ? (
      <MobileNewBotNameRow
        key={member.botId}
        member={member}
        onSave={(name) => manage.update(member, { name })}
        onMore={(draftName) => setEditing({ botId: member.botId, draftName })}
        onDismiss={() => dismissBotNameRow(member.environmentId, member.botId)}
      />
    ) : null;
  const editSheet: ReactNode =
    member !== null && environmentId !== null && editing?.botId === member.botId ? (
      <MobileBotEditSheet
        bot={member}
        environmentId={environmentId}
        manage={manage}
        mainName={mainName}
        draftName={editing.draftName}
        onClose={() => setEditing(null)}
      />
    ) : null;
  return {
    nameRow,
    editSheet,
    /** Opens Edit bot; absent for the main bot, a deleted member, or without permission. */
    openEdit: editable ? () => setEditing({ botId: member.botId }) : undefined,
  };
}

function MobileNewBotNameRow(props: {
  readonly member: BotProfile;
  readonly onSave: (name: string) => Promise<string | null>;
  readonly onMore: (draftName: string) => void;
  readonly onDismiss: () => void;
}) {
  const [draft, setDraft] = useState(props.member.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = draft.trim();
  const blocked = name === "" || saving;
  const done = async () => {
    // An unchanged name sends nothing; the bot keeps its generated name and the row stays.
    if (blocked || name === props.member.name) return;
    setSaving(true);
    setError(null);
    const failure = await props.onSave(name);
    setSaving(false);
    if (failure === null) return;
    setError(failure);
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(failure);
  };
  return (
    <View className="gap-1">
      <Text accessibilityRole="header" className="text-xs font-medium text-foreground-muted">
        Name this bot
      </Text>
      <View className="flex-row items-center gap-1">
        <TextInput
          accessibilityLabel="Bot name"
          value={draft}
          onChangeText={setDraft}
          editable={!saving}
          selectTextOnFocus
          returnKeyType="done"
          onSubmitEditing={() => void done()}
          maxLength={64}
          className="min-h-[44px] flex-1 rounded-lg border border-border-subtle px-3 text-base text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: blocked, busy: saving }}
          disabled={blocked}
          onPress={() => void done()}
          className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
        >
          <Text
            className={blocked ? "text-foreground-muted" : "font-goat-medium text-primary-text"}
          >
            {saving ? "Saving…" : "Done"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={() => props.onMore(draft)}
          className="min-h-[44px] min-w-[44px] items-center justify-center px-2"
        >
          <Text className="text-foreground">More</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss naming"
          disabled={saving}
          onPress={props.onDismiss}
          className="min-h-[44px] min-w-[44px] items-center justify-center"
        >
          <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
