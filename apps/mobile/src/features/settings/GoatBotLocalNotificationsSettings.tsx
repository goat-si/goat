import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { runtime } from "../../lib/runtime";
import { useNotificationPermissionStatus } from "../../lib/useNotificationPermissionStatus";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function GoatBotLocalNotificationsSettings() {
  const [status, setStatus] = useNotificationPermissionStatus();
  const [requesting, setRequesting] = useState(false);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const enabled = loaded && preferences.value.goatBotLocalAlerts !== false && status === "enabled";
  const toggle = async (value: boolean) => {
    if (!value) {
      update({ goatBotLocalAlerts: false });
      return;
    }
    setRequesting(true);
    try {
      const permission = await runtime.runPromise(requestAgentNotificationPermission);
      if (permission.type === "granted") {
        setStatus("enabled");
        update({ goatBotLocalAlerts: true });
      } else if (permission.type === "denied") {
        setStatus("disabled");
        Dialog.alert("Notifications disabled", "Allow notifications for GOAT in system settings.", [
          { text: "Cancel", style: "cancel" },
          { text: "Open settings", onPress: () => void Linking.openSettings() },
        ]);
      }
    } catch {
      Dialog.alert("Notifications unavailable", "Could not request notification permission.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SettingsSection title="GOAT Bot">
      <SettingsSwitchRow
        icon="bell.badge"
        label="Bot alerts on this device"
        subtitle="Show alerts from paired computers while GOAT is running."
        value={enabled}
        disabled={!loaded || requesting || status === "checking" || status === "unsupported"}
        onValueChange={(value) => void toggle(value)}
      />
      {status === "disabled" ? (
        <SettingsRow
          icon={undefined}
          label="Open system notification settings"
          onPress={() => void Linking.openSettings()}
        />
      ) : null}
    </SettingsSection>
  );
}
