import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "~/lib/archivedThreadsState";

import {
  resolveThreadDetailRef,
  useEnvironmentShellsBootstrapped,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";

import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { toastManager } from "../ui/toast";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
import { GoatBotChatView } from "./GoatBotChatView";
import { resolveGoatBotRemoval, type GoatBotRemoval } from "@goat/client-runtime/goatBot";
import { GoatBotChannelContext } from "./goatBotChannelPort";
import { useLegacyGlobalAgentRoute } from "./goatBotHooks";
import { useGoatBotHomeSettings } from "./useGoatBotHome";
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
  const port = useContext(GoatBotChannelContext);
  return (
    <GoatBotThreadSession
      key={`${environmentId}:${threadId}:${port ? "port" : "none"}`}
      environmentId={environmentId}
      threadId={threadId}
    />
  );
}

function GoatBotThreadSession({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(threadRef);
  const bootstrapped = useEnvironmentShellsBootstrapped(environmentId);
  const visibleTurnItems = useThreadVisibleTurnItems(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  );
  const session = useGoatBotSession(visibleTurnItems);
  const homeSettings = useGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
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
  const confirmedHere =
    session.confirmedBot?.environmentId === environmentId &&
    session.confirmedBot.threadId === threadId;
  const [shellSeen, setShellSeen] = useState(shell !== null);
  const [resolvedRemoval, setRemoval] = useState<GoatBotRemoval>(null);
  if (shell !== null) {
    if (!shellSeen) setShellSeen(true);
    if (resolvedRemoval !== null) setRemoval(null);
  }
  // An archived bot was the bot here, so if it disappears from the archive too it was deleted.
  const resolveRemoval = (next: GoatBotRemoval) => {
    if (next === "archived") setShellSeen(true);
    setRemoval(next);
  };
  const canOpenCurrentBot = session.confirmedBot !== null && !confirmedHere;
  // Keep the resolved removal while ensure is pending or failed, when confirmedHere is false.
  const removal =
    shell !== null ? null : bootstrapped && canOpenCurrentBot ? "deleted" : resolvedRemoval;
  // The server starts a new bot when its thread was deleted, so ask once per deleted thread.
  const retryAvailability = session.onRetryAvailability;
  const replacementAskedFor = useRef<string | null>(null);
  useEffect(() => {
    if (removal !== "deleted" || !confirmedHere || replacementAskedFor.current === threadId) return;
    replacementAskedFor.current = threadId;
    retryAvailability();
  }, [confirmedHere, removal, retryAvailability, threadId]);
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  return (
    <>
      {shell !== null ? <ThreadVisitWatermark threadRef={threadRef} /> : null}
      {shell === null && bootstrapped && confirmedHere && removal !== "deleted" ? (
        <GoatBotRemovalProbe
          environmentId={environmentId}
          threadId={threadId}
          shellSeen={shellSeen}
          onResolve={resolveRemoval}
        />
      ) : null}
      <GoatBotChatView
        {...session}
        homeMove={
          moveTarget
            ? {
                label: moveTarget.label,
                busy: homeSettings.busy,
                onMove: () => homeSettings.changeHome(moveTarget.environmentId),
              }
            : undefined
        }
        homeMoveError={homeSettings.error}
        rows={removal === null ? session.rows : NO_PENDING}
        removal={removal}
        canOpenCurrentBot={canOpenCurrentBot}
        onUnarchive={
          removal === "archived" && session.canOperate
            ? () =>
                void unarchive({ environmentId, input: { threadId } }).then((result) => {
                  if (result._tag === "Failure") {
                    toastManager.add({
                      type: "error",
                      title: "Couldn't unarchive GOAT Bot",
                      description: "It may have been deleted. Check again in a moment.",
                    });
                  }
                  refreshArchivedThreadsForEnvironment(environmentId);
                })
            : undefined
        }
        onCheckAgain={
          removal === "unchecked"
            ? () => refreshArchivedThreadsForEnvironment(environmentId)
            : undefined
        }
        legacyAgentRoute={legacyAgentRoute}
      />
    </>
  );
}

/** Read the archived stream only while a confirmed bot is missing from the active shells. */
function GoatBotRemovalProbe({
  environmentId,
  threadId,
  shellSeen,
  onResolve,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shellSeen: boolean;
  readonly onResolve: (removal: GoatBotRemoval) => void;
}) {
  const { snapshots, isLoading, error } = useArchivedThreadSnapshots([environmentId]);
  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    refreshArchivedThreadsForEnvironment(environmentId);
    // oxlint-disable-next-line react/set-state-in-effect -- Consume the snapshot only after refreshing its external query.
    setRefreshed(true);
  }, [environmentId]);
  const snapshot = snapshots.find((entry) => entry.environmentId === environmentId)?.snapshot;
  const archived =
    !refreshed || isLoading || error !== null || snapshot === undefined
      ? null
      : snapshot.threads.some((thread) => thread.id === threadId);
  const failed = refreshed && !isLoading && error !== null;
  useEffect(() => {
    if (failed) onResolve("unchecked");
  }, [failed, onResolve]);
  useEffect(() => {
    if (archived === null) return;
    onResolve(
      resolveGoatBotRemoval({
        shell: null,
        shellSeen,
        archived,
        bootstrapped: true,
        confirmedHere: true,
      }),
    );
  }, [archived, shellSeen, onResolve]);
  return null;
}
