import type { DesktopWindowMaterialState } from "@goat/contracts";
import { useDesktopWindowMaterial } from "../../desktop/useDesktopWindowMaterial";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function materialStatus(state: DesktopWindowMaterialState | null): string {
  if (!state) return "Checking system glass availability…";
  if (!state.capability.supported) {
    const platform = window.desktopBridge?.getClientPlatform?.() ?? navigator.platform;
    if (/darwin|mac/i.test(platform)) {
      return state.capability.reason === "os-version"
        ? "Requires macOS 26 or later."
        : "System glass is not available on this Mac.";
    }
    if (state.capability.reason === "os-version") return "Requires Windows 11 22H2 or later.";
    return "System glass is not available on this device.";
  }
  switch (state.reason) {
    case "accessibility":
      return "Off while reduced transparency or high contrast is on.";
    case "opaque":
      return "Off at 100% glass opacity.";
    case "fullscreen":
      return "Paused in full screen.";
    case "native-failed":
      return "The system material could not be applied.";
    case "restart":
      return "Restart GOAT to use Liquid Glass.";
    case "active":
      return state.applied === "windows-mica" ? "Using Mica." : "Using Liquid Glass.";
    default:
      return "Use the system material in the sidebar and title bar.";
  }
}

export function DesktopWindowMaterialSetting() {
  const { available, state } = useDesktopWindowMaterial();
  const enabled = useScopedSettings((settings) => settings.desktopSystemMaterialEnabled);
  const updateSettings = useUpdateScopedSettings();
  if (!available) return null;

  return (
    <SettingsRow
      {...searchableSetting("desktop-system-material")}
      description={materialStatus(state)}
      control={
        <Switch
          aria-label="System glass"
          checked={enabled}
          disabled={!state?.capability.supported}
          onCheckedChange={(checked) =>
            updateSettings({ desktopSystemMaterialEnabled: Boolean(checked) })
          }
        />
      }
    />
  );
}
