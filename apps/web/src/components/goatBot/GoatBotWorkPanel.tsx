import {
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  groupBotWork,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type {
  BotRemoteWork,
  BotThreadRow,
  ChannelBotArtifact,
  ChannelTaskId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { ArrowLeftIcon } from "~/components/solar";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { GoatBotEditBotButton } from "./GoatBotEditBotButton";
import { GoatBotRoutines } from "./GoatBotRoutines";
import { GoatBotComputer } from "./GoatBotComputer";
import { GoatBotLibrary } from "./GoatBotLibrary";
import { GoatBotMemory } from "./GoatBotMemory";
import { GoatBotPanelEmpty, GoatBotPanelFailure } from "./GoatBotPanelEmpty";
import { GoatBotStatusCard } from "./GoatBotStatusCard";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";
import { GoatBotWorkPeek } from "./GoatBotWorkPeek";
import {
  goatBotSearch,
  memberThreadsKey,
  useGoatBotAvatar,
  useGoatBotMember,
  useGoatBotName,
} from "./goatBotMemberContext";
import { useBotThreads } from "./useBotRoster";
import type { GoatBotRoutineLanding } from "./useGoatBotRoutineLanding";

// Home is one scroll of what the bot runs and does; Library holds what it keeps.
const tabs = ["Home", "Library"] as const;
type Tab = (typeof tabs)[number];

export function GoatBotWorkPanel({
  environmentId,
  threadId,
  onDraft,
  notesRefreshKey,
  onShowChat,
  peekRows,
  onRetryInput,
  openFile = null,
  onOpenFile,
  routineLanding = null,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Set only in a sheet over the chat: Back to chat and links to the chat call it to close it. */
  onShowChat?: (() => void) | undefined;
  /** Puts a message in this chat's composer; absent while the chat cannot send. */
  onDraft?: ((text: string) => void) | undefined;
  notesRefreshKey?: string | undefined;
  /** A task's conversation, for reading it here without leaving the bot's chat. */
  peekRows?: ((taskId: ChannelTaskId) => ReadonlyArray<GoatBotRow>) | undefined;
  onRetryInput?: ((clientKey: string) => void) | undefined;
  /** The Library file open in the chat, if any. */
  openFile?: string | null | undefined;
  /** Opens a Library file in place of the conversation. */
  onOpenFile: (file: ChannelBotArtifact) => void;
  /** A routine chip in the chat: Home shows with that routine's row focused. */
  routineLanding?: GoatBotRoutineLanding | null | undefined;
}) {
  const [tab, setTab] = useState<Tab>("Home");
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
    if (active === null || active === document.body) element.focus();
    setFocusTarget(null);
  };
  // Back also returns Home to where it was scrolled, once per mount; a routine landing scrolls it.
  const homeScroll = useRef(0);
  const homePanel = useRef<HTMLElement | null>(null);
  const restoreHome = (element: HTMLElement | null) => {
    if (element === null || element === homePanel.current) return;
    homePanel.current = element;
    if (routineFocus === null) element.scrollTop = homeScroll.current;
  };
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  const avatar = useGoatBotAvatar();
  const { rows, remoteWork, supported, loaded, failed, turnsWaiting, refresh } = useBotThreads(
    environmentId,
    memberThreadsKey(member),
  );
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
  const work = groupBotWork(rows, [], environmentId);
  const tasks = [...work.inProgress, ...work.done];
  // In the top padding Home and a task view both leave; inside the panel, so a routine landing
  // still sees the sheet's opening focus as the panel's. A full-width sheet docks under the
  // titlebar's sidebar control (z-sheet < z-modal), so there it starts just past that control.
  const backToChat = onShowChat ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={onShowChat}
      className="absolute start-2 top-2.5 max-sm:start-[calc(var(--workspace-controls-left)+2.5rem)]"
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
          environmentId={environmentId}
          onRetry={onRetryInput}
          onBack={() => {
            setFocusTarget(peeked === undefined ? "home" : peek.taskId);
            setPeekHasFocus(false);
            setPeek(null);
          }}
        />
      </div>
    );
  }
  return (
    <div ref={panelRef} className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-4 text-sm">
      {backToChat}
      <header className="flex flex-col items-center gap-2 pt-16 pb-4 text-center">
        <GoatBotAvatar size="lg" emoji={avatar} />
        <h2 className="max-w-full truncate text-base font-semibold">{botName}</h2>
        <GoatBotEditBotButton />
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
          className="mt-5 min-h-0 overflow-y-auto"
          ref={restoreHome}
          onScroll={(event) => {
            homeScroll.current = event.currentTarget.scrollTop;
          }}
        >
          <div className="space-y-6">
            <GoatBotStatusCard
              className="rounded-xl border border-border p-3"
              environmentId={environmentId}
              member={member}
              rows={!supported ? "unavailable" : failed ? "failed" : loaded ? rows : null}
              turnsWaiting={turnsWaiting}
              onShowChat={onShowChat}
              quietWhenReady
            />
            <HomeSection title="Machines">
              <GoatBotComputer environmentId={environmentId} />
            </HomeSection>
            <HomeSection title="Work">
              {goatBotTurnsOutsideList(turnsWaiting, rows).length > 0 ? (
                <p className="mb-3">
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
              ) : null}
              {failed ? (
                <div className="mb-3">
                  <GoatBotPanelFailure
                    message={`Couldn't load ${botName}'s tasks.`}
                    onRetry={refresh}
                  />
                </div>
              ) : null}
              {tasks.length > 0 ? (
                <div className="space-y-3">
                  {([false, true] as const).map((done) =>
                    (done ? work.done : work.inProgress).length === 0 ? null : (
                      <section key={String(done)}>
                        <h4 className="mb-1 px-1 text-xs text-muted-foreground">
                          {done ? "Done" : "In progress"}
                        </h4>
                        {(done ? work.done : work.inProgress).map(({ row }) => (
                          <TaskWorkRow
                            key={row.task.taskId}
                            row={row}
                            rows={rows}
                            remoteWork={remoteWork}
                            environmentId={environmentId}
                            focusRef={row.task.taskId === focusTarget ? focusOnce : undefined}
                            onPeek={
                              peekRows === undefined
                                ? undefined
                                : () => {
                                    setRoutineFocus(null);
                                    setPeek({ taskId: row.task.taskId, title: row.task.title });
                                  }
                            }
                          />
                        ))}
                      </section>
                    ),
                  )}
                </div>
              ) : failed ? null : !supported ? (
                <p className="text-muted-foreground">
                  Tasks can't be listed from this server right now.
                </p>
              ) : !loaded ? (
                <p className="text-muted-foreground">Loading tasks…</p>
              ) : (
                <GoatBotPanelEmpty
                  title="No tasks yet"
                  next={`Ask ${botName} in chat to start work.`}
                />
              )}
            </HomeSection>
            <HomeSection title="Routines">
              <GoatBotRoutines
                environmentId={environmentId}
                threadId={threadId}
                tasks={routines.data?.tasks ?? null}
                error={routines.error}
                onRetry={routines.refresh}
                onDraft={onDraft}
                focusRoutineId={routineFocus}
                onRoutineFocused={() => setRoutineFocus(null)}
                routineMayFocus={landingMayFocus}
              />
            </HomeSection>
          </div>
        </TabsPanel>
        <TabsPanel value="Library" className="mt-5 min-h-0 overflow-y-auto">
          <div className="space-y-6">
            <GoatBotLibrary environmentId={environmentId} openPath={openFile} onOpen={onOpenFile} />
            <HomeSection title="Memory">
              <GoatBotMemory
                environmentId={environmentId}
                onDraft={onDraft}
                refreshKey={notesRefreshKey}
              />
            </HomeSection>
          </div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

function HomeSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function TaskWorkRow({
  row,
  rows,
  remoteWork,
  environmentId,
  onPeek,
  focusRef,
}: {
  row: Extract<BotThreadRow, { kind: "task" }>;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
  environmentId: EnvironmentId;
  /** Opens the task's conversation in this panel; absent where it can only open in full. */
  onPeek?: (() => void) | undefined;
  /** Takes focus when Back returns to this row. */
  focusRef?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const member = useGoatBotMember();
  return (
    <div className="py-1">
      {onPeek === undefined ? (
        <Link
          to="/bot"
          search={{ task: row.task.taskId, ...goatBotSearch(member) }}
          className="block rounded-md p-2 hover:bg-accent"
        >
          {row.task.title}
          <span className="block text-xs text-muted-foreground">
            {presentTaskStatus(row.task.status, row.view.doneAt).label}
          </span>
        </Link>
      ) : (
        <button
          type="button"
          ref={focusRef}
          onClick={onPeek}
          className="block w-full rounded-md p-2 text-start hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {row.task.title}
          <span className="block text-xs text-muted-foreground">
            {presentTaskStatus(row.task.status, row.view.doneAt).label}
          </span>
        </button>
      )}
      <button
        type="button"
        className="px-2 text-xs text-muted-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide work" : "Show work"}
      </button>
      {expanded && (
        <GoatBotWorkDetails
          environmentId={environmentId}
          taskId={row.task.taskId}
          rows={rows}
          remoteWork={remoteWork}
        />
      )}
    </div>
  );
}
