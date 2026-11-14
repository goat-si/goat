import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  presentTaskStatus,
  workRowCollapsed,
} from "@goat/client-runtime/goatBot";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type {
  BotThreadRow,
  ChannelBotArtifact,
  ChannelTaskId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ArrowLeftIcon, XIcon } from "~/components/solar";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { GoatBotMainAvatar, GoatBotSessionAvatar } from "./GoatBotAvatar";
import { GoatBotComputer } from "./GoatBotComputer";
import { GoatBotEditBotButton } from "./GoatBotEditBotButton";
import { GoatBotHomeWork } from "./GoatBotHomeWork";
import { GoatBotLibrary } from "./GoatBotLibrary";
import { GoatBotMemory } from "./GoatBotMemory";
import { GoatBotNewRoutineButton, GoatBotRoutines } from "./GoatBotRoutines";
import { GoatBotSectionCard } from "./GoatBotSectionCard";
import { GoatBotStatusCard } from "./GoatBotStatusCard";
import { GoatBotSuggested } from "./GoatBotSuggested";
import { GoatBotWorkPeek } from "./GoatBotWorkPeek";
import {
  goatBotSearch,
  memberThreadsKey,
  useGoatBotPicture,
  useGoatBotMember,
  useGoatBotName,
} from "./goatBotMemberContext";
import { useBotThreads } from "./useBotRoster";
import { useBotWorkHistory } from "./useBotWorkHistory";
import { useGoatBotMemberWaitingCount } from "./useGoatBotMemberStatus";
import type { GoatBotRoutineLanding } from "./useGoatBotRoutineLanding";
import type { GoatBotSourceIds } from "./useGoatBotSource";

// Home is one scroll of what the bot runs and does; Library holds what it keeps.
const tabs = ["Home", "Library"] as const;
type Tab = (typeof tabs)[number];

export function GoatBotWorkPanel({
  environmentId,
  threadId,
  onDraft,
  notesRefreshKey,
  onShowChat,
  onClose,
  peekRows,
  peekSource,
  onRetryInput,
  openFile = null,
  onOpenFile,
  routineLanding = null,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Set only in a sheet over the chat: Back to chat and links to the chat call it to close it. */
  onShowChat?: (() => void) | undefined;
  /** Set only on the pinned panel: its Close button, which the chat points back at the name chip. */
  onClose?: (() => void) | undefined;
  /** Puts a message in this chat's composer; absent while the chat cannot send. */
  onDraft?: ((text: string) => void) | undefined;
  notesRefreshKey?: string | undefined;
  /** A task's conversation, for reading it here without leaving the bot's chat. */
  peekRows?: ((taskId: ChannelTaskId) => ReadonlyArray<GoatBotRow>) | undefined;
  /** The chat's displayed-thread source that peekRows come from. */
  peekSource?: GoatBotSourceIds | undefined;
  onRetryInput?: ((clientKey: string) => void) | undefined;
  /** The Library file open in the chat, if any. */
  openFile?: string | null | undefined;
  /** Opens a Library file in place of the conversation. */
  onOpenFile: (file: ChannelBotArtifact) => void;
  /** A routine chip in the chat: Home shows with that routine's row focused. */
  routineLanding?: GoatBotRoutineLanding | null | undefined;
}) {
  const [tab, setTab] = useState<Tab>("Home");
  // Work's tail stays open across a peek, which replaces the whole Home scroll while it shows.
  const [showAllWork, setShowAllWork] = useState(false);
  const [peek, setPeek] = useState<{
    readonly taskId: ChannelTaskId;
    readonly title: string;
  } | null>(null);
  // Where focus lands once Home shows again: the row Back returns to, or the Home tab when the
  // peek held focus and closed because its task left the list. It applies once, so later tab
  // switches keep focus.
  const [focusTarget, setFocusTarget] = useState<ChannelTaskId | "home" | null>(null);
  // A peek removed while focused fires no blur, so this still says it held focus as it closes.
  const [peekHasFocus, setPeekHasFocus] = useState(false);
  // The routine row a chip asked for; it takes focus once it shows, and nothing else moves it.
  const [routineFocus, setRoutineFocus] = useState<string | null>(null);
  // What held focus at the chip click; a row that shows later takes focus only if it still does.
  const [landingFrom, setLandingFrom] = useState<Element | null>(null);
  const [landedSeq, setLandedSeq] = useState<number | null>(null);
  if (routineLanding !== null && routineLanding.seq !== landedSeq) {
    setLandedSeq(routineLanding.seq);
    setTab("Home");
    setPeek(null);
    setPeekHasFocus(false);
    setFocusTarget(null);
    setRoutineFocus(routineLanding.routineId);
    setLandingFrom(routineLanding.from);
  }
  const focusOnce = (element: HTMLElement | null) => {
    if (element === null) return;
    // Only focus that the closed peek dropped moves; someone typing elsewhere keeps theirs.
    const active = document.activeElement;
    // Home restores its own scroll, so the row it returns to does not drag the panel with it.
    if (active === null || active === document.body) element.focus({ preventScroll: true });
    setFocusTarget(null);
  };
  // Back also returns Home to where it was scrolled, once per mount; a routine landing scrolls it.
  const homeScroll = useRef(0);
  const homePanel = useRef<HTMLElement | null>(null);
  const restoreHome = (element: HTMLElement | null) => {
    if (element === null || element === homePanel.current) return;
    homePanel.current = element;
    if (routineFocus === null) {
      element.scrollTop = homeScroll.current;
      // A row Back returned focus to may have moved below that scroll while the peek was open.
      const active = document.activeElement;
      if (active instanceof HTMLElement && element.contains(active))
        active.scrollIntoView({ block: "nearest" });
    }
  };
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  const picture = useGoatBotPicture();
  const memberWaiting = useGoatBotMemberWaitingCount(member);
  const current = useBotThreads(environmentId, memberThreadsKey(member));
  const { supported, loaded, failed, failure, turnsWaiting, refresh } = current;
  const environment = useEnvironment(environmentId);
  const history = useBotWorkHistory(
    environmentId,
    member?.botId ?? null,
    environment?.connection.phase === "connected"
      ? environment.serverConfig?.environment.capabilities
      : undefined,
    {
      rows: current.rows,
      remoteWork: current.remoteWork,
      mainMessageCount: current.mainMessageCount ?? 0,
    },
    loaded && !failed,
  );
  const { rows, remoteWork } = history;
  const offline = environment?.connection.phase === "offline";
  const routines = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  // A settled list without the routine ends the landing, so no later update moves focus.
  if (
    routineFocus !== null &&
    routines.isSuccess &&
    !routines.isPending &&
    routines.data !== null &&
    !routines.data.tasks.some((task) => task.id === routineFocus && task.threadId === threadId)
  ) {
    setRoutineFocus(null);
  }
  const panelRef = useRef<HTMLDivElement>(null);
  // The same rule as the closed peek's: focus moves only if the person has not moved it since.
  const landingMayFocus = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      active === landingFrom ||
      (panelRef.current?.contains(active) ?? false)
    );
  };
  // In the top padding Home and a task view both leave; inside the panel, so a routine landing
  // still sees the sheet's opening focus as the panel's.
  const backToChat = onShowChat ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={onShowChat}
      className="absolute start-2 top-2.5 z-10 max-sm:start-[calc(var(--workspace-controls-left)+2.5rem)]"
    >
      <ArrowLeftIcon aria-hidden />
      Back to chat
    </Button>
  ) : null;
  const peeked =
    peek === null
      ? undefined
      : rows.find(
          (row): row is Extract<BotThreadRow, { kind: "task" }> =>
            row.kind === "task" && row.task.taskId === peek.taskId,
        );
  // A task the list no longer has, once it has loaded, closes its peek.
  const peekGone = peek !== null && loaded && !failed && peeked === undefined;
  if (peekGone) {
    setPeek(null);
    setPeekHasFocus(false);
    if (peekHasFocus) setFocusTarget("home");
  }
  if (peek !== null && peekRows !== undefined && !peekGone) {
    return (
      <div
        className="contents"
        onFocus={() => setPeekHasFocus(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPeekHasFocus(false);
        }}
      >
        {backToChat}
        <GoatBotWorkPeek
          taskId={peek.taskId}
          title={peeked?.task.title ?? peek.title}
          statusLabel={
            peeked === undefined
              ? ""
              : presentTaskStatus(peeked.task.status, peeked.view.doneAt).label
          }
          rows={peekRows(peek.taskId)}
          source={peekSource}
          environmentId={environmentId}
          unreadThrough={peeked?.unread === true ? peeked.lastActivityAt : null}
          onAcknowledged={(taskId, through) => {
            history.markRead(taskId, through);
            refresh();
          }}
          onRetry={onRetryInput}
          onBack={() => {
            // Work that finished meanwhile may have pushed this row behind Show more.
            if (
              peeked !== undefined &&
              workRowCollapsed(rows, environmentId, remoteWork, peek.taskId)
            )
              setShowAllWork(true);
            setFocusTarget(peeked === undefined ? "home" : peek.taskId);
            setPeekHasFocus(false);
            setPeek(null);
          }}
        />
      </div>
    );
  }
  return (
    <div ref={panelRef} className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-4 text-sm">
      {backToChat}
      <header className="relative flex flex-col items-center gap-2 px-1 pt-3 pb-4 text-center">
        {/* Back to chat on the sheet and Close on the pinned panel never share a panel, but the
            row keeps either one where it was and leaves the hero centred. */}
        <div className="flex min-h-7 w-full items-center justify-between gap-2">
          <span aria-hidden />
          <div className="flex items-center gap-1">
            <GoatBotEditBotButton />
            {onClose === undefined ? null : (
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                <XIcon aria-hidden />
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-col items-center gap-2">
          {member === null ? (
            <GoatBotMainAvatar
              size="xl"
              chatOpen={false}
              emoji={picture.emoji}
              surface={onShowChat ? "popover" : "screen"}
            />
          ) : (
            <GoatBotSessionAvatar
              size="xl"
              surface={onShowChat ? "popover" : "screen"}
              place="list"
              emoji={picture.emoji}
              accent={picture.accent}
              waitingCount={memberWaiting}
              threadRef={scopeThreadRef(member.environmentId, member.sessionThreadId)}
            />
          )}
          <h2 className="max-w-full truncate text-xl font-semibold">{botName}</h2>
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value: Tab) => {
          setTab(value);
          setRoutineFocus(null);
        }}
        className="min-h-0 flex-1"
      >
        <TabsList aria-label={`${botName} work`} variant="plain" className="justify-center">
          {tabs.map((name) => (
            <TabsTab
              key={name}
              value={name}
              variant="plain"
              ref={name === "Home" && focusTarget === "home" ? focusOnce : undefined}
            >
              {name}
            </TabsTab>
          ))}
        </TabsList>
        <TabsPanel
          value="Home"
          className="mt-4 min-h-0 overflow-y-auto"
          ref={restoreHome}
          onScroll={(event) => {
            homeScroll.current = event.currentTarget.scrollTop;
          }}
        >
          <div className="flex flex-col gap-5 pt-1">
            <GoatBotStatusCard
              environmentId={environmentId}
              member={member}
              rows={!supported ? "unavailable" : failed ? "failed" : loaded ? rows : null}
              turnsWaiting={turnsWaiting}
              onShowChat={onShowChat}
              quietWhenReady
            />
            <GoatBotSectionCard title="Work">
              <GoatBotHomeWork
                environmentId={environmentId}
                threadId={threadId}
                botName={botName}
                rows={rows}
                remoteWork={remoteWork}
                loaded={loaded}
                failed={failed}
                failure={failure}
                supported={supported}
                offline={offline}
                onRetry={refresh}
                history={history}
                peekable={peekRows !== undefined}
                showAll={showAllWork}
                onShowAllChange={setShowAllWork}
                onOpenTask={(row) => {
                  if (peekRows === undefined) return;
                  setRoutineFocus(null);
                  setPeek({ taskId: row.task.taskId, title: row.task.title });
                }}
                focusTaskId={focusTarget === "home" ? null : focusTarget}
                focusRef={focusOnce}
                notice={
                  goatBotTurnsOutsideList(turnsWaiting, rows).length > 0 ? (
                    <p className="px-3 pt-3 text-muted-foreground">
                      {goatBotWaitingInChatText(botName)}.{" "}
                      <Link
                        to="/bot"
                        search={goatBotSearch(member)}
                        onClick={onShowChat}
                        className="underline"
                      >
                        Open the chat
                      </Link>
                    </p>
                  ) : null
                }
              />
            </GoatBotSectionCard>
            <GoatBotSectionCard
              title="Routines"
              action={<GoatBotNewRoutineButton onDraft={onDraft} />}
            >
              <GoatBotRoutines
                environmentId={environmentId}
                threadId={threadId}
                tasks={routines.data?.tasks ?? null}
                error={routines.error}
                failure={routines.failure}
                offline={offline}
                onRetry={routines.refresh}
                onDraft={onDraft}
                focusRoutineId={routineFocus}
                onRoutineFocused={() => setRoutineFocus(null)}
                routineMayFocus={landingMayFocus}
              />
            </GoatBotSectionCard>
            <GoatBotSectionCard title="Machines">
              <GoatBotComputer environmentId={environmentId} botId={member?.botId ?? null} />
            </GoatBotSectionCard>
            <GoatBotSuggested environmentId={environmentId} />
          </div>
        </TabsPanel>
        <TabsPanel value="Library" className="mt-4 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-5 pt-1">
            <GoatBotLibrary environmentId={environmentId} openPath={openFile} onOpen={onOpenFile} />
            <GoatBotSectionCard title="Memory">
              <div className="px-3 py-3">
                <GoatBotMemory
                  environmentId={environmentId}
                  onDraft={onDraft}
                  refreshKey={notesRefreshKey}
                />
              </div>
            </GoatBotSectionCard>
          </div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
