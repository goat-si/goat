import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { threadKey } from "@goat/client-runtime/state/entities";
import { findRemoteShell } from "@goat/client-runtime/state/remote-launches";
import type { ChildThreadApproval } from "@goat/client-runtime/state/thread-requests";
import {
  AuthOrchestrationReadScope,
  type ChannelTaskId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, type ComponentType } from "react";

import { environmentPresentations } from "../../state/presentation";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "../../state/session";
import {
  childThreadApprovalsAtom,
  environmentThreadDetails,
  environmentThreadShells,
} from "../../state/threads";
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
        const childWorkers = new Map<string, WaitingWorker>();
        const observedWorkers = new Map<string, WaitingWorker>();
        const canOpen = (id: EnvironmentId) =>
          get(environmentPresentations.presentationAtom(id))?.connection.phase === "connected" &&
          sessionHasScope(get(environmentSession.sessionStateAtom(id)), AuthOrchestrationReadScope);
        const shellOf = (thread: ScopedThreadRef) =>
          get(environmentThreadShells.threadShellAtom(thread));
        const remoteShellOf = (dispatcher: EnvironmentId, id: ThreadId) => {
          const candidates = [...get(environmentPresentations.presentationsAtom).keys()].flatMap(
            (target) => {
              const shell = shellOf(scopeThreadRef(target, id));
              return shell === null ? [] : [shell];
            },
          );
          return findRemoteShell(candidates, dispatcher, id);
        };
        const addApproval = (entry: ChildThreadApproval) =>
          byRequest.set(JSON.stringify([threadKey(entry.thread), entry.approval.requestId]), entry);
        for (const entry of children) {
          const key = threadKey(entry.thread);
          if (canOpen(entry.thread.environmentId)) {
            childWorkers.set(key, entry);
            addApproval(entry);
          } else {
            childWorkers.set(key, { thread: null, title: entry.title, observationKey: key });
          }
        }
        // Task observations also cover standalone workers outside the chat's subagent lineage.
        for (const chip of chips.values()) {
          if (taskId !== undefined && chip.taskId !== taskId) continue;
          const worker = chip.worker;
          if (worker === undefined) continue;
          for (const need of chip.observed?.needsYou ?? []) {
            if (need.kind !== "approval") continue;
            const request = need.approval;
            const host = request === undefined ? worker.host : request.host;
            const id = request?.threadId ?? worker.threadId;
            const observationKey = JSON.stringify([host ?? null, id]);
            let observed = observedWorkers.get(observationKey);
            if (observed === undefined) {
              const direct =
                host === worker.host
                  ? worker.environmentId
                  : host === undefined
                    ? environmentId
                    : null;
              const remote = direct === null ? remoteShellOf(worker.environmentId, id) : null;
              const target = direct ?? remote?.environmentId;
              const ref = target === undefined ? null : scopeThreadRef(target, id);
              if (ref !== null) childWorkers.delete(threadKey(ref));
              const thread = ref !== null && canOpen(ref.environmentId) ? ref : null;
              const title =
                (thread === null ? null : (remote ?? shellOf(thread))?.title) ??
                (direct === worker.environmentId && id === worker.threadId
                  ? chip.title
                  : host === undefined
                    ? id
                    : `${host} · ${id}`);
              observed =
                thread === null
                  ? { thread: null, title, observationKey }
                  : { thread, title, observationKey };
              observedWorkers.set(observationKey, observed);
            }
            const { thread, title } = observed;
            if (thread === null || request === undefined) continue;
            const key = JSON.stringify([threadKey(thread), request.requestId]);
            if (byRequest.has(key)) continue;
            const approval = get(
              environmentThreadDetails.pendingRequestsAtom(thread),
            )?.approvals.find((entry) => entry.requestId === request.requestId);
            if (approval !== undefined) addApproval({ thread, title, approval });
          }
        }
        return {
          approvals: [...byRequest.values()],
          workers: [...childWorkers.values(), ...observedWorkers.values()],
        };
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
