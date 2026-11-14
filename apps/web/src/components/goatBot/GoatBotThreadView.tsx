import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";

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
import { useUiStateStore } from "~/uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ThreadVisitWatermark } from "../chat/ThreadVisitWatermark";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotStepsProvider } from "./GoatBotStepsProvider";
import { GoatBotActivityContext } from "./GoatBotTimeline";
import { resolveGoatBotRemoval, type GoatBotRemoval } from "@goat/client-runtime/goatBot";
import { GoatBotChannelContext } from "./goatBotChannelPort";
import { useLegacyGlobalAgentRoute } from "./goatBotHooks";
import {
  GoatBotMainProfileContext,
  GoatBotMemberContext,
  useGoatBotName,
} from "./goatBotMemberContext";
import { useGoatBotSession } from "./useGoatBotSession";
import { useBotManage } from "./useBotManage";
import { useGoatBotHomeSettings } from "./useGoatBotHome";
import { refreshGoatBotWaitingCount } from "./useGoatBotWaitingCount";
import { restoreTaskOpener, getTaskPaneFocus } from "./taskPaneFocus";

const NO_PENDING = [] as const;

/**
 * The GOAT Bot thread. It always renders as the bot, whatever the server or
 * connection state, so the coding composer never appears on it. Sending stays
 * off until the server confirms the bot on this connection.
 */
export function GoatBotThreadView({
  environmentId,
  threadId,
  member = null,
  main = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Set when this thread is a member bot's conversation rather than the main bot's. */
  readonly member?: BotProfile | null;
  /** The main bot's profile, which names the main chat. */
  readonly main?: BotProfile | null;
}) {
  const port = useContext(GoatBotChannelContext);
  return (
    <GoatBotMainProfileContext value={main}>
      <GoatBotMemberContext value={member}>
        <GoatBotThreadSession
          key={`${environmentId}:${threadId}:${port ? "port" : "none"}`}
          environmentId={environmentId}
          threadId={threadId}
          member={member}
        />
      </GoatBotMemberContext>
    </GoatBotMainProfileContext>
  );
}

function GoatBotThreadSession({
  environmentId,
  threadId,
  member,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly member: BotProfile | null;
}) {
  const taskFocus = getTaskPaneFocus();
  // An older task's Open Home names this bot's Home in the history entry it navigates to. The
  // request is taken once and removed from that entry, so Back, Forward or a remount find none.
  const openHomeKey = useLocation({ select: (location) => location.state.goatBotOpenHome ?? null });
  const openHomeEntry = useLocation({ select: (location) => location.state.__TSR_key ?? "" });
  const [openHome, setOpenHome] = useState<{ key: string; entry: string } | null>(null);
  if (openHomeKey !== null && openHome?.entry !== openHomeEntry)
    setOpenHome({ key: openHomeKey, entry: openHomeEntry });
  const router = useRouter();
  // oxlint-disable-next-line goat/react-effect-budget -- Removes the one-shot Open Home request from the browser history entry.
  useEffect(() => {
    const location = (router as typeof router | null)?.state.location;
    if (openHomeKey === null || location?.state.goatBotOpenHome === undefined) return;
    const { goatBotOpenHome: _taken, ...state } = location.state;
    router.history.replace(location.href, state);
  }, [openHomeKey, router]);
  // oxlint-disable-next-line goat/react-effect-budget -- Restore focus after the bot thread remounts.
  useLayoutEffect(() => {
    restoreTaskOpener(taskFocus);
  });
  const threadRef = scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const [unreadSince, setUnreadSince] = useState(() =>
    shell === null
      ? undefined
      : (resolveThreadLastVisitedAt(shell.lastVisitedAt, localLastVisitedAt) ?? null),
  );
  if (unreadSince === undefined && shell !== null) {
    setUnreadSince(resolveThreadLastVisitedAt(shell.lastVisitedAt, localLastVisitedAt) ?? null);
  }
  const bootstrapped = useEnvironmentShellsBootstrapped(environmentId);
  const visibleTurnItems = useThreadVisibleTurnItems(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  );
  const session = useGoatBotSession(visibleTurnItems, null, member, threadRef);
  const manage = useBotManage(environmentId);
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
  const botName = useGoatBotName();
  // Archive, deletion and replacement checks below are the main bot's; a member's state is its profile.
  const confirmedHere =
    member === null &&
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
  const canOpenCurrentBot = member === null && session.confirmedBot !== null && !confirmedHere;
  // Keep the resolved removal while ensure is pending or failed, when confirmedHere is false.
  const removal =
    member !== null
      ? member.state === "deleted"
        ? "deleted"
        : null
      : shell !== null
        ? null
        : bootstrapped && canOpenCurrentBot
          ? "deleted"
          : resolvedRemoval;
  // The server starts a new bot when its thread was deleted, so ask once per deleted thread.
  const retryAvailability = session.onRetryAvailability;
  const replacementAskedFor = useRef<string | null>(null);
  useEffect(() => {
    if (removal !== "deleted" || !confirmedHere || replacementAskedFor.current === threadId) return;
    replacementAskedFor.current = threadId;
    retryAvailability();
  }, [confirmedHere, removal, retryAvailability, threadId]);
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  const rows = removal === null ? session.rows : NO_PENDING;
  return (
    <GoatBotActivityContext value={removal === null ? session.activity : null}>
      {shell !== null ? <ThreadVisitWatermark threadRef={threadRef} /> : null}
      {shell === null && bootstrapped && confirmedHere && removal !== "deleted" ? (
        <GoatBotRemovalProbe
          environmentId={environmentId}
          threadId={threadId}
          shellSeen={shellSeen}
          onResolve={resolveRemoval}
        />
      ) : null}
      <GoatBotStepsProvider
        visibleTurnItems={visibleTurnItems}
        environmentId={removal === null ? environmentId : null}
      >
        <GoatBotChatView
          {...session}
          projectionRef={threadRef}
          environmentId={environmentId}
          unreadSince={unreadSince}
          openHome={openHome}
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
          rows={rows}
          removal={removal}
          canOpenCurrentBot={canOpenCurrentBot}
          onRestore={
            member !== null && manage.canManage ? () => void manage.restore(member) : undefined
          }
          onUnarchive={
            member === null && removal === "archived" && session.canOperate
              ? () =>
                  void unarchive({ environmentId, input: { threadId } }).then((result) => {
                    if (result._tag === "Failure") {
                      toastManager.add({
                        type: "error",
                        title: `Couldn't unarchive ${botName}`,
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
      </GoatBotStepsProvider>
    </GoatBotActivityContext>
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
