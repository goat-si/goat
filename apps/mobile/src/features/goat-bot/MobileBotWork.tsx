import { useAtomValue } from "@effect/atom-react";
import {
  goatBotName,
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  groupBotWork,
  isRetryableTaskStatus,
  presentTaskStatus,
  resolveRemoteBotWork,
  retryRefusalText,
  taskAttemptLabel,
  type GoatBotWaitingTurn,
} from "@goat/client-runtime/goatBot";
import { botRoutineRows, type BotRoutineRow } from "@goat/client-runtime/scheduledTasks";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type {
  BotId,
  BotProfile,
  BotRemoteWork,
  ChannelTaskId,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
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
import { MobileBotCheckInForm } from "./MobileBotCheckInForm";
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
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

// The machines running work show under Tasks, so four short labels fit one row as text.
const tabs = ["Tasks", "Routines", "Memory", "Library"] as const;

const NOT_OPENABLE = Atom.make(false).pipe(Atom.withLabel("mobile-goat-bot-remote-work:none"));

/** A thread the bot launched on another machine: openable while this phone is connected there. */
function MobileBotRemoteWork(props: {
  readonly item: BotRemoteWork;
  readonly onOpenThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  }) => void;
}) {
  const { item } = props;
  const openable = useAtomValue(
    item.environmentId === undefined
      ? NOT_OPENABLE
      : channelEnvironment.remoteWorkOpenable(item.environmentId),
  );
  const target = resolveRemoteBotWork(
    item,
    (environmentId) => environmentId === item.environmentId && openable,
  );
  if (target.kind === "unavailable")
    return <Text className="text-foreground-muted">{target.host} · Unavailable</Text>;
  const { ref } = target;
  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-[44px] justify-center"
      onPress={() => props.onOpenThread({ environmentId: ref.environmentId, id: ref.threadId })}
    >
      <Text className="text-foreground underline">Open work thread on {target.host}</Text>
    </Pressable>
  );
}

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
  const children = useEnvironmentQuery(
    environmentId && enabled && props.taskId
      ? channelEnvironment.listChildWork({ environmentId, input: { taskIds: [props.taskId] } })
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Tasks");
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
            {task?.row.task.title ?? "Task thread"}
          </Text>
          <Text className="text-foreground-muted">
            {task ? presentTaskStatus(task.row.task.status, task.row.view.doneAt).label : null}
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
          ) : !task ? (
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
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-screen px-4 pt-4">
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            className="min-h-[44px] self-start justify-center px-2"
          >
            <Text className="text-foreground">Close</Text>
          </Pressable>
          {/* The status card scrolls away and the tab row sticks, so large text still leaves
              room for the list. */}
          {/* The keyboard insets the list, so a note's wording field and its buttons can scroll
              above it, and a tap on a button lands while the keyboard is up. */}
          <ScrollView
            stickyHeaderIndices={[1]}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
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
            <View>
              {tab === "Tasks" &&
              goatBotTurnsOutsideList(props.turnsWaiting ?? [], rows).length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setOpen(false)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-foreground">
                    {goatBotWaitingInChatText(botName)}. Open the chat
                  </Text>
                </Pressable>
              ) : null}
              {tab === "Tasks" && enabled && threads.error ? (
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
              {tab === "Tasks" ? (
                !enabled ? (
                  <Text className="text-foreground-muted">
                    Tasks are unavailable while {botName} is offline or unsupported.
                  </Text>
                ) : threads.data === null ? (
                  threads.error ? null : (
                    <Text className="text-foreground-muted">Loading tasks…</Text>
                  )
                ) : work.inProgress.length + work.done.length === 0 ? (
                  threads.error ? null : (
                    <MobileBotPanelEmpty
                      title="No tasks yet"
                      next={`Ask ${botName} in chat to start work.`}
                    />
                  )
                ) : (
                  (
                    [
                      ["In progress", work.inProgress],
                      ["Done", work.done],
                    ] as const
                  ).map(([label, tasks]) => (
                    <View key={label} className="gap-2 py-2">
                      <Text className="font-semibold text-foreground">{label}</Text>
                      {tasks.map(({ row, threads }) => (
                        <View key={row.task.taskId}>
                          <Pressable
                            accessibilityRole="button"
                            className="min-h-[44px] justify-center"
                            onPress={() => {
                              setOpen(false);
                              props.onOpenTask(row.task.taskId);
                            }}
                          >
                            <Text className="text-foreground">{row.task.title}</Text>
                          </Pressable>
                          {rows.map((coding) =>
                            coding.kind === "coding" && coding.taskId === row.task.taskId ? (
                              <Pressable
                                key={coding.environmentId + ":" + coding.threadId}
                                accessibilityRole="button"
                                accessibilityLabel={
                                  "GOAT thread: " + (coding.title || "GOAT thread")
                                }
                                className="ml-4 min-h-[44px] justify-center"
                                onPress={() => {
                                  setOpen(false);
                                  props.onOpenThread({
                                    environmentId: coding.environmentId,
                                    id: coding.threadId,
                                  });
                                }}
                              >
                                <Text numberOfLines={1} className="text-foreground-muted">
                                  {coding.title || "GOAT thread"}
                                </Text>
                              </Pressable>
                            ) : null,
                          )}
                          {/* The task's worker and other launches no row lists: lists leave them to the bot. */}
                          {threads
                            .filter(
                              (thread) =>
                                !rows.some(
                                  (coding) =>
                                    coding.kind === "coding" &&
                                    coding.environmentId === thread.environmentId &&
                                    coding.threadId === thread.threadId,
                                ),
                            )
                            .map((thread) => (
                              <Pressable
                                key={thread.environmentId + ":" + thread.threadId}
                                accessibilityRole="button"
                                accessibilityLabel={"Work thread: " + row.task.title}
                                className="ml-4 min-h-[44px] justify-center"
                                onPress={() => {
                                  setOpen(false);
                                  props.onOpenThread({
                                    environmentId: thread.environmentId,
                                    id: thread.threadId,
                                  });
                                }}
                              >
                                <Text numberOfLines={1} className="text-foreground-muted">
                                  Work thread
                                </Text>
                              </Pressable>
                            ))}
                        </View>
                      ))}
                    </View>
                  ))
                )
              ) : null}
              {tab === "Routines" &&
              selected?.connected &&
              routines.data &&
              environmentId &&
              home.botRef ? (
                <MobileBotCheckInForm
                  environmentId={environmentId}
                  botThreadId={home.botRef.threadId}
                  tasks={routines.data.tasks}
                  botName={botName}
                />
              ) : null}
              {tab === "Routines" ? (
                !selected?.connected ? (
                  <Text className="text-foreground-muted">
                    Routines are unavailable while {botName} is offline.
                  </Text>
                ) : routines.error ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={routines.refresh}
                    className="min-h-[44px] justify-center"
                  >
                    <Text className="text-danger-foreground">
                      Couldn't load routines. Try again
                    </Text>
                  </Pressable>
                ) : !routines.data ? (
                  <Text className="text-foreground-muted">Loading routines…</Text>
                ) : boundRoutines.length && environmentId ? (
                  boundRoutines.map((routine) => (
                    <MobileRoutineRow
                      key={routine.id}
                      environmentId={environmentId}
                      row={routine}
                    />
                  ))
                ) : (
                  <MobileBotPanelEmpty
                    title="No routines yet"
                    next={`Ask ${botName} in chat to set up a routine.`}
                  />
                )
              ) : null}
              {tab === "Memory" ? (
                <MobileBotMemory
                  environmentId={environmentId}
                  connected={selected?.connected === true}
                  supported={capabilities?.goatBotNotes === true}
                  member={member !== null}
                  botName={botName}
                  onDraft={
                    props.onDraft
                      ? (text) => {
                          setOpen(false);
                          props.onDraft?.(text);
                        }
                      : undefined
                  }
                  refreshKey={props.notesRefreshKey}
                />
              ) : null}
              {tab === "Library" ? (
                <MobileBotLibrary
                  environmentId={environmentId}
                  connected={selected?.connected === true}
                  botName={botName}
                  supported={capabilities?.goatBotLibrary === true}
                />
              ) : null}
              {tab === "Tasks" && work.inProgress.length > 0 ? (
                <View className="mt-6 gap-1">
                  <Text className="text-xs font-medium text-foreground-muted">Machines</Text>
                  <MobileBotComputer
                    environmentId={environmentId}
                    connected={selected?.connected === true}
                    botId={member?.botId ?? null}
                    botName={botName}
                  />
                </View>
              ) : null}
            </View>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function MobileRoutineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: BotRoutineRow;
}) {
  const { environmentId, row } = props;
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const canRunNow = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const runAgain = async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.runScheduledTaskNow,
      { environmentId, input: { id: row.id } },
      { label: "GOAT Bot routine run now", reportFailure: false },
    );
    setRunning(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setRunError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.setScheduledTaskEnabled,
      { environmentId, input: { id: row.id, enabled } },
      { label: "GOAT Bot routine enabled", reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <View className="gap-1 border-b border-border py-2">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="min-h-[44px] flex-1 justify-center"
        >
          <Text className="font-semibold text-foreground">{row.title}</Text>
          <Text className="text-foreground-muted">
            {row.scheduleText} · {row.nextText}
          </Text>
          <Text className={row.lastFailed ? "text-danger-foreground" : "text-foreground-muted"}>
            {row.lastText}
          </Text>
        </Pressable>
        <ThemedSwitch
          accessibilityLabel={`${row.enabled ? "Pause" : "Resume"} ${row.title}`}
          disabled={busy || !canOperate}
          value={row.enabled}
          onValueChange={(enabled) => void toggle(enabled)}
        />
      </View>
      {expanded ? <Text className="text-foreground-muted">{row.prompt}</Text> : null}
      {row.lastFailed && canRunNow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: running }}
          disabled={running}
          onPress={() => void runAgain()}
          className="min-h-[44px] self-start justify-center"
        >
          <Text className="text-foreground">Run now</Text>
        </Pressable>
      ) : null}
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Couldn't {row.enabled ? "pause" : "resume"} this routine: {error}
        </Text>
      ) : null}
      {runError !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Couldn't run this routine: {runError}
        </Text>
      ) : null}
    </View>
  );
}

/** Runs failed or stopped work again; each tap is its own request and the server may refuse. */
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
