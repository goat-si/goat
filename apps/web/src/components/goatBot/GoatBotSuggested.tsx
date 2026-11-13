import type { EnvironmentId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";

import { persistClientSettingsPatch, useClientSettings } from "~/hooks/useSettings";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { MessageCircleIcon } from "../solar";
import { Button } from "../ui/button";
import { useGoatBotMember } from "./goatBotMemberContext";
import { GoatBotCardRow, GoatBotSectionCard } from "./GoatBotSectionCard";

/**
 * One thing GOAT can set up for this bot: reaching it from Slack. It shows only while Slack is
 * supported and no channel is connected; Settings brings it back after a person hides it.
 */
export function GoatBotSuggested({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const member = useGoatBotMember();
  const hidden = useClientSettings((settings) => settings.goatBotSuggestedHidden);
  const presentation = useEnvironment(environmentId);
  const supported =
    member === null &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.slackChannel === true;
  const slack = useEnvironmentQuery(
    supported ? channelEnvironment.slackSettings({ environmentId, input: {} }) : null,
  );
  const connected = slack.data?.some((connection) => connection.enabled) === true;
  if (hidden || !supported || !slack.isSuccess || slack.data == null || connected) return null;
  return (
    <GoatBotSectionCard
      title="Suggested"
      action={
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void persistClientSettingsPatch({ goatBotSuggestedHidden: true })}
        >
          Hide
        </Button>
      }
    >
      <GoatBotCardRow
        mark={<MessageCircleIcon aria-hidden className="size-4" />}
        title="Connect Slack"
        detail="Talk to this bot from Slack"
        chevron
        link={
          <Link
            to="/settings/goat-bot"
            search={{ machine: environmentId }}
            hash="slack-channel"
            aria-label="Connect Slack"
          />
        }
      />
    </GoatBotSectionCard>
  );
}
