import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { GoatBotStatusCard } from "../goatBot/GoatBotStatusCard";
import { useGoatBotHomeSettings } from "../goatBot/useGoatBotHome";
import { SettingsSection } from "./settingsLayout";

/** The main bot's status, here too when its home machine is offline and the chat cannot open. */
export function GoatBotStatusSettings() {
  const { supported: homeSupported, resolution } = useGoatBotHomeSettings();
  const environmentId = resolution.state === "claimed" ? resolution.claim.environmentId : null;
  const presentation = useEnvironment(environmentId);
  const connected = presentation?.connection.phase === "connected";
  const listsTasks =
    connected && presentation?.serverConfig?.environment.capabilities.goatBotTaskThreads === true;
  const threads = useEnvironmentQuery(
    environmentId !== null && listsTasks
      ? channelEnvironment.listBotThreads({ environmentId, input: {} })
      : null,
  );
  if (!homeSupported) return null;
  return (
    <SettingsSection id="goat-bot-status" title="Status">
      <GoatBotStatusCard
        className="px-3 py-3 sm:px-4"
        environmentId={environmentId}
        member={null}
        rows={listsTasks ? (threads.data?.rows ?? null) : "unavailable"}
      />
    </SettingsSection>
  );
}
