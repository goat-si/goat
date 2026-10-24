import { DEFAULT_UNIFIED_SETTINGS, type DiffLayout } from "@goat/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: "Stacked",
  split: "Split",
};

export function DiffSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="diff-settings" title="Diffs and panels">
      <SettingsRow
        {...searchableSetting("hide-whitespace-changes")}
        description="Set whether the diff panel ignores whitespace-only edits by default."
        resetAction={
          settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
            <SettingResetButton
              label="diff whitespace changes"
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
            aria-label="Hide whitespace changes by default"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("default-diff-file-state")}
        description="Start with files expanded or collapsed when opening diffs or a pull request's Code tab."
        resetAction={
          settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
            <SettingResetButton
              label="default diff file state"
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
              aria-label="Default diff file state"
            >
              <SelectValue>{settings.diffFilesCollapsed ? "Collapsed" : "Expanded"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="expanded">
                Expanded
              </SelectItem>
              <SelectItem hideIndicator value="collapsed">
                Collapsed
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("diff-layout")}
        description="Show diffs stacked or side by side. The toggle in the diff toolbar changes this too."
        resetAction={
          settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
            <SettingResetButton
              label="diff layout"
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
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Diff layout">
              <SelectValue>{DIFF_LAYOUT_LABELS[settings.diffLayout]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="stacked">
                {DIFF_LAYOUT_LABELS.stacked}
              </SelectItem>
              <SelectItem hideIndicator value="split">
                {DIFF_LAYOUT_LABELS.split}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...searchableSetting("proactive-panels")}
        description="Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines."
        resetAction={
          settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
            <SettingResetButton
              label="proactive panels"
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
            aria-label="Proactive panels"
          />
        }
      />
    </SettingsSection>
  );
}
