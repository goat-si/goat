import { useAtomValue } from "@effect/atom-react";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent } from "react";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

/** Tasks whose acknowledged activity is remembered; a forgotten one costs one harmless resend. */
const ACKNOWLEDGED_LIMIT = 500;

/**
 * Requests on their way, by environment, task and activity, for every open view. retry records
 * that the task was reopened, or update permission returned, while the request was out.
 */
const inFlight = new Map<string, { retry: boolean }>();
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
  const request = { retry: false };
  inFlight.set(key, request);
  void update({ environmentId, input: { taskId, readThrough: through } })
    .then((result) => result._tag === "Success")
    // The command reports its own failures; here a failure only decides whether to retry.
    .catch(() => false)
    .then((accepted) => {
      inFlight.delete(key);
      if (accepted) {
        const at = Date.parse(through);
        // An activity that is not a time is not remembered, so it is sent again on the next open.
        if (Number.isFinite(at)) remember(taskKey(environmentId, taskId), at);
        onAcknowledged?.();
      } else if (request.retry) {
        send(update, environmentId, taskId, through, onAcknowledged);
      }
    });
}

export function resetTaskReadAcknowledgementsForTests() {
  inFlight.clear();
  acknowledged.clear();
}

/**
 * Acknowledges an open task's activity on the server. Each task and activity goes out once while
 * in flight and is skipped once accepted, whichever view shows it and however often it mounts. A
 * failure is retried only when the task opens again, newer activity arrives, or update permission
 * returns while it is open; a reopen or return while the request is out retries once if it fails.
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
    const pending = inFlight.get(requestKey(environmentId, taskId, readThrough));
    if (pending !== undefined) {
      pending.retry = true;
      return;
    }
    const at = Date.parse(readThrough);
    const known = acknowledged.get(taskKey(environmentId, taskId));
    if (Number.isFinite(at) && known !== undefined && at <= known) return;
    acknowledge(readThrough);
  }, [canUpdate, environmentId, taskId, readThrough]);
}
