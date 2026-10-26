import { useState } from "react";

import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Toggling relaunches the desktop app, so the switch reflects the value this process started
// with. Turning it off only hides the server here; it keeps running for SSH clients that use it.
export function HeadlessServerSetting() {
  const bridge = window.desktopBridge;
  const setEnabled = bridge?.setHeadlessServerAttachEnabled;
  const [enabled] = useState(() => bridge?.getHeadlessServerAttachEnabled?.() !== false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!setEnabled) return null;

  const toggle = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      await setEnabled(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
      setIsUpdating(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("headless-server")}
      description={
        error ??
        (enabled
          ? "Show the background GOAT server that SSH work started on this Mac as its own environment. Changing this restarts GOAT."
          : "Hidden. GOAT uses only this app's own server here; SSH clients can still use the background server.")
      }
      control={
        isUpdating ? (
          <Spinner size="sm" />
        ) : (
          <Switch
            checked={enabled}
            onCheckedChange={() => void toggle()}
            aria-label="Headless server on this Mac"
          />
        )
      }
    />
  );
}
