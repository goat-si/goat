import { scopeThreadRef } from "@goat/client-runtime/environment";
import { threadKey } from "@goat/client-runtime/state/entities";
import type { ChildThreadApproval } from "@goat/client-runtime/state/thread-requests";
import type { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, type ComponentType } from "react";

import { environmentPresentations } from "../../state/presentation";
import { childThreadApprovalsAtom, environmentThreadDetails } from "../../state/threads";
import { ChildThreadApprovals } from "../threads/ChildThreadApprovals";
import { goatBotComputerConnectedNow } from "./goatBotComputerLink";
import type { MobileTaskChips } from "./mobileBotTaskStatus";

export interface MobileBotApprovalProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: ChannelTaskId | undefined;
  readonly chips: MobileTaskChips;
  readonly onOpenThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}

export type MobileBotApprovalSlot = ComponentType<MobileBotApprovalProps>;

export default function MobileBotApprovals(props: MobileBotApprovalProps) {
  const { environmentId, threadId, taskId, chips } = props;
  const approvals = useMemo(
    () =>
      Atom.make((get) => {
        // Worker links in the task observations also cover standalone coding threads that
        // are not in the bot conversation's subagent lineage.
        const children =
          taskId === undefined
            ? get(childThreadApprovalsAtom(scopeThreadRef(environmentId, threadId)))
            : [];
        const byRequest = new Map<string, ChildThreadApproval>();
        const keyOf = (entry: ChildThreadApproval) =>
          JSON.stringify([threadKey(entry.thread), entry.approval.requestId]);
        for (const entry of children) byRequest.set(keyOf(entry), entry);
        for (const chip of chips.values()) {
          if (taskId !== undefined && chip.taskId !== taskId) continue;
          const worker = chip.worker;
          if (worker === undefined) continue;
          for (const need of chip.observed?.needsYou ?? []) {
            const request = need.approval;
            if (need.kind !== "approval" || request === undefined || request.host !== worker.host)
              continue;
            const thread = scopeThreadRef(worker.environmentId, request.threadId);
            if (
              get(environmentPresentations.presentationAtom(thread.environmentId))?.connection
                .phase !== "connected"
            )
              continue;
            const approval = get(
              environmentThreadDetails.pendingRequestsAtom(thread),
            )?.approvals.find((entry) => entry.requestId === request.requestId);
            if (approval === undefined) continue;
            const entry = { thread, title: chip.title, approval };
            const key = keyOf(entry);
            if (!byRequest.has(key)) byRequest.set(key, entry);
          }
        }
        return [...byRequest.values()];
      }),
    [environmentId, threadId, taskId, chips],
  );
  return (
    <ChildThreadApprovals
      approvalsAtom={approvals}
      onOpenWorker={({ environmentId, threadId }) => {
        if (goatBotComputerConnectedNow(environmentId))
          props.onOpenThread({ environmentId, id: threadId });
      }}
    />
  );
}
