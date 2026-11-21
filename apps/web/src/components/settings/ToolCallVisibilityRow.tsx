import { DEFAULT_UNIFIED_SETTINGS, ToolCallVisibility } from "@goat/contracts/settings";
import * as Schema from "effect/Schema";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const TOOL_CALL_VISIBILITY_LABELS: Record<ToolCallVisibility, string> = {
  showAll: "Show all",
  hideSuccessful: "Hide successful",
  hideAll: "Hide all",
  zen: "Zen",
};

const isToolCallVisibility = Schema.is(ToolCallVisibility);

export function ToolCallVisibilityRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("tool-call-visibility")}
      description="Hide the commands, edits, and searches agents run, so a thread reads like a conversation. Hide successful keeps calls that fail. Zen also hides the agent's in-between messages and shows only final answers. Approvals, questions, and errors always show."
      resetAction={
        settings.toolCallVisibility !== DEFAULT_UNIFIED_SETTINGS.toolCallVisibility ? (
          <SettingResetButton
            label="tool calls in chat"
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
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Tool calls in chat">
              <SelectValue>{TOOL_CALL_VISIBILITY_LABELS[settings.toolCallVisibility]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="showAll">Show all</SelectItem>
              <SelectItem value="hideSuccessful">Hide successful</SelectItem>
              <SelectItem value="hideAll">Hide all</SelectItem>
              <SelectItem value="zen">Zen</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
