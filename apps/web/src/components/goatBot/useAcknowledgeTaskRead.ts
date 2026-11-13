import { useAtomValue } from "@effect/atom-react";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent } from "react";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

/** Tasks whose acknowledged activity is remembered; a forgotten one costs one harmless resend. */
const ACKNOWLEDGED_LIMIT = 500;

/** Requests on their way, by environment, task and activity, for every open view. */
const inFlight = new Set<string>();
/** By environment and task, the newest activity time the server accepted, oldest task first. */
const acknowledged = new Map<string, number>();

// JSON arrays keep ids apart whatever characters they contain.
const taskKey = (environmentId: EnvironmentId, taskId: ChannelTaskId) =>
  JSON.stringify([environmentId, taskId]);
const requestKey = (environmentId: EnvironmentId, taskId: ChannelTaskId, through: string) =>
  JSON.stringify([environmentId, taskId, through]);

function remember(task: string, at: number) {
  const known = acknowledged.get(task);
  if (known !== undefined && at <= known) return;
  acknowledged.delete(task);
  acknowledged.set(task, at);
  if (acknowledged.size > ACKNOWLEDGED_LIMIT) {
    const oldest = acknowledged.keys().next().value;
    if (oldest !== undefined) acknowledged.delete(oldest);
  }
}

function send(
  update: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly taskId: ChannelTaskId; readonly readThrough: string };
  }) => Promise<{ readonly _tag: string }>,
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  through: string,
  onAcknowledged: (() => void) | undefined,
) {
  const key = requestKey(environmentId, taskId, through);
  inFlight.add(key);
  void update({ environmentId, input: { taskId, readThrough: through } })
    .then((result) => result._tag === "Success")
    // The command reports its own failures; a failure here only frees the key.
    .catch(() => false)
    .then((accepted) => {
      inFlight.delete(key);
      if (!accepted) return;
      const at = Date.parse(through);
      // An activity that is not a time is not remembered, so it is sent again on the next open.
      if (Number.isFinite(at)) remember(taskKey(environmentId, taskId), at);
      onAcknowledged?.();
    });
}

export function resetTaskReadAcknowledgementsForTests() {
  inFlight.clear();
  acknowledged.clear();
}

/**
 * Acknowledges an open task's activity once while in flight and never again once accepted. A
 * failure leaves it unread until the task opens again, gets newer activity, or permission returns
 * after the failure; a reopen while the failed request was out does not retry it.
 */
export function useAcknowledgeTaskRead({
  environmentId,
  taskId,
  readThrough,
  onAcknowledged,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  /** The activity the task is unread through; null when nothing is unread. */
  readonly readThrough: string | null;
  readonly onAcknowledged?: (() => void) | undefined;
}) {
  const update = useAtomCommand(channelEnvironment.updateTaskView);
  const canUpdate = useAtomValue(channelEnvironment.updateTaskView.permissionAtom(environmentId));
  const acknowledge = useEffectEvent((through: string) =>
    send(update, environmentId, taskId, through, onAcknowledged),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Keeps the server's read cursor at the activity the open task shows, including activity that arrives while it is open.
  useEffect(() => {
    if (!canUpdate || readThrough === null) return;
    if (inFlight.has(requestKey(environmentId, taskId, readThrough))) return;
    const at = Date.parse(readThrough);
    const known = acknowledged.get(taskKey(environmentId, taskId));
    if (Number.isFinite(at) && known !== undefined && at <= known) return;
    acknowledge(readThrough);
  }, [canUpdate, environmentId, taskId, readThrough]);
}
