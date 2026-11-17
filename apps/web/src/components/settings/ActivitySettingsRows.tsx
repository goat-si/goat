import { DEFAULT_UNIFIED_SETTINGS, ScreenReaderAnnouncements } from "@goat/contracts/settings";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SCREEN_READER_ANNOUNCEMENTS_LABELS: Record<ScreenReaderAnnouncements, string> = {
  status: msg("Status only"),
  messages: msg("Status and messages"),
  everything: msg("Everything"),
};

const isScreenReaderAnnouncements = Schema.is(ScreenReaderAnnouncements);

export function ScreenReaderAnnouncementsRow() {
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("screen-reader-announcements")}
      description={
        <T>
          What a screen reader hears from the open thread: a turn starting, needing you, and ending.
          Status and messages adds what the agent writes before its last message. Everything adds
          each step.
        </T>
      }
      resetAction={
        settings.screenReaderAnnouncements !==
        DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements ? (
          <SettingResetButton
            label="screen reader announcements"
            onClick={() =>
              updateSettings({
                screenReaderAnnouncements: DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.screenReaderAnnouncements}
          onValueChange={(value) => {
            if (isScreenReaderAnnouncements(value)) {
              updateSettings({ screenReaderAnnouncements: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-48"
            aria-label={gt("Screen reader announcements")}
          >
            <SelectValue>
              {m(SCREEN_READER_ANNOUNCEMENTS_LABELS[settings.screenReaderAnnouncements])}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {ScreenReaderAnnouncements.literals.map((value) => (
              <SelectItem key={value} value={value}>
                {m(SCREEN_READER_ANNOUNCEMENTS_LABELS[value])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function ScreenReaderWindowTitleRow() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("screen-reader-window-title")}
      description={
        <T>
          Start the window title with the thread's status, like Needs approval, and its name, so
          screen readers read them first when you switch apps. Taskbars, shared screens, and time
          trackers see it too.
        </T>
      }
      resetAction={
        settings.screenReaderWindowTitle !== DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle ? (
          <SettingResetButton
            label="screen reader window title"
            onClick={() =>
              updateSettings({
                screenReaderWindowTitle: DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.screenReaderWindowTitle}
          onCheckedChange={(checked) => updateSettings({ screenReaderWindowTitle: checked })}
          aria-label={gt("Screen reader window title")}
        />
      }
    />
  );
}
