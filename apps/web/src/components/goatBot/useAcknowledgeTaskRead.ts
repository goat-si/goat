import { useAtomValue } from "@effect/atom-react";
import { acknowledgeTaskRead } from "@goat/client-runtime/goatBot";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent } from "react";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";

export { resetTaskReadAcknowledgementsForTests } from "@goat/client-runtime/goatBot";

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
  const acknowledge = useEffectEvent(
    (environment: EnvironmentId, task: ChannelTaskId, through: string) => {
      void acknowledgeTaskRead({
        environmentId: environment,
        taskId: task,
        readThrough: through,
        update,
      }).then((outcome) => {
        if (outcome === "accepted") onAcknowledged?.();
      });
    },
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Keeps the server's read cursor at the activity the open task shows, including activity that arrives while it is open.
  useEffect(() => {
    if (!canUpdate || readThrough === null) return;
    acknowledge(environmentId, taskId, readThrough);
  }, [canUpdate, environmentId, taskId, readThrough]);
}
