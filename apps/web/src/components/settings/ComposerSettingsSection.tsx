import { useGT } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { CheckIcon } from "~/components/solar";

import { isMacPlatform } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function ComposerSettingsSection() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    {
      value: "mod-enter-multiline",
      label: gt("{modifier} + Enter for multiline prompts", { modifier: modifierLabel }),
    },
    { value: "mod-enter", label: gt("{modifier} + Enter always", { modifier: modifierLabel }) },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="composer-settings" title={gt("Composer")}>
      <SettingsRow
        {...setting("skills-in-slash-menu")}
        description={gt(
          "Also include skills in the / command menu. Skills always appear when you type $.",
        )}
        resetAction={
          settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
            <SettingResetButton
              label={gt("skills in slash menu")}
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
            aria-label={gt("Show skills in slash menu")}
          />
        }
      />

      <SettingsRow
        {...setting("composer-rich-text")}
        description={gt("Show formatted Markdown as you type.")}
        resetAction={
          settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
            <SettingResetButton
              label={gt("rich text composer")}
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
            aria-label={gt("Rich text composer")}
          />
        }
      />

      <SettingsRow
        {...setting("composer-collapse")}
        description={gt(
          "Rest the composer of an existing thread into a single line when you scroll the conversation. Focus the composer or start typing to expand it again.",
        )}
        resetAction={
          settings.composerCollapseOnScroll !==
          DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
            <SettingResetButton
              label={gt("collapse composer on scroll")}
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
            aria-label={gt("Collapse composer on scroll")}
          />
        }
      />

      <SettingsRow
        {...setting("send-shortcut")}
        description={gt("Choose when Enter sends a prompt or inserts a new line")}
        resetAction={
          settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
            <SettingResetButton
              label={gt("send shortcut")}
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
              aria-label={gt("Send shortcut")}
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
        {...setting("follow-up-behavior")}
        description={
          gt("Queue follow-ups while the agent runs or steer the current run.") +
          " " +
          (settings.sendShortcut === "mod-enter-multiline"
            ? gt(
                "Press {single} for single-line prompts or {multi} for multiline prompts to do the opposite for one message.",
                { single: `${modifierLabel} + Enter`, multi: `${modifierLabel} + Shift + Enter` },
              )
            : gt("Press {shortcut} to do the opposite for one message.", {
                shortcut: `${modifierLabel}${settings.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter`,
              }))
        }
        resetAction={
          settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
            <SettingResetButton
              label={gt("follow-up behavior")}
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
            <SelectTrigger
              size="sm"
              className="w-auto min-w-0"
              aria-label={gt("Follow-up behavior")}
            >
              <SelectValue>
                {settings.followUpBehavior === "queue" ? gt("Queue") : gt("Steer")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="queue">{gt("Queue")}</SelectItem>
              <SelectItem value="steer">{gt("Steer")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
