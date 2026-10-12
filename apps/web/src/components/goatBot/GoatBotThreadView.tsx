import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import {
  resolveThreadDetailRef,
  useEnvironmentShellsBootstrapped,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";

import { GoatBotChatView } from "./GoatBotChatView";
import { useLegacyGlobalAgentRoute } from "./goatBotHooks";
import { useGoatBotSession } from "./useGoatBotSession";
import { refreshGoatBotWaitingCount } from "./useGoatBotWaitingCount";

const NO_PENDING = [] as const;

/**
 * The GOAT Bot thread. It always renders as the bot, whatever the server or
 * connection state, so the coding composer never appears on it. Sending stays
 * off until the server confirms the bot on this connection.
 */
export function GoatBotThreadView({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const bootstrapped = useEnvironmentShellsBootstrapped(environmentId);
  const visibleTurnItems = useThreadVisibleTurnItems(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  );
  const session = useGoatBotSession(visibleTurnItems);
  const chipRevision = visibleTurnItems
    .flatMap(({ item }) =>
      item.type === "notification" && item.ledgerTask
        ? [`${item.ledgerTask.taskId}:${item.ledgerTask.taskVersion}`]
        : [],
    )
    .join("|");
  useEffect(() => {
    refreshGoatBotWaitingCount(environmentId, chipRevision);
  }, [environmentId, chipRevision]);
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const removed =
    bootstrapped && (shell === null || shell.archivedAt !== null || shell.deletedAt != null);
  return (
    <GoatBotChatView
      {...session}
      rows={removed ? NO_PENDING : session.rows}
      removed={removed}
      legacyAgentRoute={legacyAgentRoute}
    />
  );
}
