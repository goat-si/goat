import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { GoatBotRowStatus } from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelGetBotStatusResult } from "@goat/contracts";
import { useEffect } from "react";

import { channelEnvironment } from "../../state/channels";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

/**
 * How many of a member's tasks wait on a person, its conversation's newest message, and whether
 * that message is the bot's and arrived after the last visit. One cached read per member, read
 * again only when that member's conversation changes or is visited. \`status\` is what its row face
 * reads, null until the server has answered.
 */
export function useMobileMemberStatus(bot: BotProfile): {
  readonly waitingCount: number;
  /**
   * Whether the waiting count is known: pending before an answer, unavailable after a failed read
   * or from a server that cannot count by visit. Only rows Home governs read it.
   */
  readonly waitingState: "ready" | "pending" | "unavailable";
  readonly latest: ChannelGetBotStatusResult["latest"];
  readonly unread: boolean;
  readonly status: GoatBotRowStatus | null;
} {
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
  const lastVisitedAt = shell?.lastVisitedAt ?? null;
  const revision = shell === null ? null : `${shell.updatedAt}:${lastVisitedAt ?? ""}`;
  const refresh = status.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Read the member's status again when its conversation changes or is visited.
  useEffect(() => {
    if (supported && revision !== null) refresh();
  }, [supported, revision, refresh]);
  const latest = status.data?.latest;
  // A server that records no visits (lastVisitedAt absent) cannot say what was read.
  const tracksVisits = shell !== null && shell.lastVisitedAt !== undefined;
  const unread =
    tracksVisits &&
    latest?.author === "bot" &&
    (lastVisitedAt === null || Date.parse(latest.at) > Date.parse(lastVisitedAt));
  const data = status.data ?? null;
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  // A count that ignores visits never clears when the person reads the member's chat.
  const visitAware =
    capabilities?.goatBotStatus === true &&
    capabilities.goatBotWaitingRead === true &&
    capabilities.threadVisitedTracking === true;
  return {
    waitingCount: data?.waitingCount ?? 0,
    // A failed refresh keeps its earlier answer beside the error; that answer is no longer known.
    waitingState:
      supported && (!visitAware || status.error !== null)
        ? "unavailable"
        : data !== null
          ? "ready"
          : "pending",
    latest,
    unread,
    status:
      data === null
        ? null
        : {
            waitingCount: data.waitingCount,
            latest: data.latest,
            ...(data.tasks === undefined ? {} : { tasks: data.tasks }),
          },
  };
}
