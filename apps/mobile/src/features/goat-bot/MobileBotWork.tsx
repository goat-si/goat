import { useAtomValue } from "@effect/atom-react";
import { groupBotWork, presentTaskStatus } from "@goat/client-runtime/goatBot";
import { botRoutineRows, type BotRoutineRow } from "@goat/client-runtime/scheduledTasks";
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
import { Alert, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import { MobileBotStatusCard } from "./MobileBotStatusCard";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

const tabs = ["Tasks", "Routines", "Library", "Computer"] as const;

export function MobileBotWork(props: {
  readonly taskId?: ChannelTaskId;
  readonly taskCard?: ReactNode;
  readonly visible: boolean;
  readonly onOpenTask: (id: ChannelTaskId) => void;
  /** A member bot's work; the main bot's when absent. */
  readonly member?: {
    readonly botId: BotId;
    readonly threadId: ThreadId;
    readonly defaultModelSelection: BotProfile["defaultModelSelection"];
  } | null;
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
    ? groupBotWork(rows, children.data?.groups ?? [], environmentId)
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
          </Text>
          {!enabled ? (
            <Text className="text-foreground-muted">
              Task is unavailable while GOAT Bot is offline or unsupported.
            </Text>
          ) : threads.error ? (
            <Pressable
              accessibilityRole="button"
              onPress={threads.refresh}
              className="min-h-[44px] justify-center"
            >
              <Text className="text-danger-foreground">Couldn't load task. Try again</Text>
            </Pressable>
          ) : threads.isPending || !threads.isSuccess ? (
            <Text className="text-foreground-muted">Loading task…</Text>
          ) : !task ? (
            <Text className="text-foreground-muted">Task not found.</Text>
          ) : null}
          {task ? (
            <View className="flex-row flex-wrap gap-3">
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
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open GOAT Bot work"
          onPress={() => setOpen(true)}
          className="min-h-[44px] self-end justify-center px-4 py-2"
        >
          <Text className="text-foreground">Work</Text>
        </Pressable>
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
          <MobileBotStatusCard
            environmentId={environmentId}
            member={member}
            rows={!enabled ? "unavailable" : threads.isSuccess ? rows : null}
            onOpenTask={(id) => {
              setOpen(false);
              props.onOpenTask(id);
            }}
          />
          <View className="flex-row flex-wrap gap-4 py-4">
            {tabs.map((name) => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: tab === name }}
                onPress={() => setTab(name)}
                className={
                  tab === name
                    ? "min-h-[44px] justify-center rounded-md bg-thread-selected px-3"
                    : "min-h-[44px] justify-center px-3"
                }
              >
                <Text className="text-foreground">{name}</Text>
              </Pressable>
            ))}
          </View>
          <ScrollView>
            {tab === "Tasks" ? (
              !enabled ? (
                <Text className="text-foreground-muted">
                  Tasks are unavailable while GOAT Bot is offline or unsupported.
                </Text>
              ) : threads.error ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={threads.refresh}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-danger-foreground">Couldn't load tasks. Try again</Text>
                </Pressable>
              ) : threads.isPending || !threads.isSuccess ? (
                <Text className="text-foreground-muted">Loading tasks…</Text>
              ) : work.inProgress.length + work.done.length === 0 ? (
                <Text className="text-foreground-muted">
                  No tasks yet. Ask GOAT Bot to start work.
                </Text>
              ) : (
                (
                  [
                    ["In progress", work.inProgress],
                    ["Done", work.done],
                  ] as const
                ).map(([label, tasks]) => (
                  <View key={label} className="gap-2 py-2">
                    <Text className="font-semibold text-foreground">{label}</Text>
                    {tasks.map(({ row }) => (
                      <Pressable
                        key={row.task.taskId}
                        accessibilityRole="button"
                        className="min-h-[44px] justify-center"
                        onPress={() => {
                          setOpen(false);
                          props.onOpenTask(row.task.taskId);
                        }}
                      >
                        <Text className="text-foreground">{row.task.title}</Text>
                      </Pressable>
                    ))}
                  </View>
                ))
              )
            ) : null}
            {tab === "Routines" ? (
              !selected?.connected ? (
                <Text className="text-foreground-muted">
                  Routines are unavailable while GOAT Bot is offline.
                </Text>
              ) : routines.error ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={routines.refresh}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-danger-foreground">Couldn't load routines. Try again</Text>
                </Pressable>
              ) : !routines.data ? (
                <Text className="text-foreground-muted">Loading routines…</Text>
              ) : boundRoutines.length && environmentId ? (
                boundRoutines.map((routine) => (
                  <MobileRoutineRow key={routine.id} environmentId={environmentId} row={routine} />
                ))
              ) : (
                <Text className="text-foreground-muted">
                  Ask GOAT Bot in chat to set up a routine.
                </Text>
              )
            ) : null}
            {tab === "Library" ? (
              <Text className="text-foreground-muted">Files GOAT Bot saves will appear here.</Text>
            ) : null}
            {tab === "Computer" ? (
              <Text className="text-foreground-muted">
                Machines GOAT Bot works on will appear here.
              </Text>
            ) : null}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
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
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Couldn't {row.enabled ? "pause" : "resume"} this routine: {error}
        </Text>
      ) : null}
    </View>
  );
}
