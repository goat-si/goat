import {
  BOT_RUNNING_TASK_STATUSES,
  botComputers,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import { type BotId, CHANNEL_LIST_TASKS_MAX_LIMIT, type EnvironmentId } from "@goat/contracts";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";

/** The machines GOAT Bot's running work uses, from its task list. */
export function MobileBotComputer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  /** A member bot's sheet lists only its own work. */
  readonly botId: BotId | null;
}) {
  const { environmentId, connected, botId } = props;
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
  // oxlint-disable-next-line goat/react-effect-budget -- Work starts and moves between machines on the server; read the list again each time the tab opens.
  useEffect(() => {
    if (readable) refresh();
  }, [readable, refresh]);
  if (!connected)
    return (
      <Text className="text-foreground-muted">
        Machines are unavailable while GOAT Bot is offline.
      </Text>
    );
  if (tasks.cause !== null)
    return (
      <View className="gap-1">
        <Text className="text-danger-foreground">Couldn't load GOAT Bot's machines.</Text>
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
      <View className="gap-1">
        <Text className="text-foreground">No work is running right now.</Text>
        <Text className="text-foreground-muted">Machines GOAT Bot works on will appear here.</Text>
      </View>
    );
  return (
    <View className="gap-4 py-2">
      {groups.map((group) => (
        <View key={group.host ?? ""} className="gap-1">
          <Text className="font-semibold text-foreground">
            {group.host ?? "GOAT Bot's computer"}
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
