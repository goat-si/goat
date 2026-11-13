import {
  accessDenied,
  BOT_RUNNING_TASK_STATUSES,
  botComputers,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import { type BotId, CHANNEL_LIST_TASKS_MAX_LIMIT, type EnvironmentId } from "@goat/contracts";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

/** The machines GOAT Bot's running work uses, from its task list. */
export function MobileBotComputer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  /** A member bot's sheet lists only its own work. */
  readonly botId: BotId | null;
  readonly botName?: string;
  /** Changes when the bot's work changes, so the machines are read again while Home stays open. */
  readonly workKey?: string;
}) {
  const { environmentId, connected, botId } = props;
  const workKey = props.workKey ?? "";
  const botName = props.botName ?? "GOAT Bot";
  const readable = environmentId !== null && connected;
  const tasks = useEnvironmentQuery(
    readable
      ? channelEnvironment.listTasks({
          environmentId,
          input: {
            status: [...BOT_RUNNING_TASK_STATUSES],
            limit: CHANNEL_LIST_TASKS_MAX_LIMIT,
            ...(botId === null ? {} : { botId }),
          },
        })
      : null,
  );
  const refresh = tasks.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Work starts and moves between machines on the server; read the list again when the tab opens and when the bot's work changes.
  useEffect(() => {
    if (readable && workKey.length >= 0) refresh();
  }, [readable, refresh, workKey]);
  if (!connected)
    return (
      <Text className="text-foreground-muted">
        Machines are unavailable while {botName} is offline.
      </Text>
    );
  if (accessDenied(tasks.cause))
    return (
      <Text className="text-foreground-muted">This device can't read {botName}'s machines.</Text>
    );
  if (tasks.cause !== null)
    return (
      <View className="gap-1">
        <Text className="text-danger-foreground">Couldn't load {botName}'s machines.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={refresh}
          className="min-h-[44px] min-w-[44px] justify-center px-2"
        >
          <Text className="text-foreground">Try again</Text>
        </Pressable>
      </View>
    );
  if (tasks.data === null) return <Text className="text-foreground-muted">Loading machines…</Text>;
  const groups = botComputers(tasks.data.tasks);
  if (groups.length === 0)
    return (
      <MobileBotPanelEmpty
        title="No work running"
        next={`Machines ${botName} works on will appear here.`}
      />
    );
  return (
    <View className="gap-4 py-2">
      {groups.map((group) => (
        <View key={group.host ?? ""} className="gap-1">
          <Text className="font-semibold text-foreground">
            {group.host ?? `${botName}'s computer`}
          </Text>
          {group.tasks.map((task) => (
            <View key={task.taskId}>
              <Text className="text-foreground">{task.title}</Text>
              <Text className="text-foreground-muted">
                {presentTaskStatus(task.status, null).label}
              </Text>
            </View>
          ))}
        </View>
      ))}
      {tasks.data.nextCursor !== undefined ? (
        <Text className="text-foreground-muted">More tasks are running than this list shows.</Text>
      ) : null}
    </View>
  );
}
