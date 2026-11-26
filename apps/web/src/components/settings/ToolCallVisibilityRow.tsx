import { DEFAULT_UNIFIED_SETTINGS, ToolCallVisibility } from "@goat/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";
import * as Schema from "effect/Schema";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const TOOL_CALL_VISIBILITY_LABELS: Record<ToolCallVisibility, string> = {
  showAll: msg("Show all"),
  hideSuccessful: msg("Hide successful"),
  hideAll: msg("Hide all"),
  zen: msg("Zen"),
};

const isToolCallVisibility = Schema.is(ToolCallVisibility);

export function ToolCallVisibilityRow() {
  const gt = useGT();
  const m = useMessages();
  const setting = useTranslatedSearchableSetting()("tool-call-visibility");
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...setting}
      description={gt(
        "Hide the commands, edits, and searches agents run, so a thread reads like a conversation. Hide successful keeps calls that fail. Zen also hides the agent's in-between messages and shows only final answers. Approvals, questions, and errors always show.",
      )}
      resetAction={
        settings.toolCallVisibility !== DEFAULT_UNIFIED_SETTINGS.toolCallVisibility ? (
          <SettingResetButton
            label={setting.title}
            onClick={() =>
              updateSettings({ toolCallVisibility: DEFAULT_UNIFIED_SETTINGS.toolCallVisibility })
            }
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={settings.toolCallVisibility}
            onValueChange={(value) => {
              if (isToolCallVisibility(value)) updateSettings({ toolCallVisibility: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={setting.title}>
              <SelectValue>
                {m(TOOL_CALL_VISIBILITY_LABELS[settings.toolCallVisibility])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ToolCallVisibility.literals.map((value) => (
                <SelectItem key={value} value={value}>
                  {m(TOOL_CALL_VISIBILITY_LABELS[value])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
