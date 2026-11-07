import { GoatBotStatusCard } from "../goatBot/GoatBotStatusCard";
import { useBotThreads } from "../goatBot/useBotRoster";
import { useGoatBotHomeSettings } from "../goatBot/useGoatBotHome";
import { useEnvironment } from "~/state/environments";
import { SettingsSection } from "./settingsLayout";

/** The main bot's status, here too when its home machine is offline and the chat cannot open. */
export function GoatBotStatusSettings() {
  const { supported: homeSupported, resolution } = useGoatBotHomeSettings();
  const environmentId = resolution.state === "claimed" ? resolution.claim.environmentId : null;
  const presentation = useEnvironment(environmentId);
  const listsTasks =
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotTaskThreads === true;
  // The same task list the sidebar reads, refreshed when the bot's conversation records work.
  const threads = useBotThreads(environmentId, null);
  if (!homeSupported) return null;
  return (
    <SettingsSection id="goat-bot-status" title="Status">
      <GoatBotStatusCard
        className="px-3 py-3 sm:px-4"
        environmentId={environmentId}
        member={null}
        rows={!listsTasks ? "unavailable" : threads.loaded ? threads.rows : null}
      />
    </SettingsSection>
  );
}
