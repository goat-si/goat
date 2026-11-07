import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { BotProfile } from "@goat/contracts";
import { useEffect } from "react";

import { channelEnvironment } from "../../state/channels";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

/**
 * How many of a member's tasks wait on a person. One cached read per member, read again only
 * when that member's conversation changes.
 */
export function useMobileMemberWaitingCount(bot: BotProfile): number {
  const { presentationById } = useEnvironments();
  const presentation = presentationById.get(bot.environmentId);
  const supported =
    bot.state !== "deleted" &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotMembers === true;
  const status = useEnvironmentQuery(
    supported
      ? channelEnvironment.botStatus({
          environmentId: bot.environmentId,
          input: { botId: bot.botId },
        })
      : null,
  );
  const shell = useThreadShell(scopeThreadRef(bot.environmentId, bot.sessionThreadId));
  const revision = shell === null ? null : String(shell.updatedAt);
  const refresh = status.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Read the member's waiting count again when its conversation changes.
  useEffect(() => {
    if (supported && revision !== null) refresh();
  }, [supported, revision, refresh]);
  return status.data?.waitingCount ?? 0;
}
