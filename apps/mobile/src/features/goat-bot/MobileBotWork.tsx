import { useAtomValue } from "@effect/atom-react";
import {
  accessDenied,
  botHomeWork,
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  groupBotWork,
  workRowCollapsed,
  type GoatBotAccent,
  type GoatBotTaskCard,
  type GoatBotWaitingTurn,
} from "@goat/client-runtime/goatBot";
import { botRoutineRows } from "@goat/client-runtime/scheduledTasks";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  BotId,
  BotProfile,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { CHANNEL_LIST_CHILD_WORK_MAX_TASKS, ChannelTaskId } from "@goat/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import { MobileBotStatusCard } from "./MobileBotStatusCard";
import { MobileBotComputer } from "./MobileBotComputer";
import { GoatBotFaceAvatar } from "./GoatBotFace";
import { MobileBotLibrary } from "./MobileBotLibrary";
import { MobileBotMemory } from "./MobileBotMemory";
import type { MobileNoteWording, MobileNoteWordings } from "./mobileNoteWordings";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileHomeTaskReads } from "./useMobileAcknowledgeTaskRead";
import { SymbolView } from "../../components/ui/AppSymbol";
import { type MobileBotHomeItem, mobileBotTaskListItems, carded } from "./MobileBotTaskList";
import { MobileBotPeek } from "./MobileBotPeek";
import { mobileBotWorkDetails } from "./mobileBotWorkDetails";
import { useKeptWhileOffline } from "./useKeptWhileOffline";
import { useMobileBotWorkHistory } from "./useMobileBotWorkHistory";
import { useMobileHistoryAnnouncements } from "./useMobileHistoryAnnouncements";
import { useAfterSheetGone } from "./useAfterSheetGone";
import { MobileTaskHeader } from "./MobileTaskHeader";
import { GOAT_BOT_NEW_ROUTINE_DRAFT, MobileBotRoutines } from "./MobileBotRoutines";
import type { MobileBotHomeFocus } from "./useGoatBotEventTargets";

/** How far below the top a scrolled-to row lands, clear of the sticky Home/Library tabs. */
const STICKY_TABS_CLEARANCE = 56;
/** How many times a scroll to an unmeasured entry is tried again as the list lays out more. */
const SCROLL_RETRIES = 3;
const NO_WORDINGS: MobileNoteWordings = new Map();
type HomeScroll = {
  readonly key: string;
  readonly viewPosition: number;
  readonly viewOffset: number;
};
import {
  MOBILE_CHECK_IN_DRAFT,
  type MobileCheckInDraft,
  type MobileCheckInDraftUpdate,
} from "./mobileCheckInDraft";

// Home is one scroll of machines, work and routines; Library holds files and notes.
const tabs = ["Home", "Library"] as const;

export function MobileBotWork(props: {
  readonly taskId?: ChannelTaskId;
  readonly taskCard?: ReactNode;
  /** The bot's face for the header chip Android draws above the chat. */
  readonly chipFace?: ReactNode;
  readonly heroFace?: ReactNode;
  /** The home sheet's open state when the chat's header chip controls it. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly visible: boolean;
  /** The screen is focused and the app active, so what it shows has been seen. */
  readonly seen?: boolean;
  readonly onOpenTask: (id: ChannelTaskId, title?: string) => void;
  /** Only the Home sheet, opened over a task's own screen: no chat chip or header. */
  readonly sheetOnly?: boolean;
  /** The bot's chat is under this sheet; false over a task's own screen. */
  readonly chatBelow?: boolean;
  /** The title the opener carried, for a task the current list does not hold. */
  readonly taskTitle?: string | undefined;
  /** Opens a coding thread the task started. */
  readonly onOpenThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  }) => void;
  /** A member bot's work; the main bot's when absent. */
  readonly member?: {
    readonly botId: BotId;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly name: string;
    readonly defaultModelSelection: BotProfile["defaultModelSelection"];
  } | null;
  /** The bot's own turns asking a question in the chat behind this sheet. */
  readonly turnsWaiting?: ReadonlyArray<GoatBotWaitingTurn>;
  /** What the chat calls this bot. */
  readonly botName?: string;
  /** The bot's profile picture, shown at the top of the sheet. */
  readonly botAvatar?: string | null | undefined;
  /** A member's color for its face. */
  readonly botAccent?: GoatBotAccent | null | undefined;
  /** The main bot, named on a member's inherited model. */
  readonly main?: Pick<BotProfile, "name"> | null;
  /** Puts a message in the chat's composer; absent while the chat cannot send. */
  /** Fills the chat's message box; false when the box already holds a message. */
  readonly onDraft?: ((text: string) => boolean) | undefined;
  /** Opens Edit bot for this member; absent for the main bot or when it cannot be edited. */
  readonly onEditBot?: (() => void) | undefined;
  /** The sheet has finished going away (iOS). */
  readonly onDismissed?: (() => void) | undefined;
  /** Task cards in the conversation; the Tasks tab lists the ones the server no longer does. */
  readonly chatTasks?: ReadonlyArray<GoatBotTaskCard>;
  /** The transcript's card for the task this screen shows, for a task the server no longer lists. */
  readonly taskCardInfo?: GoatBotTaskCard | null;
  /** Changes when the bot answers or a task moves on, which may have changed the notes. */
  readonly notesRefreshKey?: string | undefined;
  /** Changes with every task record in the bot's conversation, including tasks past the list. */
  readonly workRevision?: string | null | undefined;
  /** What the home opens on, from an event line; seq changes on every request. */
  readonly focus?: (MobileBotHomeFocus & { readonly seq: number }) | null | undefined;
}) {
  const home = useMobileGoatBotHomeMode();
  // The sheet reaches the bottom of the screen; its last entry clears the home indicator.
  const bottomInset = useSafeAreaInsets().bottom + 24;
  const selected = pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities = environmentId
    ? presentationById.get(environmentId)?.serverConfig?.environment.capabilities
    : undefined;
  const member = props.member ?? null;
  const enabled =
    selected?.connected === true &&
    capabilities?.goatBotTaskThreads === true &&
    (member === null || capabilities?.goatBotMembers === true);
  const botName = props.botName ?? member?.name ?? "GOAT Bot";
  // A member's model sits beside Work in its chat; the main bot's is the GOAT Bot model setting.
  const threads = useEnvironmentQuery(
    environmentId && enabled && (member === null || capabilities?.goatBotMembers === true)
      ? channelEnvironment.listBotThreads({
          environmentId,
          input: member === null ? {} : { botId: member.botId },
        })
      : null,
  );
  const workScope = JSON.stringify([environmentId, member?.threadId ?? home.botRef?.threadId]);
  const offline = selected?.connected !== true;
  const listData = useKeptWhileOffline(threads.data, workScope, offline);
  const rows = listData?.rows ?? [];
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  // Each opening of the Home sheet starts a new walk through older work, as web's Home does.
  const [sheet, setSheet] = useState({ open, generation: 0 });
  if (sheet.open !== open)
    setSheet({ open, generation: open ? sheet.generation + 1 : sheet.generation });
  // Pages belong to one opening of Home; an accepted read mark to the computer and bot alone.
  const workOwner = JSON.stringify([workScope, member?.botId ?? null]);
  const history = useMobileBotWorkHistory({
    environmentId,
    botId: member?.botId ?? null,
    capabilities,
    current: props.taskId ? null : listData,
    loaded: threads.successResult !== null,
    enabled: enabled && open && !props.taskId,
    scope: JSON.stringify([workOwner, sheet.generation]),
    owner: workOwner,
  });
  useMobileHistoryAnnouncements(open && !props.taskId ? history : null);
  // Home lists older work with the current list; a task's own screen reads the current list only.
  const homeRows = props.taskId ? rows : history.rows;
  const homeRemote = props.taskId ? (listData?.remoteWork ?? []) : history.remoteWork;
  const [olderHome, setOlderHome] = useState<"open" | "closing" | null>(null);
  const afterOlderHome = useAfterSheetGone(props.visible, Platform.OS !== "android", workOwner);
  // The task this sheet peeks at; its child work loads like a task screen's.
  const [peekTaskId, setPeekTaskId] = useState<ChannelTaskId | null>(null);
  const childTaskId = props.taskId ?? peekTaskId;
  const children = useEnvironmentQuery(
    environmentId && enabled && capabilities?.goatBotChildWork === true && childTaskId
      ? channelEnvironment.listChildWork({ environmentId, input: { taskIds: [childTaskId] } })
      : null,
  );
  const routines = useEnvironmentQuery(
    environmentId && selected?.connected && !props.taskId
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const childData = useKeptWhileOffline(children.data, workScope, offline);
  const work = environmentId
    ? groupBotWork(homeRows, childData?.groups ?? [], environmentId, homeRemote)
    : { inProgress: [], done: [] };
  const task = [...work.inProgress, ...work.done].find(
    (entry) => entry.row.task.taskId === props.taskId,
  );
  // What the work list says about each task and thread; the machines follow its changes.
  const workKey = rows
    .map((row) =>
      row.kind === "task"
        ? `${row.task.taskId}:${row.task.status}:${row.lastActivityAt}`
        : `${row.threadId}:${row.state}`,
    )
    .join("|");
  const [tab, setTab] = useState<(typeof tabs)[number]>("Home");
  // An event line opens the home on Home with its task peeked or its routine scrolled to.
  const [focusSeq, setFocusSeq] = useState(0);
  const [routineFocus, setRoutineFocus] = useState<{ id: string; seq: number } | null>(null);
  const [showAllRoutines, setShowAllRoutines] = useState(false);
  // A task the list had not loaded yet when the home opened on it, and one it turned out to lack.
  const [taskFocus, setTaskFocus] = useState<ChannelTaskId | null>(null);
  const [leaveFor, setLeaveFor] = useState<{ id: ChannelTaskId; seq: number } | null>(null);
  const leftFor = useRef(0);
  // The focus whose routine row has reported its place and refined the scroll.
  const routineLanded = useRef(0);
  const listRef = useRef<FlatList<MobileBotHomeItem>>(null);
  // A scroll to an entry the list has not measured lands near it and tries the entry again once
  // the list has laid out more, a few times at most.
  const lastScroll = useRef<HomeScroll | null>(null);
  const scrollRetry = useRef<HomeScroll | null>(null);
  const scrollAttempts = useRef(0);
  const [returnKey, setReturnKey] = useState<string | null>(null);
  if (!open && returnKey !== null) setReturnKey(null);
  const attemptScroll = (scroll: HomeScroll) => {
    const index = homeItems.findIndex((item) => item.key === scroll.key);
    if (index < 0) {
      lastScroll.current = null;
      scrollRetry.current = null;
      return;
    }
    listRef.current?.scrollToIndex({
      index,
      viewPosition: scroll.viewPosition,
      viewOffset: scroll.viewOffset,
    });
  };
  const scrollHome = (scroll: HomeScroll) => {
    lastScroll.current = scroll;
    scrollRetry.current = null;
    scrollAttempts.current = 0;
    attemptScroll(scroll);
  };
  if (open && props.focus && props.focus.seq !== focusSeq) {
    setFocusSeq(props.focus.seq);
    setTab("Home");
    const focusedTask = props.focus.kind === "task" ? ChannelTaskId.make(props.focus.id) : null;
    setPeekTaskId(focusedTask);
    setTaskFocus(focusedTask);
    setReturnKey(null);
    setLeaveFor(null);
    setRoutineFocus(
      props.focus.kind === "routine" ? { id: props.focus.id, seq: props.focus.seq } : null,
    );
  }
  // Once a settled, successful read answers, a focused task is either listed (the peek shows it)
  // or has left the list and opens on its own screen. Until then, a failed or still-refreshing read
  // keeps the person on Home with the focus held, so a later answer still decides it.
  const listedTasks =
    threads.data !== null && threads.error === null && !threads.isPending ? rows : null;
  const missingTask =
    taskFocus !== null &&
    listedTasks !== null &&
    !listedTasks.some((row) => row.kind === "task" && row.task.taskId === taskFocus)
      ? taskFocus
      : null;
  if (taskFocus !== null && missingTask === null && listedTasks !== null) {
    setPeekTaskId(taskFocus);
    setTaskFocus(null);
  }
  if (missingTask !== null) {
    setTaskFocus(null);
    setPeekTaskId(null);
    setLeaveFor({ id: missingTask, seq: focusSeq });
  }
  // A note's new wording outlives the sheet, which closes while the person deals with a message
  // already in the box; it goes on a successful fill or Cancel. Notes belong to the machine.
  const [noteWordings, setNoteWordings] = useState<{
    readonly environmentId: EnvironmentId | null;
    readonly byNote: MobileNoteWordings;
  }>({ environmentId, byNote: new Map() });
  const wordings = noteWordings.environmentId === environmentId ? noteWordings.byNote : NO_WORDINGS;
  const setWording = (note: string, wording: MobileNoteWording | null) =>
    setNoteWordings((current) => {
      const byNote = new Map(current.environmentId === environmentId ? current.byNote : []);
      if (wording === null) byNote.delete(note);
      else byNote.set(note, wording);
      return { environmentId, byNote };
    });
  // The check-in being set up, and its save, live here for this bot on this machine: its
  // virtualized cell can unmount while the person scrolls or a save is still running.
  // A save that finishes after the sheet moved to another bot settles that bot's draft only.
  const checkInScope = JSON.stringify([environmentId, member?.threadId ?? home.botRef?.threadId]);
  const [checkIns, setCheckIns] = useState<Readonly<Record<string, MobileCheckInDraft>>>({});
  const [expandedByScope, setExpandedByScope] = useState<
    Readonly<Record<string, ReadonlyArray<ChannelTaskId>>>
  >({});
  const expanded = expandedByScope[checkInScope] ?? [];
  const expandedChildren = useEnvironmentQuery(
    environmentId &&
      open &&
      enabled &&
      capabilities?.goatBotChildWork === true &&
      expanded.length > 0
      ? channelEnvironment.listChildWork({ environmentId, input: { taskIds: [...expanded] } })
      : null,
  );
  const expandedData = useKeptWhileOffline(expandedChildren.data, workScope, offline);
  const detailWork =
    environmentId && expanded.length > 0
      ? groupBotWork(homeRows, expandedData?.groups ?? [], environmentId, homeRemote)
      : null;
  const toggleExpanded = (id: ChannelTaskId) =>
    setExpandedByScope((current) => {
      const ids = current[checkInScope] ?? [];
      return {
        ...current,
        [checkInScope]: ids.includes(id)
          ? ids.filter((item) => item !== id)
          : [...ids, id].slice(-CHANNEL_LIST_CHILD_WORK_MAX_TASKS),
      };
    });
  const [showAllFinished, setShowAllFinished] = useState(false);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const checkInDraft = checkIns[checkInScope] ?? MOBILE_CHECK_IN_DRAFT;
  const updateCheckIn: MobileCheckInDraftUpdate = (update) =>
    setCheckIns((current) => ({
      ...current,
      [checkInScope]: update(current[checkInScope] ?? MOBILE_CHECK_IN_DRAFT),
    }));
  const peekEntry =
    peekTaskId === null || !enabled
      ? null
      : ([...work.inProgress, ...work.done].find((entry) => entry.row.task.taskId === peekTaskId) ??
        null);
  // A peeked task that left the list is forgotten, so it does not reopen when it returns.
  if (peekTaskId !== null && peekEntry === null && (listedTasks !== null || !enabled))
    setPeekTaskId(null);
  const closeSheet = () => {
    setReturnKey(null);
    setPeekTaskId(null);
    setTaskFocus(null);
    setOpen(false);
  };
  const openTask = props.onOpenTask;
  // oxlint-disable-next-line goat/react-effect-budget -- Navigate to a task screen once the list a focused task waited on arrives without it.
  useEffect(() => {
    if (leaveFor === null || leftFor.current === leaveFor.seq) return;
    leftFor.current = leaveFor.seq;
    setOpen(false);
    openTask(leaveFor.id);
  }, [leaveFor, openTask, setOpen]);
  // The system back (Android's button or gesture) leaves a peek before it leaves the sheet.
  const leavePeek = () => {
    if (
      peekTaskId !== null &&
      !showAllFinished &&
      environmentId &&
      workRowCollapsed(homeRows, environmentId, homeRemote, peekTaskId)
    ) {
      setShowAllFinished(true);
      setReturnKey(JSON.stringify(["task", peekTaskId]));
    }
    setPeekTaskId(null);
    setTaskFocus(null);
  };
  const goBack = () => {
    if (peekTaskId !== null) leavePeek();
    else closeSheet();
  };
  const update = async (input: ChannelUpdateTaskViewInput) => {
    if (!environmentId || !enabled) return;
    const result = await runAtomCommand(appAtomRegistry, channelEnvironment.updateTaskView, {
      environmentId,
      input,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        "Could not update task",
        error instanceof Error ? error.message : "Please try again.",
      );
      return;
    }
    threads.refresh();
  };
  useMobileHomeTaskReads({
    environmentId,
    seen: (props.seen ?? props.visible) && enabled && canUpdate,
    task: task?.row ?? null,
    peek: open ? (peekEntry?.row ?? null) : null,
    scope: workOwner,
    // A mark reaches the walk showing its computer and bot; only a sent one on this Home rereads.
    onAcknowledged: (taskId, through, scope, sent) => {
      if (history.markRead(scope, taskId, through) && sent) threads.refresh();
    },
  });
  const now = useNowMinuteMs();
  const routineThreadId = member?.threadId ?? home.botRef?.threadId ?? null;
  const boundRoutines =
    routineThreadId === null
      ? []
      : botRoutineRows(routines.data?.tasks ?? [], routineThreadId, now);
  if (
    routineFocus &&
    !showAllRoutines &&
    boundRoutines.findIndex((row) => row.id === routineFocus.id) >= 5
  ) {
    setShowAllRoutines(true);
  }
  const sectionLabel = (
    key: string,
    text: string,
    first = false,
    action?: ReactNode,
  ): MobileBotHomeItem => ({
    key,
    render: () => (
      <View className={`${first ? "mt-2" : "mt-5"} flex-row items-center justify-between`}>
        <Text className="text-xs font-medium text-foreground-muted">{text}</Text>
        {action}
      </View>
    ),
  });
  const message = (key: string, node: ReactNode): MobileBotHomeItem => ({
    key,
    render: () => node,
  });
  // Home is one list that mounts only what is near the screen; a bot with many tasks stays light.
  const homeItems: MobileBotHomeItem[] = [
    {
      key: "identity",
      render: () => (
        <View>
          <View className="items-center gap-2 pt-2 pb-4">
            {props.heroFace ?? (
              <GoatBotFaceAvatar
                state="idle"
                size={96}
                emoji={props.botAvatar}
                accent={props.botAccent}
              />
            )}
            <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
              {botName}
            </Text>
          </View>
        </View>
      ),
    },
    {
      key: "tabs",
      // One row that scrolls sideways, so large text does not stack the tabs; it sticks to the top.
      render: () => (
        <View className="bg-screen py-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="grow justify-center gap-1"
          >
            {tabs.map((name) => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: tab === name }}
                onPress={() => setTab(name)}
                className={
                  tab === name
                    ? "min-h-[44px] justify-center rounded-full bg-goat-bot-message px-4"
                    : "min-h-[44px] justify-center px-4"
                }
              >
                <Text className={tab === name ? "text-foreground" : "text-foreground-muted"}>
                  {name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ),
    },
  ];
  if (tab === "Home") {
    homeItems.push({
      key: "status",
      render: () => (
        <MobileBotStatusCard
          environmentId={environmentId}
          member={member}
          botName={botName}
          main={props.main ?? null}
          rows={
            !enabled ? "unavailable" : threads.error ? "failed" : threads.isSuccess ? rows : null
          }
          refreshRows={threads.refresh}
          turnsWaiting={props.turnsWaiting ?? []}
          onOpenChat={props.chatBelow === false ? undefined : () => setOpen(false)}
          onOpenTask={(id) => {
            setOpen(false);
            props.onOpenTask(id);
          }}
          quietWhenReady
        />
      ),
    });
    homeItems.push(sectionLabel("work-label", "Work", true));
    const workStart = homeItems.length;
    if (goatBotTurnsOutsideList(props.turnsWaiting ?? [], rows).length > 0) {
      homeItems.push(
        message(
          "waiting",
          <Pressable
            accessibilityRole={props.chatBelow === false ? undefined : "button"}
            disabled={props.chatBelow === false}
            onPress={closeSheet}
            className="min-h-[44px] justify-center py-2"
          >
            <Text className="text-foreground">
              {goatBotWaitingInChatText(botName)}
              {props.chatBelow === false ? "." : ". Open the chat"}
            </Text>
          </Pressable>,
        ),
      );
    }
    if (enabled && threads.error) {
      homeItems.push(
        message(
          "tasks-error",
          accessDenied(threads.cause) ? (
            <Text className="text-foreground-muted">This device can't read {botName}'s work.</Text>
          ) : (
            <View>
              <Text className="text-danger-foreground">Couldn't load {botName}'s tasks.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={threads.refresh}
                className="min-h-[44px] justify-center"
              >
                <Text className="text-foreground">Try again</Text>
              </Pressable>
            </View>
          ),
        ),
      );
    }
    // Known tasks stay listed through a refresh and a failed one; only a read that succeeded with
    // nothing in it says there are no tasks. Tasks the chat shows are listed from the conversation
    // even before the list loads or when it fails.
    if (!enabled) {
      homeItems.push(
        message(
          "tasks-unavailable",
          <Text className="text-foreground-muted">
            {selected?.connected !== true
              ? `${botName}'s tasks are unavailable while the computer is offline.`
              : "Tasks can't be listed from this server right now."}
          </Text>,
        ),
      );
    }
    if (enabled || (selected?.connected !== true && listData !== null)) {
      const loading = enabled && threads.data === null && !threads.error;
      if (loading)
        homeItems.push(
          message(
            "tasks-loading",
            <View accessible accessibilityLabel="Loading tasks…" className="gap-3 py-3">
              {[0, 1, 2].map((index) => (
                <View key={index} className="h-8 rounded bg-subtle-strong" />
              ))}
            </View>,
          ),
        );
      if (listData !== null || (props.chatTasks ?? []).length > 0) {
        homeItems.push(
          ...mobileBotTaskListItems({
            botName,
            work: environmentId
              ? botHomeWork(homeRows, children.data?.groups ?? [], environmentId, homeRemote)
              : { running: [], waiting: [], finished: [] },
            showAllFinished,
            onToggleFinished: () => setShowAllFinished((value) => !value),
            expanded: new Set(expanded),
            onToggleExpanded: toggleExpanded,
            details: (id) => {
              if (!detailWork) return [];
              const entry = [...detailWork.inProgress, ...detailWork.done].find(
                (item) => item.row.task.taskId === id,
              );
              return entry
                ? mobileBotWorkDetails({
                    entry,
                    rows: homeRows,
                    openable: enabled,
                    supported: enabled && capabilities?.goatBotChildWork === true,
                    error: expandedChildren.error,
                    pending: expandedChildren.isPending,
                    groupChildren:
                      expandedData?.groups.find((group) => group.taskId === id)?.children.length ??
                      null,
                    openThread: (thread) => {
                      closeSheet();
                      props.onOpenThread(thread);
                    },
                  })
                : [];
            },
            // Offline rows stay listed, but nothing can be opened or changed until it reconnects.
            canUpdate: canUpdate && enabled,
            openable: enabled,
            rows: homeRows,
            chatTasks: props.chatTasks ?? [],
            history: props.taskId
              ? undefined
              : {
                  supported: history.supported,
                  currentTaskIds: history.currentTaskIds,
                  launchesTruncated: history.launchesTruncated,
                  hasMore: history.hasMore,
                  loading: history.loading,
                  incomplete: history.incomplete,
                  failed: history.failed,
                  onLoadMore: () => void history.loadMore(),
                },
            onPeekTask: (id) => {
              setReturnKey(null);
              setPeekTaskId(id);
            },
            onOpenTask: (id, title) => {
              closeSheet();
              props.onOpenTask(id, title);
            },
            onOpenThread: (thread) => {
              closeSheet();
              props.onOpenThread(thread);
            },
            onUpdate: (input) => void update(input),
            failed: threads.error !== null && threads.error !== undefined,
          }),
        );
      }
    }
    homeItems.splice(
      workStart,
      homeItems.length - workStart,
      ...carded(homeItems.slice(workStart)),
    );
    // The routines entry follows its section label, at the next two places in the list.
    const routinesItem: MobileBotHomeItem = {
      key: "routines",
      render: () => (
        <MobileBotRoutines
          environmentId={environmentId}
          connected={selected?.connected === true}
          // The bot this home shows: a member's own conversation, not the main bot's.
          botThreadId={routineThreadId}
          botName={botName}
          tasks={routines.data?.tasks ?? null}
          error={Boolean(routines.error)}
          onRetry={routines.refresh}
          rows={boundRoutines}
          showAll={showAllRoutines}
          onShowAllChange={setShowAllRoutines}
          focusRoutineId={routineFocus?.id ?? null}
          onFocusedRowLayout={(y) => {
            if (routineFocus !== null) routineLanded.current = routineFocus.seq;
            setRoutineFocus(null);
            scrollHome({
              key: "routines",
              viewPosition: 0,
              viewOffset: STICKY_TABS_CLEARANCE - y,
            });
          }}
          onNewRoutine={
            props.onDraft
              ? () => {
                  if (props.onDraft?.(GOAT_BOT_NEW_ROUTINE_DRAFT)) closeSheet();
                }
              : undefined
          }
          checkInDraft={checkInDraft}
          onCheckInDraftChange={updateCheckIn}
        />
      ),
    };
    homeItems.push(
      sectionLabel(
        "routines-label",
        "Routines",
        false,
        props.onDraft ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (props.onDraft?.(GOAT_BOT_NEW_ROUTINE_DRAFT)) closeSheet();
            }}
            className="min-h-[44px] justify-center"
          >
            <Text className="text-foreground underline">New routine</Text>
          </Pressable>
        ) : null,
      ),
      ...carded([routinesItem]),
    );
    homeItems.push(
      sectionLabel("machines-label", "Machines"),
      ...carded([
        {
          key: "machines",
          render: () => (
            <MobileBotComputer
              environmentId={environmentId}
              connected={selected?.connected === true}
              botId={member?.botId ?? null}
              botName={botName}
              workKey={`${workKey}#${props.workRevision ?? ""}`}
            />
          ),
        },
      ]),
    );
  } else {
    homeItems.push(
      {
        key: "library",
        card: "only",
        render: () => (
          <MobileBotLibrary
            environmentId={environmentId}
            connected={selected?.connected === true}
            botName={botName}
            supported={capabilities?.goatBotLibrary === true}
          />
        ),
      },
      sectionLabel("notes-label", "Memory"),
      {
        key: "notes",
        card: "only",
        render: () => (
          <MobileBotMemory
            environmentId={environmentId}
            connected={selected?.connected === true}
            supported={capabilities?.goatBotNotes === true}
            member={member !== null}
            botName={botName}
            onDraft={
              props.onDraft
                ? (text) => {
                    const taken = props.onDraft?.(text) === true;
                    if (taken) closeSheet();
                    return taken;
                  }
                : undefined
            }
            refreshKey={props.notesRefreshKey}
            wordings={wordings}
            onWordingChange={setWording}
          />
        ),
      },
    );
  }
  const routinesIndex = homeItems.findIndex((item) => item.key === "routines");
  // oxlint-disable-next-line goat/react-effect-budget -- Discard retries when a parent closes the sheet.
  useEffect(() => {
    if (open) return;
    lastScroll.current = null;
    scrollRetry.current = null;
  }, [open, lastScroll, scrollRetry]);
  // oxlint-disable-next-line goat/react-effect-budget -- Return to a newly revealed task after the list has mounted it.
  useEffect(() => {
    if (returnKey === null || !open) return;
    scrollHome({ key: returnKey, viewPosition: 0, viewOffset: STICKY_TABS_CLEARANCE });
    // oxlint-disable-next-line react/set-state-in-effect -- Consume this one-shot scroll after the list has mounted the revealed row.
    setReturnKey(null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The request, not list rebuilds, initiates this scroll.
  }, [returnKey, open]);
  // oxlint-disable-next-line goat/react-effect-budget -- Bring the routines entry into the virtualized list so a focused routine's row mounts and can refine the scroll.
  useEffect(() => {
    if (routineFocus === null || routinesIndex < 0) return;
    if (routineLanded.current === routineFocus.seq) return;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The focus and target index drive the landing, not list rebuilds.
    scrollHome({ key: "routines", viewPosition: 0, viewOffset: STICKY_TABS_CLEARANCE });
  }, [
    routineFocus,
    routinesIndex,
    listRef,
    routineLanded,
    lastScroll,
    scrollRetry,
    scrollAttempts,
  ]);
  return (
    <>
      {props.taskId ? (
        <MobileTaskHeader
          task={task}
          title={props.taskTitle ?? props.taskCardInfo?.title ?? null}
          botName={botName}
          environmentId={environmentId ?? null}
          enabled={enabled}
          canRetry={capabilities?.goatBotTaskRetry === true}
          older={!task && listData !== null && (offline || threads.successResult !== null)}
          loading={threads.data === null}
          failed={threads.error !== null}
          childError={children.error !== null}
          onRetryRead={threads.refresh}
          onUpdate={(input) => void update(input)}
          onRetried={threads.refresh}
          onOpenThread={props.onOpenThread}
          onOpenHome={() => setOlderHome("open")}
          taskCard={props.taskCard}
          card={props.taskCardInfo ?? null}
        />
      ) : props.sheetOnly ? null : Platform.OS === "android" ? (
        // Android hides the native header, so the chip that opens the home sits above the chat.
        <View className="flex-row items-center px-4">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={botName}
            accessibilityHint={`Opens ${botName}'s home`}
            onPress={() => setOpen(true)}
            className="min-h-[44px] justify-center"
          >
            <View className="flex-row items-center gap-1.5 rounded-full bg-goat-bot-message py-1 pl-1 pr-3">
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {props.chipFace}
              </View>
              <Text className="font-semibold text-foreground">{botName}</Text>
              <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
            </View>
          </Pressable>
        </View>
      ) : null}
      {/* Open Home on an older task's screen opens this bot's Home right here, as one more sheet. */}
      {olderHome ? (
        <MobileBotWork
          {...props}
          taskId={undefined}
          taskCard={undefined}
          sheetOnly
          chatBelow={false}
          onDraft={undefined}
          onEditBot={undefined}
          focus={null}
          open={olderHome === "open"}
          // iOS reports the sheet's dismissal before it goes; Android reports none.
          onOpenChange={(next) => {
            if (!next) setOlderHome(Platform.OS === "android" ? null : "closing");
          }}
          onDismissed={() => {
            setOlderHome(null);
            afterOlderHome.gone();
          }}
          onOpenTask={(id, title) => {
            if (id !== props.taskId) afterOlderHome.hold(() => props.onOpenTask(id, title));
          }}
          onOpenThread={(thread) => afterOlderHome.hold(() => props.onOpenThread(thread))}
        />
      ) : null}
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        allowSwipeDismissal
        onDismiss={props.onDismissed}
        // iOS calls this when the sheet is swiped away; Android when back leaves a peek first.
        onRequestClose={Platform.OS === "android" ? goBack : closeSheet}
      >
        <View className="flex-1 bg-screen px-4 pt-4">
          <View className="flex-row items-center justify-between">
            <Pressable
              accessibilityRole="button"
              onPress={closeSheet}
              className="min-h-[44px] self-start justify-center px-2"
            >
              <Text className="text-foreground">Close</Text>
            </Pressable>
            {props.onEditBot ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit bot"
                onPress={props.onEditBot}
                className="min-h-[44px] min-w-[44px] items-center justify-center"
              >
                <SymbolView name="pencil" size={18} tintColorClassName="accent-icon-muted" />
              </Pressable>
            ) : null}
          </View>
          {/* The status card scrolls away and the tab row sticks, so large text still leaves
              room for the list. */}
          {/* The keyboard insets the list, so a note's wording field and its buttons can scroll
              above it, and a tap on a button lands while the keyboard is up. */}
          {/* A peek covers Home without unmounting it, so Back returns to the same place. */}
          <FlatList
            ref={listRef}
            testID="goat-bot-home-scroll"
            data={homeItems}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) =>
              item.card ? (
                <View
                  className={`min-h-[44px] justify-center border-border bg-grouped-card px-3 ${item.card === "first" || item.card === "only" ? "rounded-t-2xl" : ""} ${item.card === "last" || item.card === "only" ? "rounded-b-2xl" : ""}`}
                  style={{
                    borderLeftWidth: StyleSheet.hairlineWidth,
                    borderRightWidth: StyleSheet.hairlineWidth,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderBottomWidth:
                      item.card === "last" || item.card === "only" ? StyleSheet.hairlineWidth : 0,
                  }}
                >
                  {item.render()}
                </View>
              ) : (
                <>{item.render()}</>
              )
            }
            // A routine row far down Home may not be measured yet: land near it, then try again.
            onScrollToIndexFailed={(info) => {
              const scroll = lastScroll.current;
              const current =
                scroll !== null &&
                homeItems.findIndex((item) => item.key === scroll.key) === info.index;
              const retry = current && scrollAttempts.current < SCROLL_RETRIES;
              if (retry) scrollAttempts.current += 1;
              scrollRetry.current = retry ? scroll : null;
              if (current)
                listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index });
            }}
            onContentSizeChange={() => {
              const retry = scrollRetry.current;
              if (retry === null) return;
              scrollRetry.current = null;
              attemptScroll(retry);
            }}
            stickyHeaderIndices={[1]}
            contentContainerStyle={{ paddingBottom: bottomInset }}
            initialNumToRender={12}
            windowSize={7}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            pointerEvents={peekEntry ? "none" : "auto"}
            accessibilityElementsHidden={peekEntry !== null}
            importantForAccessibility={peekEntry ? "no-hide-descendants" : "auto"}
          />
          {peekEntry ? (
            <View className="absolute inset-0 bg-screen px-4 pt-14">
              <MobileBotPeek
                key={peekEntry.row.task.taskId}
                entry={peekEntry}
                rows={homeRows}
                connected={selected?.connected === true}
                machineLabel={selected?.label ?? botName}
                onBack={leavePeek}
                onOpenThread={(thread) => {
                  closeSheet();
                  props.onOpenThread(thread);
                }}
                onOpenTask={(id) => {
                  closeSheet();
                  props.onOpenTask(id, peekEntry.row.task.title);
                }}
              />
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}
