import { useState } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DESCRIPTIONS = {
  darwin: "Shows the threads that need you, are running, or are pinned in the menu bar.",
  win32:
    "Shows the threads that need you, are running, or are pinned in the notification area. Closing the window keeps GOAT running there.",
  linux:
    "Shows the threads that need you, are running, or are pinned in the panel. Closing the window keeps GOAT running there when the panel shows the icon.",
} as const;

export function TrayIconSettingRow() {
  const bridge = window.desktopBridge;
  const setEnabled = bridge?.setTrayIconEnabled;
  const [enabled, setShown] = useState(() => bridge?.getTrayIconEnabled?.() !== false);
  const [error, setError] = useState<string | null>(null);
  if (!setEnabled) return null;
  const platform = bridge.getClientPlatform?.();
  const description =
    platform === "darwin" || platform === "win32" || platform === "linux"
      ? DESCRIPTIONS[platform]
      : DESCRIPTIONS.linux;

  const toggle = (next: boolean) => {
    setShown(next);
    setError(null);
    void setEnabled(next).catch((cause: unknown) => {
      setShown(!next);
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
    });
  };

  return (
    <SettingsRow
      {...searchableSetting("tray-icon")}
      description={error ?? description}
      control={
        <Switch checked={enabled} onCheckedChange={toggle} aria-label="Show the GOAT icon" />
      }
    />
  );
}
