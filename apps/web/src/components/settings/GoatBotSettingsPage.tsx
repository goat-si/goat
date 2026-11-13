import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { channelEnvironment } from "../../state/channels";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { GoatBotProfileDialog } from "../goatBot/GoatBotProfileDialog";
import { useGoatBotEnabled } from "../goatBot/useGoatBotSession";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { GoatBotSettings } from "./GoatBotSettings";
import { GoatBotStatusSettings } from "./GoatBotStatusSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SlackChannelSettings } from "./SlackChannelSettings";

const NO_PERMISSION = Atom.make(false);

/** The main bot's name, avatar and purpose, on the computer GOAT Bot runs on. */
function GoatBotProfileSection() {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const supported =
    environmentId !== null &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotProfileEdit === true;
  const profiles = useEnvironmentQuery(
    supported ? channelEnvironment.listBots({ environmentId, input: {} }) : null,
  );
  const canEdit = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.updateBot.permissionAtom(environmentId),
  );
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  if (!supported) return null;
  const main = profiles.data?.bots.find((bot) => bot.role === "main");
  return (
    <SettingsSection id="goat-bot-profile" title="Profile">
      <SettingsRow
        {...searchableSetting("goat-bot-profile")}
        title={main === undefined ? "GOAT Bot" : [main.avatar, main.name].filter(Boolean).join(" ")}
        description={
          profiles.error
            ? "Could not load the bot's profile."
            : main === undefined
              ? "The profile appears once GOAT Bot has started."
              : main.purpose || "No purpose yet."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={main === undefined || !canEdit}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        }
      />
      {editing && main !== undefined ? (
        <GoatBotProfileDialog
          initial={main}
          canSubmit={canEdit}
          onClose={() => setEditing(false)}
          onSubmit={async (changes) => {
            const result = await update({
              environmentId,
              input: { botId: main.botId, ...changes },
            });
            if (result._tag === "Success") return null;
            const failure = squashAtomCommandFailure(result);
            return failure instanceof Error ? failure.message : "Could not save the profile.";
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

/** Every GOAT Bot control in one place: where it runs, then the channels that reach it. */
export function GoatBotSettingsPanel() {
  const besideChat = useClientSettings((settings) => settings.goatBotTaskThreadsBesideChat);
  const suggestionsHidden = useClientSettings((settings) => settings.goatBotSuggestedHidden);
  return (
    <SettingsPageContainer>
      <GoatBotStatusSettings />
      <GoatBotProfileSection />
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
      <SettingsSection id="goat-bot-suggestions" title="Home">
        <SettingsRow
          {...searchableSetting("goat-bot-suggestions")}
          title="Suggestions on the bot's home"
          description="Offer things GOAT can set up for the bot, such as reaching it from Slack. Applies to this device."
          control={
            <Switch
              aria-label="Suggestions on the bot's home"
              checked={!suggestionsHidden}
              onCheckedChange={(checked) =>
                void persistClientSettingsPatch({ goatBotSuggestedHidden: !checked })
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
