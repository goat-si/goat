import { AuthSettingsWriteScope } from "@t3tools/contracts";

import { useEnvironmentScope } from "~/state/session";

import { SettingsRow, SettingsSection, SettingsUnavailableGroup } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  slackSettingsAvailability,
  slackSettingsUnavailableMessage,
} from "./SlackChannelSettings.logic";

/** Slack connection for the selected environment. Tokens stay on that server. */
export function SlackChannelSettings() {
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const availability = slackSettingsAvailability({
    environmentSelected: selected !== null,
    connected,
    // No server advertises the Slack adapter yet; controls arrive with its capability.
    slackChannel: undefined,
    canConfigure,
  });

  return (
    <SettingsSection id="slack-channel" title="Slack">
      <SettingsUnavailableGroup message={slackSettingsUnavailableMessage(availability)}>
        <SettingsRow
          {...searchableSetting("slack-connection")}
          description="Take @mentions and direct messages from Slack, and reply in the same thread."
        />
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}
