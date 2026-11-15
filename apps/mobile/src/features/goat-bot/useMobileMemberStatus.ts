import { scopeThreadRef } from "@goat/client-runtime/environment";
import { goatBotPreviewText, type GoatBotRowStatus } from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelGetBotStatusResult } from "@goat/contracts";
import { useEffect, useMemo } from "react";

import { channelEnvironment } from "../../state/channels";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useKeptPerComputer } from "./useKeptPerComputer";

/**
 * How many of a member's tasks wait on a person, its conversation's newest message, and whether
 * that message is the bot's and arrived after the last visit. One cached read per member, read
 * again when its conversation changes or is visited; offline, the last answer kept for it, and
 * nothing once access is refused or the computer removed. \`status\` is what its row face reads.
 */
// The row shows one line; a kept message is cut well past what a phone row can show.
const KEPT_LINE_LENGTH = 200;

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
  /** What the row shows was read before the computer went offline, and may be out of date. */
  readonly kept: boolean;
} {
  const { presentationById } = useEnvironments();
  const presentation = presentationById.get(bot.environmentId);
  const offline = presentation?.connection.phase !== "connected";
  const supported =
    bot.state !== "deleted" &&
    !offline &&
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
  // Kept: the count and the row's one line of the newest message, never the work it saw going.
  const answer = status.data;
  const row = useMemo(
    () =>
      answer === null
        ? null
        : {
            waitingCount: answer.waitingCount,
            ...(answer.latest === undefined
              ? {}
              : {
                  latest: {
                    ...answer.latest,
                    text: goatBotPreviewText(answer.latest.text).slice(0, KEPT_LINE_LENGTH),
                  },
                }),
          },
    [answer],
  );
  const shown = useKeptPerComputer(
    "status",
    bot.state === "deleted" ? null : bot.environmentId,
    { ...status, data: row },
    offline,
    bot.botId,
  );
  const kept = shown !== null && answer === null;
  const data = shown === null ? null : kept ? shown : answer;
  const latest = data?.latest;
  // A server that records no visits (lastVisitedAt absent) cannot say what was read.
  const tracksVisits = shell !== null && shell.lastVisitedAt !== undefined;
  const unread =
    tracksVisits &&
    latest?.author === "bot" &&
    (lastVisitedAt === null || Date.parse(latest.at) > Date.parse(lastVisitedAt));
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
        : data !== null && !kept
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
            ...(kept || answer?.tasks === undefined ? {} : { tasks: answer.tasks }),
          },
    kept,
  };
}
