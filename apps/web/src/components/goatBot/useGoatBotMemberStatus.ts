import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { BotProfile } from "@goat/contracts";
import { useEffect } from "react";

import { useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";

/**
 * How many of a member's tasks wait on a person. One cached read per member, read again only
 * when that member's conversation changes or is visited; main keeps its own observer.
 */
export function useGoatBotMemberWaitingCount(member: BotProfile | null): number {
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
  return status.data?.waitingCount ?? 0;
}
