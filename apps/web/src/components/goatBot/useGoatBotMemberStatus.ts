import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { BotProfile, ChannelGetBotStatusResult } from "@goat/contracts";
import { useEffect } from "react";

import { useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";

/**
 * How many of a member's tasks wait on a person, whether its tasks are going, and its
 * conversation's newest message. One cached read per member, read again only when that member's
 * conversation changes or is visited; main keeps its own observer.
 */
export function useGoatBotMemberStatus(member: BotProfile | null): {
  readonly waitingCount: number;
  readonly sidebarWaitingCount: number | undefined;
  readonly sidebarWaitingState: "ready" | "pending" | "unavailable";
  readonly latest: ChannelGetBotStatusResult["latest"];
  readonly tasks: ChannelGetBotStatusResult["tasks"];
} {
  const environmentId = member?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const supported =
    member !== null &&
    member.state !== "deleted" &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotMembers === true;
  const status = useEnvironmentQuery(
    supported
      ? channelEnvironment.botStatus({
          environmentId: member.environmentId,
          input: { botId: member.botId },
        })
      : null,
  );
  const shell = useThreadShell(
    member === null ? null : scopeThreadRef(member.environmentId, member.sessionThreadId),
  );
  const revision = shell === null ? null : `${shell.updatedAt}:${shell.lastVisitedAt ?? ""}`;
  const refresh = status.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Read the member's waiting count again when its conversation changes.
  useEffect(() => {
    if (supported && revision !== null) refresh();
  }, [supported, revision, refresh]);
  const visitAware =
    supported &&
    presentation?.serverConfig?.environment.capabilities.goatBotStatus === true &&
    presentation.serverConfig.environment.capabilities.goatBotWaitingRead === true;
  return {
    sidebarWaitingState: !visitAware
      ? "unavailable"
      : status.isSuccess
        ? "ready"
        : status.error
          ? "unavailable"
          : "pending",
    waitingCount: status.data?.waitingCount ?? 0,
    sidebarWaitingCount:
      supported &&
      presentation?.serverConfig?.environment.capabilities.goatBotStatus === true &&
      presentation.serverConfig.environment.capabilities.goatBotWaitingRead === true &&
      status.isSuccess
        ? status.data?.waitingCount
        : undefined,
    latest: status.data?.latest,
    tasks: status.data?.tasks,
  };
}

export function useGoatBotMemberWaitingCount(member: BotProfile | null): number {
  return useGoatBotMemberStatus(member).waitingCount;
}
