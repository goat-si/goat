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
import { MobileTaskLookupNotices, MobileTaskUnavailable } from "./MobileTaskLookupParts";
import type { useMobileTaskScreen } from "./useMobileTaskScreen";
import { useMobileStatusAnnouncement } from "./useMobileStatusAnnouncement";
import type { MobileTaskLookup } from "./useMobileBotTaskLookup";

/** What the screen reader is told when the by-id read settles on something other than the task. */
function lookupLine(lookup: MobileTaskLookup) {
  switch (lookup.state) {
    case "denied":
      return "Permission to read this task is unavailable.";
    case "failed":
      return "Couldn't load this task.";
    case "missing":
      return "This task cannot be found here.";
    case "known":
    case "unavailable":
      return lookup.result.partial ? "Some task details could not be checked." : null;
    default:
      return null;
  }
}
import { lookedUpTitle } from "./lookedUpTitle";

/**
 * A task's own screen header: its title and state with its actions. For older work the current
 * list does not hold, a server that looks tasks up by id supplies them; otherwise the header says
 * where its status and actions are and opens Home here.
 */
export function MobileTaskHeader(props: {
  readonly task: BotWorkTask | undefined;
  /** The by-id read for a task the current list does not hold, and the task's actions. */
  readonly screen: Pick<
    ReturnType<typeof useMobileTaskScreen>,
    "lookup" | "canUpdate" | "update" | "retried"
  >;
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
  readonly onOpenThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
  readonly onOpenHome: () => void;
  readonly taskCard?: ReactNode;
  /** The conversation's card, drawn without the status it may no longer hold for older work. */
  readonly card: GoatBotTaskCard | null;
}) {
  const { lookup, canUpdate, retried } = props.screen;
  const onUpdate = (input: ChannelUpdateTaskViewInput) => void props.screen.update(input);
  useMobileStatusAnnouncement(props.task === undefined ? lookupLine(lookup) : null, {
    onMount: true,
  });
  const found =
    props.task === undefined && (lookup.state === "known" || lookup.state === "unavailable");
  const task = props.task ?? (lookup.state === "known" ? lookup.task : undefined);
  const unavailable = props.task === undefined && lookup.state === "unavailable" ? lookup : null;
  const title =
    props.task !== undefined
      ? props.task.row.task.title
      : lookup.state === "known"
        ? lookedUpTitle(
            lookup.task.row.task.title,
            lookup.result.task.state === "known"
              ? lookup.result.task.row.task.titleTruncated
              : undefined,
          )
        : unavailable
          ? lookedUpTitle(unavailable.task.task.title, unavailable.task.task.titleTruncated)
          : (props.title ?? "Task thread");
  const status = task
    ? presentTaskStatus(task.row.task.status, task.row.view.doneAt).label
    : unavailable
      ? presentTaskStatus(unavailable.task.task.status).label
      : null;
  const generation = task?.row.task.generation ?? unavailable?.task.task.generation;
  return (
    <View className="gap-2 border-b border-border px-4 py-3">
      <Text className="font-semibold text-foreground">{title}</Text>
      {status !== null ? (
        <Text className="text-foreground-muted">
          {status}
          {taskAttemptLabel(generation) ? ` · ${taskAttemptLabel(generation)}` : null}
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
          className="min-h-[44px] min-w-[44px] justify-center"
        >
          <Text className="text-danger-foreground">Couldn't load task. Try again</Text>
        </Pressable>
      ) : props.loading ? (
        <Text className="text-foreground-muted">Loading task…</Text>
      ) : null}
      {lookup.state === "loading" ? (
        <Text className="text-foreground-muted">Loading task…</Text>
      ) : null}
      {lookup.state === "missing" ? (
        <Text className="text-foreground-muted">This task cannot be found here.</Text>
      ) : null}
      {(props.older && lookup.state === "off") ||
      lookup.state === "denied" ||
      lookup.state === "failed" ? (
        <View className="flex-row flex-wrap items-center gap-3">
          <Text className="text-foreground-muted">
            Status and actions for older work are in {props.botName}'s Home.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !props.enabled }}
            disabled={!props.enabled}
            onPress={props.onOpenHome}
            className="min-h-[44px] min-w-[44px] justify-center"
          >
            <Text className={props.enabled ? "text-foreground underline" : "text-foreground-muted"}>
              Open Home
            </Text>
          </Pressable>
        </View>
      ) : null}
      {lookup.state === "denied" ? (
        <Text className="text-foreground-muted">Permission to read this task is unavailable.</Text>
      ) : null}
      {lookup.state === "failed" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => lookup.retry()}
          className="min-h-[44px] min-w-[44px] justify-center"
        >
          <Text className="text-danger-foreground">Couldn't load this task. Try again</Text>
        </Pressable>
      ) : null}
      {found && (lookup.state === "known" || lookup.state === "unavailable") ? (
        <MobileTaskLookupNotices result={lookup.result} />
      ) : null}
      {task ? (
        <MobileTaskActions
          task={task}
          environmentId={props.environmentId}
          enabled={props.enabled}
          canUpdate={canUpdate}
          canRetry={props.canRetry}
          childError={props.childError}
          onUpdate={onUpdate}
          onRetried={retried}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      {unavailable ? (
        <MobileTaskUnavailable
          task={unavailable.task}
          result={unavailable.result}
          environmentId={props.environmentId}
          enabled={props.enabled}
          canRetry={props.canRetry}
          onRetried={retried}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      {/* Without a current task its status is unknown here, so the card is drawn without it; a task
          the server does not have shows none. */}
      {props.task ? (
        props.taskCard
      ) : props.card && lookup.state !== "missing" ? (
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
