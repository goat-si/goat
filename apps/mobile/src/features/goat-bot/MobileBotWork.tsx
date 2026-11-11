import { useAtomValue } from "@effect/atom-react";
import {
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  groupBotWork,
  isRetryableTaskStatus,
  presentTaskStatus,
  retryRefusalText,
  taskAttemptLabel,
  type GoatBotAccent,
  type GoatBotTaskCard,
  type GoatBotWaitingTurn,
} from "@goat/client-runtime/goatBot";
import { botRoutineRows } from "@goat/client-runtime/scheduledTasks";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type {
  BotId,
  BotProfile,
  ChannelTaskId,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Alert, FlatList, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
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
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { SymbolView } from "../../components/ui/AppSymbol";
import { type MobileBotHomeItem, mobileBotTaskListItems } from "./MobileBotTaskList";
import { MobileBotPeek } from "./MobileBotPeek";
import { MobileBotRemoteWork } from "./MobileBotRemoteWork";
import { MobileBotRoutines } from "./MobileBotRoutines";
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
  /** The home sheet's open state when the chat's header chip controls it. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly visible: boolean;
  readonly onOpenTask: (id: ChannelTaskId) => void;
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
  readonly onDraft?: ((text: string) => void) | undefined;
  /** Task cards in the conversation; the Tasks tab lists the ones the server no longer does. */
  readonly chatTasks?: ReadonlyArray<GoatBotTaskCard>;
  /** The transcript's card for the task this screen shows, for a task the server no longer lists. */
  readonly taskCardInfo?: Pick<GoatBotTaskCard, "title" | "statusLabel"> | null;
  /** Changes when the bot answers or a task moves on, which may have changed the notes. */
  readonly notesRefreshKey?: string | undefined;
  /** Changes with every task record in the bot's conversation, including tasks past the list. */
  readonly workRevision?: string | null | undefined;
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
  const enabled = selected?.connected === true && capabilities?.goatBotTaskThreads === true;
  const member = props.member ?? null;
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
  const rows = threads.data?.rows ?? [];
  // The task this sheet peeks at; its child work loads like a task screen's.
  const [peekTaskId, setPeekTaskId] = useState<ChannelTaskId | null>(null);
  const childTaskId = props.taskId ?? peekTaskId;
  const children = useEnvironmentQuery(
    environmentId && enabled && childTaskId
      ? channelEnvironment.listChildWork({ environmentId, input: { taskIds: [childTaskId] } })
      : null,
  );
  const routines = useEnvironmentQuery(
    environmentId && selected?.connected && !props.taskId
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const work = environmentId
    ? groupBotWork(rows, children.data?.groups ?? [], environmentId, threads.data?.remoteWork)
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
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  const [tab, setTab] = useState<(typeof tabs)[number]>("Home");
  // The check-in being set up, and its save, live here for this bot on this machine: its
  // virtualized cell can unmount while the person scrolls or a save is still running.
  // A save that finishes after the sheet moved to another bot settles that bot's draft only.
  const checkInScope = JSON.stringify([environmentId, member?.threadId ?? home.botRef?.threadId]);
  const [checkIns, setCheckIns] = useState<Readonly<Record<string, MobileCheckInDraft>>>({});
  const checkInDraft = checkIns[checkInScope] ?? MOBILE_CHECK_IN_DRAFT;
  const updateCheckIn: MobileCheckInDraftUpdate = (update) =>
    setCheckIns((current) => ({
      ...current,
      [checkInScope]: update(current[checkInScope] ?? MOBILE_CHECK_IN_DRAFT),
    }));
  const peekEntry =
    peekTaskId === null
      ? null
      : ([...work.inProgress, ...work.done].find((entry) => entry.row.task.taskId === peekTaskId) ??
        null);
  // A peeked task that left the list is forgotten, so it does not reopen when it returns.
  if (peekTaskId !== null && peekEntry === null && threads.data !== null) setPeekTaskId(null);
  const closeSheet = () => {
    setPeekTaskId(null);
    setOpen(false);
  };
  // The system back (Android's button or gesture) leaves a peek before it leaves the sheet.
  const goBack = () => {
    if (peekTaskId !== null) setPeekTaskId(null);
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
  const unreadAt = task?.row.unread ? task.row.lastActivityAt : null;
  const refreshThreads = threads.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Mark the visible task read through its latest activity.
  useEffect(() => {
    if (props.visible && props.taskId && unreadAt && environmentId && enabled) {
      void runAtomCommand(appAtomRegistry, channelEnvironment.updateTaskView, {
        environmentId,
        input: { taskId: props.taskId, readThrough: unreadAt },
      }).then((result) => {
        if (result._tag === "Success") refreshThreads();
        else Alert.alert("Could not mark task read", "Please try again.");
      });
    }
  }, [props.visible, props.taskId, unreadAt, environmentId, enabled, refreshThreads]);
  const now = useNowMinuteMs();
  const routineThreadId = member?.threadId ?? home.botRef?.threadId ?? null;
  const boundRoutines =
    routineThreadId === null
      ? []
      : botRoutineRows(routines.data?.tasks ?? [], routineThreadId, now);
  const sectionLabel = (key: string, text: string, first = false): MobileBotHomeItem => ({
    key,
    render: () => (
      <Text className={`${first ? "mt-2" : "mt-4"} text-xs font-medium text-foreground-muted`}>
        {text}
      </Text>
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
            <GoatBotFaceAvatar
              state="idle"
              size={56}
              emoji={props.botAvatar}
              accent={props.botAccent}
            />
            <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
              {botName}
            </Text>
          </View>
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
            onOpenChat={() => setOpen(false)}
            onOpenTask={(id) => {
              setOpen(false);
              props.onOpenTask(id);
            }}
          />
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
    homeItems.push(sectionLabel("machines-label", "Machines", true), {
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
    });
    homeItems.push(sectionLabel("work-label", "Work"));
    if (goatBotTurnsOutsideList(props.turnsWaiting ?? [], rows).length > 0) {
      homeItems.push(
        message(
          "waiting",
          <Pressable
            accessibilityRole="button"
            onPress={closeSheet}
            className="min-h-[44px] justify-center"
          >
            <Text className="text-foreground">
              {goatBotWaitingInChatText(botName)}. Open the chat
            </Text>
          </Pressable>,
        ),
      );
    }
    if (enabled && threads.error) {
      homeItems.push(
        message(
          "tasks-error",
          <Pressable
            accessibilityRole="button"
            onPress={threads.refresh}
            className="min-h-[44px] justify-center"
          >
            <Text className="text-danger-foreground">Couldn't load tasks. Try again</Text>
          </Pressable>,
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
            Tasks are unavailable while {botName} is offline or unsupported.
          </Text>,
        ),
      );
    } else {
      const loading = threads.data === null && !threads.error;
      if (loading)
        homeItems.push(
          message("tasks-loading", <Text className="text-foreground-muted">Loading tasks…</Text>),
        );
      if (threads.data !== null || (props.chatTasks ?? []).length > 0) {
        homeItems.push(
          ...mobileBotTaskListItems({
            botName,
            work,
            rows,
            chatTasks: props.chatTasks ?? [],
            onPeekTask: setPeekTaskId,
            onOpenTask: (id) => {
              closeSheet();
              props.onOpenTask(id);
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
    homeItems.push(sectionLabel("routines-label", "Routines"), {
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
          checkInDraft={checkInDraft}
          onCheckInDraftChange={updateCheckIn}
        />
      ),
    });
  } else {
    homeItems.push(
      {
        key: "library",
        render: () => (
          <MobileBotLibrary
            environmentId={environmentId}
            connected={selected?.connected === true}
            botName={botName}
            supported={capabilities?.goatBotLibrary === true}
          />
        ),
      },
      sectionLabel("notes-label", "Notes"),
      {
        key: "notes",
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
                    closeSheet();
                    props.onDraft?.(text);
                  }
                : undefined
            }
            refreshKey={props.notesRefreshKey}
          />
        ),
      },
    );
  }
  return (
    <>
      {props.taskId ? (
        <View className="gap-2 border-b border-border px-4 py-3">
          <Text className="font-semibold text-foreground">
            {task?.row.task.title ?? props.taskCardInfo?.title ?? "Task thread"}
          </Text>
          <Text className="text-foreground-muted">
            {task
              ? presentTaskStatus(task.row.task.status, task.row.view.doneAt).label
              : (props.taskCardInfo?.statusLabel ?? null)}
            {task && taskAttemptLabel(task.row.task.generation)
              ? ` · ${taskAttemptLabel(task.row.task.generation)}`
              : null}
          </Text>
          {!enabled ? (
            <Text className="text-foreground-muted">
              Task is unavailable while {botName} is offline or unsupported.
            </Text>
          ) : threads.error ? (
            <Pressable
              accessibilityRole="button"
              onPress={threads.refresh}
              className="min-h-[44px] justify-center"
            >
              <Text className="text-danger-foreground">Couldn't load task. Try again</Text>
            </Pressable>
          ) : threads.data === null ? (
            <Text className="text-foreground-muted">Loading task…</Text>
          ) : !task && !props.taskCardInfo ? (
            <Text className="text-foreground-muted">Task not found.</Text>
          ) : null}
          {task ? (
            <View className="flex-row flex-wrap gap-3">
              {environmentId &&
              capabilities?.goatBotTaskRetry === true &&
              isRetryableTaskStatus(task.row.task.status) ? (
                <MobileTaskRetry
                  environmentId={environmentId}
                  taskId={task.row.task.taskId}
                  onStarted={threads.refresh}
                />
              ) : null}
              <Pressable
                accessibilityRole="button"
                className="min-h-[44px] justify-center"
                onPress={() =>
                  void update({ taskId: task.row.task.taskId, pinned: !task.row.view.pinnedAt })
                }
              >
                <Text className="text-foreground">{task.row.view.pinnedAt ? "Unpin" : "Pin"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                className="min-h-[44px] justify-center"
                onPress={() =>
                  void update({ taskId: task.row.task.taskId, done: !task.row.view.doneAt })
                }
              >
                <Text className="text-foreground">
                  {task.row.view.doneAt ? "Reopen" : "Mark done"}
                </Text>
              </Pressable>
              {task.threads.map((thread) => (
                <Pressable
                  key={`${thread.environmentId}:${thread.threadId}`}
                  accessibilityRole="button"
                  className="min-h-[44px] justify-center"
                  onPress={() =>
                    props.onOpenThread({ environmentId: thread.environmentId, id: thread.threadId })
                  }
                >
                  <Text className="text-foreground underline">Open work thread</Text>
                </Pressable>
              ))}
              {task.remote.map((item) => (
                <MobileBotRemoteWork
                  key={item.childWorkId}
                  item={item}
                  onOpenThread={props.onOpenThread}
                />
              ))}
              {task.subagents.map((agent) => (
                <Text key={agent.childWorkId} className="text-foreground-muted">
                  {agent.host ?? agent.destinationHint ?? "Subagent"} · {agent.label}
                </Text>
              ))}
              {children.error ? (
                <Text className="text-danger-foreground">Couldn't load subagents.</Text>
              ) : null}
            </View>
          ) : null}
          {props.taskCard}
        </View>
      ) : Platform.OS === "android" ? (
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
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        allowSwipeDismissal
        // iOS calls this when the sheet is swiped away; Android when back leaves a peek first.
        onRequestClose={Platform.OS === "android" ? goBack : closeSheet}
      >
        <View className="flex-1 bg-screen px-4 pt-4">
          <Pressable
            accessibilityRole="button"
            onPress={closeSheet}
            className="min-h-[44px] self-start justify-center px-2"
          >
            <Text className="text-foreground">Close</Text>
          </Pressable>
          {/* The status card scrolls away and the tab row sticks, so large text still leaves
              room for the list. */}
          {/* The keyboard insets the list, so a note's wording field and its buttons can scroll
              above it, and a tap on a button lands while the keyboard is up. */}
          {/* A peek covers Home without unmounting it, so Back returns to the same place. */}
          <FlatList
            testID="goat-bot-home-scroll"
            data={homeItems}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => <>{item.render()}</>}
            stickyHeaderIndices={[1]}
            contentContainerClassName="gap-2"
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
                rows={rows}
                connected={selected?.connected === true}
                machineLabel={selected?.label ?? botName}
                onBack={() => setPeekTaskId(null)}
                onOpenThread={(thread) => {
                  closeSheet();
                  props.onOpenThread(thread);
                }}
                onOpenTask={(id) => {
                  closeSheet();
                  props.onOpenTask(id);
                }}
              />
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

function MobileTaskRetry(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  readonly onStarted: () => void;
}) {
  const canRetry = useAtomValue(channelEnvironment.retryTask.permissionAtom(props.environmentId));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!canRetry) return null;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      channelEnvironment.retryTask,
      {
        environmentId: props.environmentId,
        input: { taskId: props.taskId, clientRequestId: uuidv4() },
      },
      { label: "GOAT Bot task retry", reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.status === "refused") setProblem(retryRefusalText(result.value.reason));
      else props.onStarted();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setProblem(`Couldn't retry: ${failure instanceof Error ? failure.message : String(failure)}`);
  };
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => void run()}
        className="min-h-[44px] justify-center"
      >
        <Text className="text-foreground">Retry</Text>
      </Pressable>
      {problem !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}
