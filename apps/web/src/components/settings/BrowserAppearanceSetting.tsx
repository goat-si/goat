import { DEFAULT_PREVIEW_APPEARANCE, type PreviewAppearancePreference } from "@goat/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useClientSettings } from "~/hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useUpdateScopedSettings } from "./useScopedSettings";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, string>> = {
  system: msg("System"),
  light: msg("Light"),
  dark: msg("Dark"),
};

export function BrowserAppearanceSetting({ disabled }: { readonly disabled: boolean }) {
  const gt = useGT();
  const m = useMessages();
  const localizedSetting = useTranslatedSearchableSetting();
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...localizedSetting("browser-default-appearance")}
      devicePreference
      description={gt("The color scheme pages are told to prefer. System follows your OS setting.")}
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label={gt("default browser appearance")}
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={appearance}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") {
              updateSettings({ browserDefaultAppearance: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={gt("Default browser appearance")}
          >
            <SelectValue>{m(APPEARANCE_LABELS[appearance])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {m(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
