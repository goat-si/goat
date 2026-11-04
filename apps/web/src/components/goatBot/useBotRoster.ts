import { botRoster } from "@goat/client-runtime/goatBot";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { useGoatBotEnabled } from "./useGoatBotSession";

export function useBotRoster() {
  const { environment } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const connected = presentation?.connection.phase === "connected";
  const profiles = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.goatBotProfiles === true
      ? channelEnvironment.listBots({ environmentId, input: {} })
      : null,
  );
  const threads = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.goatBotTaskThreads === true
      ? channelEnvironment.listBotThreads({ environmentId, input: {} })
      : null,
  );
  const slack = useEnvironmentQuery(
    connected && environmentId !== null && capabilities?.slackChannel === true
      ? channelEnvironment.slackSettings({ environmentId, input: {} })
      : null,
  );
  return {
    environmentId,
    roster: botRoster({
      supportsProfiles: capabilities?.goatBotProfiles === true,
      bots: profiles.data?.bots,
    }),
    rows: threads.data?.rows ?? [],
    refresh: threads.refresh,
    slackEnabled: slack.data?.some((connection) => connection.enabled) === true,
  };
}
