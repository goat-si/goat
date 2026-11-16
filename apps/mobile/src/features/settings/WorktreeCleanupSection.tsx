import { WORKTREE_CLEANUP_OFF } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, StorageCleanupSettings } from "@goat/contracts";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { commandFailureText } from "./commandFailureText";

function NumberRow({
  label,
  value,
  maximum,
  disabled,
  emptyLabel = "Off",
  onSave,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly maximum: number;
  readonly disabled: boolean;
  readonly emptyLabel?: string;
  readonly onSave: (value: number | null) => Promise<boolean>;
}) {
  // Null shows the saved value; a newer saved value replaces whatever was typed.
  const [draft, setDraft] = useState<string | null>(null);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(null);
  }
  const shown = draft ?? (value === null ? "" : String(value));
  const save = (next: number | null) => {
    const submitted = shown;
    void onSave(next).then((saved) => {
      if (!saved) setDraft((current) => (current === submitted ? null : current));
    });
  };
  return (
    <View className="gap-2 p-4">
      <Text>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        keyboardType="number-pad"
        editable={!disabled}
        value={shown}
        placeholder={emptyLabel}
        onChangeText={setDraft}
        onEndEditing={() => {
          const number = Number(shown);
          if (shown.trim() === "") save(null);
          else if (Number.isInteger(number) && number >= 1 && number <= maximum) save(number);
          else setDraft(null);
        }}
      />
    </View>
  );
}

export function WorktreeCleanupSection({
  environmentId,
  settings,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: StorageCleanupSettings;
}) {
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const report = useAtomValue(serverEnvironment.storageCleanupReport({ environmentId, input: {} }));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const respond = useAtomCommand(serverEnvironment.respondWorktreeCleanupPreview);
  const preview = report._tag === "Success" ? report.value?.worktreePreview : undefined;
  const previewId = preview?.id;
  const seenAt = preview?.seenAt;
  // oxlint-disable-next-line goat/react-effect-budget -- Record that this server preview was displayed.
  useEffect(() => {
    if (previewId !== undefined && seenAt === null)
      void respond({ environmentId, input: { previewId, response: "seen" } });
  }, [environmentId, previewId, seenAt, respond]);
  const run = async (
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<boolean> => {
    const result = await action();
    if (result._tag !== "Failure") return true;
    if (!isAtomCommandInterrupted(result)) Dialog.alert(title, commandFailureText(result));
    return false;
  };
  const write = (patch: Partial<StorageCleanupSettings>) =>
    run("Could not save settings", () =>
      update({ environmentId, input: { patch: { storageCleanup: patch } } }),
    );
  return (
    <SettingsSection title="Worktree cleanup">
      <NumberRow
        label="Keep most recent worktrees"
        value={settings.worktreeKeepRecent}
        maximum={1000}
        disabled={!allowed}
        onSave={(value) => write({ worktreeKeepRecent: value })}
      />
      <NumberRow
        label="Clean up after unused days"
        value={settings.worktreeAfterDays}
        maximum={3650}
        disabled={!allowed}
        onSave={(value) => write({ worktreeAfterDays: value })}
      />
      <SettingsSwitchRow
        label="Clean up when archived"
        value={settings.worktreeOnArchive}
        disabled={!allowed}
        onValueChange={(value) => void write({ worktreeOnArchive: value })}
      />
      <SettingsSwitchRow
        label="Clean up worktrees with uncommitted changes"
        subtitle="A snapshot is saved first."
        value={settings.worktreeSnapshotChanges}
        disabled={!allowed}
        onValueChange={(value) => void write({ worktreeSnapshotChanges: value })}
      />
      <NumberRow
        label="Keep snapshots for days"
        value={settings.worktreeSnapshotDays}
        maximum={3650}
        disabled={!allowed}
        emptyLabel="Until the thread is deleted"
        onSave={(value) => write({ worktreeSnapshotDays: value })}
      />
      <SettingsSwitchRow
        label="Preview before automatic cleanup"
        subtitle="Cleanup waits until you have seen what it would remove."
        value={settings.worktreeCleanupPreview}
        disabled={!allowed}
        onValueChange={(value) => void write({ worktreeCleanupPreview: value })}
      />
      {preview ? (
        <>
          <View className="p-4">
            <Text>
              {preview.plannedCount === 1
                ? "1 worktree is ready to clean up."
                : `${preview.plannedCount} worktrees are ready to clean up.`}
            </Text>
          </View>
          <SettingsActionRow
            label="Clean up now"
            disabled={!allowed}
            onPress={() =>
              void run("Could not clean up worktrees", () =>
                respond({ environmentId, input: { previewId: preview.id, response: "confirm" } }),
              )
            }
          />
          <SettingsActionRow
            label="Turn off"
            disabled={!allowed}
            onPress={() => void write(WORKTREE_CLEANUP_OFF)}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
