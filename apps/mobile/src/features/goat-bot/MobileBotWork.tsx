import { useAtomValue } from "@effect/atom-react";
import {
  goatBotName,
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  groupBotWork,
  isRetryableTaskStatus,
  presentTaskStatus,
  retryRefusalText,
  taskAttemptLabel,
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
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { MobileBotStatusCard } from "./MobileBotStatusCard";
import { MobileBotComputer } from "./MobileBotComputer";
import { GoatBotFaceAvatar } from "./GoatBotFace";
import { MobileBotLibrary } from "./MobileBotLibrary";
import { MobileBotMemory } from "./MobileBotMemory";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { GoatBotMemberModelAndroidMenu } from "./GoatBotMemberModelAndroidMenu";
import {
  goatBotMemberModelHeaderItem,
  goatBotMemberModelHeaderKey,
} from "./goatBotMemberModelHeader";
import { useMobileGoatBotMemberModelMenu } from "./useMobileGoatBotMemberModel";
import { MobileBotTaskList } from "./MobileBotTaskList";
import { MobileBotPeek } from "./MobileBotPeek";
import { MobileBotRemoteWork } from "./MobileBotRemoteWork";
import { MobileBotRoutines } from "./MobileBotRoutines";

// Home is one scroll of machines, work and routines; Library holds files and notes.
const tabs = ["Home", "Library"] as const;

export function MobileBotWork(props: {
  readonly taskId?: ChannelTaskId;
  readonly taskCard?: ReactNode;
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
}) {
  const home = useMobileGoatBotHomeMode();
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
  const memberModel = useMobileGoatBotMemberModelMenu(member, goatBotName(props.main ?? null));
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Home");
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
      ) : Platform.OS === "ios" ? (
        // The chat's header carries Work on its trailing side, like the web header's button.
        <NativeStackScreenOptions
          optionsVersion={`${botName}:${goatBotMemberModelHeaderKey(memberModel)}`}
          options={{
            unstable_headerRightItems: () => [
              withNativeGlassHeaderItem({
                accessibilityLabel: `Open ${botName} work`,
                identifier: "goat-bot-work",
                label: "Work",
                onPress: () => setOpen(true),
                type: "button" as const,
              }),
              ...(memberModel ? [goatBotMemberModelHeaderItem(memberModel)] : []),
            ],
          }}
        />
      ) : (
        <View className="flex-row items-center justify-end">
          {memberModel ? <GoatBotMemberModelAndroidMenu menu={memberModel} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${botName} work`}
            onPress={() => setOpen(true)}
            className="min-h-[44px] justify-center px-4 py-2"
          >
            <Text className="text-foreground">Work</Text>
          </Pressable>
        </View>
      )}
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={goBack}
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
          <ScrollView
            testID="goat-bot-home-scroll"
            stickyHeaderIndices={[1]}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            pointerEvents={peekEntry ? "none" : "auto"}
            accessibilityElementsHidden={peekEntry !== null}
            importantForAccessibility={peekEntry ? "no-hide-descendants" : "auto"}
          >
            <View>
              <View className="items-center gap-2 pt-2 pb-4">
                <GoatBotFaceAvatar state="idle" size={56} emoji={props.botAvatar} />
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
                  !enabled
                    ? "unavailable"
                    : threads.error
                      ? "failed"
                      : threads.isSuccess
                        ? rows
                        : null
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
            {/* One row that scrolls sideways, so large text does not stack the tabs. */}
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
            <View className="gap-2">
              {tab === "Home" ? (
                <>
                  <Text className="mt-2 text-xs font-medium text-foreground-muted">Machines</Text>
                  <MobileBotComputer
                    environmentId={environmentId}
                    connected={selected?.connected === true}
                    botId={member?.botId ?? null}
                    botName={botName}
                    workKey={workKey}
                  />
                  <Text className="mt-4 text-xs font-medium text-foreground-muted">Work</Text>
                  {goatBotTurnsOutsideList(props.turnsWaiting ?? [], rows).length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={closeSheet}
                      className="min-h-[44px] justify-center"
                    >
                      <Text className="text-foreground">
                        {goatBotWaitingInChatText(botName)}. Open the chat
                      </Text>
                    </Pressable>
                  ) : null}
                  {enabled && threads.error ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={threads.refresh}
                      className="min-h-[44px] justify-center"
                    >
                      <Text className="text-danger-foreground">Couldn't load tasks. Try again</Text>
                    </Pressable>
                  ) : null}
                  {/* Known tasks stay listed through a refresh and a failed one; only a read that
                      succeeded with nothing in it says there are no tasks. */}
                  {!enabled ? (
                    <Text className="text-foreground-muted">
                      Tasks are unavailable while {botName} is offline or unsupported.
                    </Text>
                  ) : threads.data === null && (props.chatTasks ?? []).length === 0 ? (
                    threads.error ? null : (
                      <Text className="text-foreground-muted">Loading tasks…</Text>
                    )
                  ) : (
                    <>
                      {/* Tasks the chat shows are listed from the conversation even before the
                          list loads or when it fails. */}
                      {threads.data === null && !threads.error ? (
                        <Text className="text-foreground-muted">Loading tasks…</Text>
                      ) : null}
                      <MobileBotTaskList
                        botName={botName}
                        work={work}
                        rows={rows}
                        chatTasks={props.chatTasks ?? []}
                        onPeekTask={setPeekTaskId}
                        onOpenTask={(id) => {
                          closeSheet();
                          props.onOpenTask(id);
                        }}
                        onOpenThread={(thread) => {
                          closeSheet();
                          props.onOpenThread(thread);
                        }}
                        onUpdate={(input) => void update(input)}
                        failed={threads.error !== null && threads.error !== undefined}
                      />
                    </>
                  )}
                  <Text className="mt-4 text-xs font-medium text-foreground-muted">Routines</Text>
                  <MobileBotRoutines
                    environmentId={environmentId}
                    connected={selected?.connected === true}
                    botThreadId={home.botRef?.threadId ?? null}
                    botName={botName}
                    tasks={routines.data?.tasks ?? null}
                    error={Boolean(routines.error)}
                    onRetry={routines.refresh}
                    rows={boundRoutines}
                  />
                </>
              ) : (
                <>
                  <MobileBotLibrary
                    environmentId={environmentId}
                    connected={selected?.connected === true}
                    botName={botName}
                    supported={capabilities?.goatBotLibrary === true}
                  />
                  <Text className="mt-4 text-xs font-medium text-foreground-muted">Notes</Text>
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
                </>
              )}
            </View>
          </ScrollView>
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
