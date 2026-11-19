import { msg, useGT, useMessages } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS, type DiffLayout } from "@goat/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: msg("Stacked"),
  split: msg("Split"),
};

export function DiffSettingsSection() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="diff-settings" title={gt("Diffs and panels")}>
      <SettingsRow
        {...setting("hide-whitespace-changes")}
        description={gt("Set whether the diff panel ignores whitespace-only edits by default.")}
        resetAction={
          settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
            <SettingResetButton
              label={gt("diff whitespace changes")}
              onClick={() =>
                updateSettings({
                  diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.diffIgnoreWhitespace}
            onCheckedChange={(checked) =>
              updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
            }
            aria-label={gt("Hide whitespace changes by default")}
          />
        }
      />
      <SettingsRow
        {...setting("default-diff-file-state")}
        description={gt(
          "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
        )}
        resetAction={
          settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
            <SettingResetButton
              label={gt("default diff file state")}
              onClick={() =>
                updateSettings({
                  diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.diffFilesCollapsed ? "collapsed" : "expanded"}
            onValueChange={(value) => {
              if (value === "expanded" || value === "collapsed") {
                updateSettings({ diffFilesCollapsed: value === "collapsed" });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={gt("Default diff file state")}
            >
              <SelectValue>
                {settings.diffFilesCollapsed ? gt("Collapsed") : gt("Expanded")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="expanded">
                {gt("Expanded")}
              </SelectItem>
              <SelectItem hideIndicator value="collapsed">
                {gt("Collapsed")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...setting("diff-layout")}
        description={gt(
          "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
        )}
        resetAction={
          settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
            <SettingResetButton
              label={gt("diff layout")}
              onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
            />
          ) : null
        }
        control={
          <Select
            value={settings.diffLayout}
            onValueChange={(value) => {
              if (value === "stacked" || value === "split") {
                updateSettings({ diffLayout: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Diff layout")}>
              <SelectValue>{m(DIFF_LAYOUT_LABELS[settings.diffLayout])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="stacked">
                {m(DIFF_LAYOUT_LABELS.stacked)}
              </SelectItem>
              <SelectItem hideIndicator value="split">
                {m(DIFF_LAYOUT_LABELS.split)}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...setting("proactive-panels")}
        description={gt(
          "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
        )}
        resetAction={
          settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
            <SettingResetButton
              label={gt("proactive panels")}
              onClick={() =>
                updateSettings({
                  proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.proactivePanelsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ proactivePanelsEnabled: Boolean(checked) })
            }
            aria-label={gt("Open pull requests and changes panels proactively")}
          />
        }
      />
    </SettingsSection>
  );
}
