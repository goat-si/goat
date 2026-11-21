import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { threadKey } from "@goat/client-runtime/state/entities";
import type { ChildThreadApproval } from "@goat/client-runtime/state/thread-requests";
import {
  AuthOrchestrationReadScope,
  type ChannelTaskId,
  type EnvironmentId,
  type ThreadId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, type ComponentType } from "react";

import { environmentPresentations } from "../../state/presentation";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "../../state/session";
import { childThreadApprovalsAtom, environmentThreadDetails } from "../../state/threads";
import type { WaitingWorker } from "../threads/ChildApprovalContext";
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
  const requests = useMemo(
    () =>
      Atom.make((get) => {
        const children =
          taskId === undefined
            ? get(childThreadApprovalsAtom(scopeThreadRef(environmentId, threadId)))
            : [];
        const byRequest = new Map<string, ChildThreadApproval>();
        const workers = new Map<string, WaitingWorker>();
        const addWorker = (thread: WaitingWorker["thread"], title: string) => {
          const key = threadKey(thread);
          const known = workers.get(key);
          if (known !== undefined) return known;
          const canOpen =
            get(environmentPresentations.presentationAtom(thread.environmentId))?.connection
              .phase === "connected" &&
            sessionHasScope(
              get(environmentSession.sessionStateAtom(thread.environmentId)),
              AuthOrchestrationReadScope,
            );
          const worker = { thread, title, canOpen };
          workers.set(key, worker);
          return worker;
        };
        const addApproval = (entry: ChildThreadApproval) =>
          byRequest.set(JSON.stringify([threadKey(entry.thread), entry.approval.requestId]), entry);
        for (const entry of children) {
          if (addWorker(entry.thread, entry.title).canOpen) addApproval(entry);
        }
        // Task observations also cover standalone workers outside the chat's subagent lineage.
        for (const chip of chips.values()) {
          if (taskId !== undefined && chip.taskId !== taskId) continue;
          const worker = chip.worker;
          if (worker === undefined) continue;
          for (const need of chip.observed?.needsYou ?? []) {
            const request = need.approval;
            if (need.kind !== "approval" || (request !== undefined && request.host !== worker.host))
              continue;
            const thread = scopeThreadRef(
              worker.environmentId,
              request?.threadId ?? worker.threadId,
            );
            if (!addWorker(thread, chip.title).canOpen || request === undefined) continue;
            const key = JSON.stringify([threadKey(thread), request.requestId]);
            if (byRequest.has(key)) continue;
            const approval = get(
              environmentThreadDetails.pendingRequestsAtom(thread),
            )?.approvals.find((entry) => entry.requestId === request.requestId);
            if (approval !== undefined) addApproval({ thread, title: chip.title, approval });
          }
        }
        return { approvals: [...byRequest.values()], workers: [...workers.values()] };
      }),
    [environmentId, threadId, taskId, chips],
  );
  const { approvals, workers } = useAtomValue(requests);
  return (
    <ChildThreadApprovals
      approvals={approvals}
      workers={workers}
      onOpenWorker={({ environmentId, threadId }) => {
        if (
          goatBotComputerConnectedNow(environmentId) &&
          readEnvironmentScope(environmentId, AuthOrchestrationReadScope)
        )
          props.onOpenThread({ environmentId, id: threadId });
      }}
    />
  );
}
