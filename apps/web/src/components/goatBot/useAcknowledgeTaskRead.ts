import { useAtomValue } from "@effect/atom-react";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent } from "react";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

/** Tasks whose acknowledged activity is remembered; a forgotten one costs one harmless resend. */
const ACKNOWLEDGED_LIMIT = 500;

/** environment|task|activity keys whose acknowledgement is on its way, for every open view. */
const inFlight = new Set<string>();
/** environment|task to the newest activity the server accepted, oldest task first. */
const acknowledged = new Map<string, string>();

const later = (a: string, b: string) => {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left > right : a > b;
};

function remember(task: string, through: string) {
  const known = acknowledged.get(task);
  if (known !== undefined && !later(through, known)) return;
  acknowledged.delete(task);
  acknowledged.set(task, through);
  if (acknowledged.size > ACKNOWLEDGED_LIMIT) {
    const oldest = acknowledged.keys().next().value;
    if (oldest !== undefined) acknowledged.delete(oldest);
  }
}

export function resetTaskReadAcknowledgementsForTests() {
  inFlight.clear();
  acknowledged.clear();
}

/**
 * Acknowledges an open task's activity on the server. Each task and activity goes out once while
 * in flight and is skipped once accepted, whichever view shows it and however often it mounts. A
 * failure is retried only when the task opens again, newer activity arrives, or update permission
 * returns while it is open.
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
  const acknowledge = useEffectEvent((task: string, key: string, through: string) => {
    inFlight.add(key);
    void update({ environmentId, input: { taskId, readThrough: through } })
      .then((result) => {
        if (result._tag !== "Success") return;
        remember(task, through);
        onAcknowledged?.();
      })
      // The command reports its own failures; this only frees the key for a later trigger.
      .catch(() => undefined)
      .finally(() => inFlight.delete(key));
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Keeps the server's read cursor at the activity the open task shows, including activity that arrives while it is open.
  useEffect(() => {
    if (!canUpdate || readThrough === null) return;
    const task = `${environmentId}|${taskId}`;
    const key = `${task}|${readThrough}`;
    const known = acknowledged.get(task);
    if (inFlight.has(key) || (known !== undefined && !later(readThrough, known))) return;
    acknowledge(task, key, readThrough);
  }, [canUpdate, environmentId, taskId, readThrough]);
}
