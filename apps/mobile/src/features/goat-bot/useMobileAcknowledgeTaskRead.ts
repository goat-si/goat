import { acknowledgeTaskRead, type TaskReadUpdate } from "@goat/client-runtime/goatBot";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent } from "react";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const update: TaskReadUpdate = (value) =>
  runAtomCommand(appAtomRegistry, channelEnvironment.updateTaskView, value);

/**
 * Marks a task read through the activity a person can see, once per activity for every view on
 * this phone (the shared record decides). The caller passes readThrough only while the task is on
 * screen, the app is active and the person may update tasks; a failure is not retried here, so the
 * task stays unread until it is shown again or newer activity arrives.
 */
export function useMobileAcknowledgeTaskRead(props: {
  readonly environmentId: EnvironmentId | null;
  readonly taskId: ChannelTaskId | null;
  /** The activity the shown task is unread through; null when nothing should be sent. */
  readonly readThrough: string | null;
  readonly onAcknowledged?: (() => void) | undefined;
  /** The task's own screen says so; a peek on Home stays quiet. */
  readonly onFailed?: (() => void) | undefined;
}) {
  const { environmentId, taskId, readThrough } = props;
  const settle = useEffectEvent((outcome: "skipped" | "accepted" | "failed") => {
    if (outcome === "accepted") props.onAcknowledged?.();
    else if (outcome === "failed") props.onFailed?.();
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Keeps the server's read cursor at the activity the shown task displays, including activity that arrives while it is shown.
  useEffect(() => {
    if (environmentId === null || taskId === null || readThrough === null) return;
    void acknowledgeTaskRead({ environmentId, taskId, readThrough, update }).then(settle);
  }, [environmentId, taskId, readThrough]);
}

type ReadRow = {
  readonly task: { readonly taskId: ChannelTaskId };
  readonly unread: boolean;
  readonly lastActivityAt: string;
};

/**
 * The bot home's two readers: the task's own screen, which says when marking it read failed, and a
 * peek on Home, which stays quiet. seen is the screen focused, the app active and permission held.
 */
export function useMobileHomeTaskReads(props: {
  readonly environmentId: EnvironmentId | null;
  readonly seen: boolean;
  readonly task: ReadRow | null;
  /** The peeked task while the sheet shows it. */
  readonly peek: ReadRow | null;
  readonly onAcknowledged: () => void;
}) {
  const through = (row: ReadRow | null) => (props.seen && row?.unread ? row.lastActivityAt : null);
  useMobileAcknowledgeTaskRead({
    environmentId: props.environmentId,
    taskId: props.task?.task.taskId ?? null,
    readThrough: through(props.task),
    onAcknowledged: props.onAcknowledged,
    onFailed: () => Alert.alert("Could not mark task read", "Please try again."),
  });
  useMobileAcknowledgeTaskRead({
    environmentId: props.environmentId,
    taskId: props.peek?.task.taskId ?? null,
    readThrough: through(props.peek),
    onAcknowledged: props.onAcknowledged,
  });
}
