import { useAtomValue } from "@effect/atom-react";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Acknowledges an open task's activity on the server once per task and activity value, so a
 * rerender, a request still in flight or Strict Mode's replayed mount never sends it again.
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
  const sent = useRef<string | null>(null);
  const acknowledge = useEffectEvent((through: string) => {
    void update({ environmentId, input: { taskId, readThrough: through } }).then((result) => {
      if (result._tag === "Success") onAcknowledged?.();
    });
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Keeps the server's read cursor at the activity the open task shows, including activity that arrives while it is open.
  useEffect(() => {
    if (!canUpdate || readThrough === null) return;
    const key = `${environmentId}|${taskId}|${readThrough}`;
    if (sent.current === key) return;
    sent.current = key;
    acknowledge(readThrough);
  }, [canUpdate, environmentId, taskId, readThrough]);
}
