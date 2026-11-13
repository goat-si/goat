import {
  presentTaskStatus,
  taskAttemptLabel,
  type BotWorkTask,
  type GoatBotTaskCard,
} from "@goat/client-runtime/goatBot";
import type { ChannelUpdateTaskViewInput, EnvironmentId, ThreadId } from "@goat/contracts";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { GoatBotTaskRow } from "./GoatBotTaskRow";
import { MobileTaskActions } from "./MobileTaskActions";

/**
 * A task's own screen header: its title and state with its actions, or, for older work the
 * current list does not hold, where its status and actions are and a way to open Home here.
 */
export function MobileTaskHeader(props: {
  readonly task: BotWorkTask | undefined;
  /** The title the opener carried, else the conversation card's. */
  readonly title: string | null;
  readonly botName: string;
  readonly environmentId: EnvironmentId | null;
  readonly enabled: boolean;
  readonly canRetry: boolean;
  /** A settled current list, or the one kept offline, that does not hold this task. */
  readonly older: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly childError: boolean;
  readonly onRetryRead: () => void;
  readonly onUpdate: (input: ChannelUpdateTaskViewInput) => void;
  readonly onRetried: () => void;
  readonly onOpenThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
  readonly onOpenHome: () => void;
  readonly taskCard?: ReactNode;
  /** The conversation's card, drawn without the status it may no longer hold for older work. */
  readonly card: GoatBotTaskCard | null;
}) {
  const { task } = props;
  return (
    <View className="gap-2 border-b border-border px-4 py-3">
      <Text className="font-semibold text-foreground">
        {task?.row.task.title ?? props.title ?? "Task thread"}
      </Text>
      {task ? (
        <Text className="text-foreground-muted">
          {presentTaskStatus(task.row.task.status, task.row.view.doneAt).label}
          {taskAttemptLabel(task.row.task.generation)
            ? ` · ${taskAttemptLabel(task.row.task.generation)}`
            : null}
        </Text>
      ) : null}
      {!props.enabled ? (
        <Text className="text-foreground-muted">
          Task is unavailable while {props.botName} is offline or unsupported.
        </Text>
      ) : props.failed ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onRetryRead}
          className="min-h-[44px] justify-center"
        >
          <Text className="text-danger-foreground">Couldn't load task. Try again</Text>
        </Pressable>
      ) : props.loading ? (
        <Text className="text-foreground-muted">Loading task…</Text>
      ) : null}
      {props.older ? (
        <View className="flex-row flex-wrap items-center gap-3">
          <Text className="text-foreground-muted">
            Status and actions for older work are in {props.botName}'s Home.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !props.enabled }}
            disabled={!props.enabled}
            onPress={props.onOpenHome}
            className="min-h-[44px] justify-center"
          >
            <Text className={props.enabled ? "text-foreground underline" : "text-foreground-muted"}>
              Open Home
            </Text>
          </Pressable>
        </View>
      ) : null}
      {task ? (
        <MobileTaskActions
          task={task}
          environmentId={props.environmentId}
          enabled={props.enabled}
          canRetry={props.canRetry}
          childError={props.childError}
          onUpdate={props.onUpdate}
          onRetried={props.onRetried}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      {/* Without a current task, its status is unknown here: the chat card is drawn without it. */}
      {task ? (
        props.taskCard
      ) : props.card ? (
        <GoatBotTaskRow
          card={props.card}
          statusHidden
          disabled={!props.enabled}
          onSelectThread={props.onOpenThread}
        />
      ) : null}
    </View>
  );
}
