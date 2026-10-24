import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { CheckIcon } from "~/components/solar";

import { isMacPlatform } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ComposerSettingsSection() {
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter-multiline", label: `${modifierLabel} + Enter for multiline prompts` },
    { value: "mod-enter", label: `${modifierLabel} + Enter always` },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="composer-settings" title="Composer">
      <SettingsRow
        {...searchableSetting("skills-in-slash-menu")}
        description="Also include skills in the / command menu. Skills always appear when you type $."
        resetAction={
          settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
            <SettingResetButton
              label="skills in slash menu"
              onClick={() =>
                updateSettings({
                  showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.showSkillsInSlashMenu}
            onCheckedChange={(checked) =>
              updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
            }
            aria-label="Show skills in slash menu"
          />
        }
      />

      <SettingsRow
        {...searchableSetting("composer-rich-text")}
        description="Show formatted Markdown as you type."
        resetAction={
          settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
            <SettingResetButton
              label="rich text composer"
              onClick={() =>
                updateSettings({
                  composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.composerRichTextEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ composerRichTextEnabled: Boolean(checked) })
            }
            aria-label="Rich text composer"
          />
        }
      />

      <SettingsRow
        {...searchableSetting("composer-collapse")}
        description="Rest the composer of an existing thread into a single line when you scroll the conversation. Focus the composer or start typing to expand it again."
        resetAction={
          settings.composerCollapseOnScroll !==
          DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
            <SettingResetButton
              label="collapse composer on scroll"
              onClick={() =>
                updateSettings({
                  composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.composerCollapseOnScroll}
            onCheckedChange={(checked) =>
              updateSettings({ composerCollapseOnScroll: Boolean(checked) })
            }
            aria-label="Collapse composer on scroll"
          />
        }
      />

      <SettingsRow
        {...searchableSetting("send-shortcut")}
        description="Choose when Enter sends a prompt or inserts a new line"
        resetAction={
          settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
            <SettingResetButton
              label="send shortcut"
              onClick={() =>
                updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.sendShortcut}
            onValueChange={(value) => {
              const option = sendShortcutOptions.find((option) => option.value === value);
              if (option) updateSettings({ sendShortcut: option.value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-0 max-w-full"
              aria-label="Send shortcut"
            >
              <SelectValue>
                {
                  sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                    ?.label
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {sendShortcutOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex items-center justify-between gap-4">
                    {option.label}
                    {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...searchableSetting("follow-up-behavior")}
        description={
          "Queue follow-ups while the agent runs or steer the current run. " +
          (settings.sendShortcut === "mod-enter-multiline"
            ? `Press ${modifierLabel} + Enter for single-line prompts or ${modifierLabel} + Shift + Enter for multiline prompts to do the opposite for one message.`
            : `Press ${modifierLabel}${settings.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter to do the opposite for one message.`)
        }
        resetAction={
          settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
            <SettingResetButton
              label="follow-up behavior"
              onClick={() =>
                updateSettings({
                  followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.followUpBehavior}
            onValueChange={(value) => {
              if (value === "queue" || value === "steer") {
                updateSettings({ followUpBehavior: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="Follow-up behavior">
              <SelectValue>{settings.followUpBehavior === "queue" ? "Queue" : "Steer"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="queue">Queue</SelectItem>
              <SelectItem value="steer">Steer</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
