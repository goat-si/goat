import type { BotWorkTask } from "@goat/client-runtime/goatBot";
import { isRetryableTaskStatus } from "@goat/client-runtime/goatBot";
import type { ChannelUpdateTaskViewInput, EnvironmentId, ThreadId } from "@goat/contracts";
import { Pressable, Text, View } from "react-native";

import { MobileBotRemoteWork } from "./MobileBotRemoteWork";
import { MobileTaskRetry } from "./MobileTaskRetry";

/**
 * A task screen's actions and the work it started. While the bot's computer is offline the task
 * stays on screen from the last list, but every control is closed until it reconnects.
 */
export function MobileTaskActions(props: {
  readonly task: BotWorkTask;
  readonly environmentId: EnvironmentId | null;
  readonly enabled: boolean;
  /** This device may change the task's view; without it Pin and Done stay closed. */
  readonly canUpdate: boolean;
  readonly canRetry: boolean;
  readonly childError: boolean;
  readonly onUpdate: (input: ChannelUpdateTaskViewInput) => void;
  readonly onRetried: () => void;
  readonly onOpenThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}) {
  const { task } = props;
  const closed = !props.enabled;
  const viewClosed = closed || !props.canUpdate;
  const id = task.row.task.taskId;
  const change = (input: ChannelUpdateTaskViewInput) => {
    if (!viewClosed) props.onUpdate(input);
  };
  return (
    <View className="flex-row flex-wrap gap-3">
      {props.environmentId && props.canRetry && isRetryableTaskStatus(task.row.task.status) ? (
        <MobileTaskRetry
          environmentId={props.environmentId}
          taskId={id}
          onStarted={props.onRetried}
          disabled={closed}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: viewClosed }}
        disabled={viewClosed}
        className="min-h-[44px] justify-center"
        onPress={() => change({ taskId: id, pinned: !task.row.view.pinnedAt })}
      >
        <Text className={viewClosed ? "text-foreground-muted" : "text-foreground"}>
          {task.row.view.pinnedAt ? "Unpin" : "Pin"}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: viewClosed }}
        disabled={viewClosed}
        className="min-h-[44px] justify-center"
        onPress={() => change({ taskId: id, done: !task.row.view.doneAt })}
      >
        <Text className={viewClosed ? "text-foreground-muted" : "text-foreground"}>
          {task.row.view.doneAt ? "Reopen" : "Mark done"}
        </Text>
      </Pressable>
      {task.threads.map((thread) => (
        <Pressable
          key={`${thread.environmentId}:${thread.threadId}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: closed }}
          disabled={closed}
          className="min-h-[44px] justify-center"
          onPress={() =>
            props.onOpenThread({ environmentId: thread.environmentId, id: thread.threadId })
          }
        >
          <Text className={closed ? "text-foreground-muted" : "text-foreground underline"}>
            Open work thread
          </Text>
        </Pressable>
      ))}
      {task.remote.map((item) => (
        <MobileBotRemoteWork
          key={item.childWorkId}
          item={item}
          onOpenThread={props.onOpenThread}
          disabled={closed}
        />
      ))}
      {task.subagents.map((agent) => (
        <Text key={agent.childWorkId} className="text-foreground-muted">
          {agent.host ?? agent.destinationHint ?? "Subagent"} · {agent.label}
        </Text>
      ))}
      {props.childError ? (
        <Text className="text-danger-foreground">Couldn't load subagents.</Text>
      ) : null}
    </View>
  );
}
