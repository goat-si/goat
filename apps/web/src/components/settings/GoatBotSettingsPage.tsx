import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { GoatBotSettings } from "./GoatBotSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SlackChannelSettings } from "./SlackChannelSettings";

/** Every GOAT Bot control in one place: where it runs, then the channels that reach it. */
export function GoatBotSettingsPanel() {
  const besideChat = useClientSettings((settings) => settings.goatBotTaskThreadsBesideChat);
  return (
    <SettingsPageContainer>
      <GoatBotSettings />
      <SettingsSection title="Task threads">
        <SettingsRow
          title="Open task threads beside the main chat"
          description="Show task conversations beside the main chat when there is enough space."
          control={
            <Switch
              aria-label="Open task threads beside the main chat"
              checked={besideChat}
              onCheckedChange={(checked) =>
                void persistClientSettingsPatch({ goatBotTaskThreadsBesideChat: Boolean(checked) })
              }
            />
          }
        />
      </SettingsSection>
      <SlackChannelSettings />
      <SettingsSection id="imessage" title="iMessage">
        <SettingsRow
          {...searchableSetting("imessage-channel")}
          title="Set up in Terminal"
          description={
            <>
              On the Mac that runs GOAT Bot, give GOAT Full Disk Access, run{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs whitespace-nowrap">
                goat imessage enable --allow &lt;phone or email&gt;
              </code>
              , and restart GOAT. Then text the code from{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs whitespace-nowrap">
                goat imessage link-code
              </code>{" "}
              from that phone.
            </>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
