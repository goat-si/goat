import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { threadKey } from "@goat/client-runtime/state/entities";
import type { ChildThreadApproval } from "@goat/client-runtime/state/thread-requests";
import {
  AuthOrchestrationReadScope,
  type ChannelTaskId,
  type EnvironmentId,
  type HubNodesSnapshot,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ThreadId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, type ComponentType } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "../../state/session";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
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

const MAX_HOME_APPROVAL_DETAILS = 4;

function verifiedHostEnvironments(
  snapshot: HubNodesSnapshot,
): ReadonlyMap<string, EnvironmentId | null> {
  const hosts = new Map<string, EnvironmentId | null>();
  for (const node of snapshot.nodes) {
    for (const { target, status } of node.routes) {
      const host = target.kind === "linked" ? target.name : target.alias;
      const id = status === "online" ? node.environmentId : null;
      hosts.set(host, hosts.has(host) && hosts.get(host) !== id ? null : id);
    }
  }
  return hosts;
}

export default function MobileBotApprovals(props: MobileBotApprovalProps) {
  const { environmentId, threadId, taskId, chips } = props;
  const requests = useMemo(
    () =>
      Atom.make((get) => {
        const workers = new Map<string, WaitingWorker>();
        const detailReads = new Map<
          string,
          {
            thread: ScopedThreadRef;
            title: string;
            requests: Set<RuntimeRequestId> | null;
          }
        >();
        const canOpen = (id: EnvironmentId) =>
          get(environmentPresentations.presentationAtom(id))?.connection.phase === "connected" &&
          sessionHasScope(get(environmentSession.sessionStateAtom(id)), AuthOrchestrationReadScope);
        let hostEnvironments: ReadonlyMap<string, EnvironmentId | null> | null = null;
        const remoteEnvironment = (host: string) => {
          if (hostEnvironments === null) {
            const result = canOpen(environmentId)
              ? get(serverEnvironment.hubNodesLive({ environmentId, input: {} }))
              : null;
            hostEnvironments =
              result?._tag === "Success" &&
              !result.waiting &&
              result.value.hubEnvironmentId === environmentId
                ? verifiedHostEnvironments(result.value)
                : new Map();
          }
          return hostEnvironments.get(host) ?? null;
        };
        for (const chip of chips.values()) {
          if (taskId !== undefined && chip.taskId !== taskId) continue;
          const worker = chip.worker;
          for (const need of chip.observed?.needsYou ?? []) {
            if (need.kind !== "approval") continue;
            const request = need.approval;
            const host = request === undefined ? worker?.host : request.host;
            const id = request?.threadId ?? worker?.threadId;
            if (id === undefined) {
              const key = JSON.stringify([chip.taskId]);
              workers.set(key, { thread: null, title: chip.title, observationKey: key });
              continue;
            }
            const target =
              host === undefined
                ? environmentId
                : host === worker?.host
                  ? worker.environmentId
                  : remoteEnvironment(host);
            const ref = target === null ? null : scopeThreadRef(target, id);
            const key = ref === null ? JSON.stringify([environmentId, host, id]) : threadKey(ref);
            let observed = workers.get(key);
            if (observed === undefined) {
              const thread = ref !== null && canOpen(ref.environmentId) ? ref : null;
              const shell =
                thread === null ? null : get(environmentThreadShells.threadShellAtom(thread));
              const title =
                shell?.title ??
                (target === worker?.environmentId && id === worker.threadId
                  ? chip.title
                  : host === undefined
                    ? id
                    : `${host} · ${id}`);
              observed =
                thread === null
                  ? { thread: null, title, observationKey: key }
                  : { thread, title, observationKey: key };
              workers.set(key, observed);
            }
            const { thread, title } = observed;
            if (thread === null || request === undefined) continue;
            const detail = detailReads.get(key) ?? {
              thread,
              title,
              requests: new Set<RuntimeRequestId>(),
            };
            detail.requests?.add(request.requestId);
            detailReads.set(key, detail);
          }
        }
        if (taskId === undefined) {
          const bot = scopeThreadRef(environmentId, threadId);
          for (const child of get(environmentThreadShells.childThreadInputsAtom(bot))) {
            if (!child.hasPendingApprovals) continue;
            const thread = scopeThreadRef(child.environmentId, child.id);
            const key = threadKey(thread);
            const readable = canOpen(thread.environmentId);
            if (!workers.has(key)) {
              workers.set(key, {
                thread: readable ? thread : null,
                title: child.title,
                observationKey: key,
              });
            }
            if (readable) detailReads.set(key, { thread, title: child.title, requests: null });
          }
        }
        const approvals: ChildThreadApproval[] = [];
        const limit = taskId === undefined ? MAX_HOME_APPROVAL_DETAILS : detailReads.size;
        for (const { thread, title, requests } of [...detailReads.values()].slice(0, limit)) {
          for (const approval of get(environmentThreadDetails.pendingRequestsAtom(thread))
            ?.approvals ?? []) {
            if (requests === null || requests.has(approval.requestId))
              approvals.push({ thread, title, approval });
          }
        }
        return { approvals, workers: [...workers.values()] };
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
