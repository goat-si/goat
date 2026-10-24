import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { AgentToolListing } from "@goat/contracts/agentSurface/listing";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const TOOL_LISTING_LABELS: Readonly<Record<AgentToolListing, string>> = {
  core: "Core",
  full: "All tools",
};

export function AgentToolsSettings() {
  return (
    <SettingsSection id="agent-tools" title="Agent tools">
      <AgentToolListingSetting />
    </SettingsSection>
  );
}

/**
 * Environment-wide: the server reads it when an agent lists tools, and a
 * change reaches running agents through tools/list_changed.
 */
export function AgentToolListingSetting() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["agentToolListing"]);
  const updateSettings = useUpdateScopedSettings();
  // Read from the contract so the control follows whichever default ships.
  const shippedDefault = DEFAULT_SERVER_SETTINGS.agentToolListing;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["agentToolListing"]}
      {...searchableSetting("agent-tool-listing")}
      description="Core shows agents two GOAT tools that look up and run the rest. All tools lists every tool up front, which can make each agent's first prompt much larger."
      resetAction={
        mixed || settings.agentToolListing !== shippedDefault ? (
          <SettingResetButton
            label="GOAT tools agents see"
            onClick={() => updateSettings({ agentToolListing: shippedDefault })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.agentToolListing}
          onValueChange={(value) => {
            const next = AgentToolListing.literals.find((literal) => literal === value);
            if (next !== undefined) updateSettings({ agentToolListing: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="GOAT tools agents see">
            <SelectValue>
              {mixed ? "Mixed" : TOOL_LISTING_LABELS[settings.agentToolListing]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {AgentToolListing.literals.map((listing) => (
              <SelectItem hideIndicator key={listing} value={listing}>
                <span className="flex w-full items-center justify-between gap-5">
                  <span>{TOOL_LISTING_LABELS[listing]}</span>
                  {listing === shippedDefault ? (
                    <span className="text-xs text-muted-foreground">Default</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function AgentBrowserAccessSetting() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentBrowserAccess"]}
      {...searchableSetting("agent-browser-access")}
      description={
        isProjectScope
          ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts."
          : "Allow agents to use the shared browser. Projects can override it."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="default browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentBrowserAccess"]}
          aria-label="Agent browser access"
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
        />
      }
    />
  );
}
