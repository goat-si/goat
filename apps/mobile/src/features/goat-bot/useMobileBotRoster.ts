import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelUpdateTaskViewInput } from "@goat/contracts";
import { useEffect, useState } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import { mobileBotRoster } from "./mobileBotRoster";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

export function useMobileBotRoster(selectedKey: string | null) {
  const home = useMobileGoatBotHomeMode();
  const selected = pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities =
    environmentId === null
      ? undefined
      : presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  const connected = selected?.connected === true;
  const supportsProfiles = connected && capabilities?.goatBotProfiles === true;
  const supportsTaskThreads = connected && capabilities?.goatBotTaskThreads === true;
  const profiles = useEnvironmentQuery(
    environmentId !== null && supportsProfiles
      ? channelEnvironment.listBots({ environmentId, input: {} })
      : null,
  );
  const threads = useEnvironmentQuery(
    environmentId !== null && supportsTaskThreads
      ? channelEnvironment.listBotThreads({ environmentId, input: {} })
      : null,
  );
  const slack = useEnvironmentQuery(
    environmentId !== null && connected && capabilities?.slackChannel === true
      ? channelEnvironment.slackSettings({ environmentId, input: {} })
      : null,
  );
  const [showMore, setShowMore] = useState(false);
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line goat/react-effect-budget -- Quiet task visibility changes with time.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const roster = mobileBotRoster({
    supportsProfiles,
    supportsTaskThreads,
    bots: profiles.data?.bots,
    children: threads.data?.rows,
    now,
    showMore,
    selectedKey,
  });
  const update = async (input: ChannelUpdateTaskViewInput) => {
    if (environmentId === null || !supportsTaskThreads)
      throw new Error("Bot task threads are unavailable.");
    const result = await runAtomCommand(appAtomRegistry, channelEnvironment.updateTaskView, {
      environmentId,
      input,
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    threads.refresh();
  };
  return {
    ...roster,
    environmentId,
    slackEnabled: slack.data?.some((connection) => connection.enabled) === true,
    showMore: () => setShowMore(true),
    update,
    error: profiles.error ?? threads.error,
  };
}
