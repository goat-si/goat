import { useGT } from "gt-react";
import { useState } from "react";

import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";

// Toggling relaunches the desktop app, so the switch reflects the value this process started
// with. Turning it off only hides the server here; it keeps running for SSH clients that use it.
export function HeadlessServerSetting() {
  const gt = useGT();
  const bridge = window.desktopBridge;
  const setEnabled = bridge?.setHeadlessServerAttachEnabled;
  const [enabled] = useState(() => bridge?.getHeadlessServerAttachEnabled?.() !== false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setting = useTranslatedSearchableSetting()("headless-server");
  if (!setEnabled) return null;

  const toggle = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      await setEnabled(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Couldn't change this setting."));
      setIsUpdating(false);
    }
  };

  return (
    <SettingsRow
      {...setting}
      description={
        error ??
        (enabled
          ? gt(
              "Show the background GOAT server that SSH work started on this computer as its own environment. Changing this restarts GOAT.",
            )
          : gt(
              "Hidden. GOAT uses only this app's own server here; SSH clients can still use the background server.",
            ))
      }
      control={
        isUpdating ? (
          <Spinner size="sm" />
        ) : (
          <Switch
            checked={enabled}
            onCheckedChange={() => void toggle()}
            aria-label={setting.title}
          />
        )
      }
    />
  );
}
