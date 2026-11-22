import type { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import type { MobileBotApprovalProps, MobileBotApprovalSlot } from "./MobileBotApprovals";
import type { MobileTaskApprovalObservation } from "./useMobileBotTaskLookup";

export function botApprovalRenderer(
  ApprovalCards: MobileBotApprovalSlot | undefined,
  session: {
    readonly historyEnvironmentId: EnvironmentId | undefined | null;
    readonly threadId: ThreadId | undefined | null;
    readonly taskChips: MobileBotApprovalProps["chips"];
  },
  taskId: ChannelTaskId | undefined,
  onOpenThread: MobileBotApprovalProps["onOpenThread"],
) {
  const { historyEnvironmentId: environmentId, threadId, taskChips } = session;
  return (taskObservation?: MobileTaskApprovalObservation) =>
    ApprovalCards && environmentId && threadId ? (
      <ApprovalCards
        environmentId={environmentId}
        threadId={threadId}
        taskId={taskId}
        chips={taskChips}
        taskObservation={taskObservation}
        onOpenThread={onOpenThread}
      />
    ) : null;
}
