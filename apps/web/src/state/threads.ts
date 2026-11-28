import { createChildThreadApprovalsAtom } from "@goat/client-runtime/state/thread-requests";
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@goat/client-runtime/state/connections";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createOlderSettledThreadAtoms,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
} from "@goat/client-runtime/state/threads";
import {
  isChannelWorkerThreadId,
  isGoatBotConversationThreadId,
  isRemoteChannelWorkerThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { channelEnvironment } from "./channels";
import { goatBotHomeEnvironmentIdAtom } from "./goatBotHome";
import { environmentShell } from "./shell";

export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const olderSettledThreads = createOlderSettledThreadAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  threadFamilies.snapshotAtom,
);
const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  goatBotListedWork: channelEnvironment.listedBotWork,
  goatBotHomeWork: channelEnvironment.homeCurrentOpenableWorkByEnvironment,
  goatBotHomeEnvironmentId: goatBotHomeEnvironmentIdAtom,
});
export const childThreadApprovalsAtom = createChildThreadApprovalsAtom({
  childThreadInputsAtom: environmentThreadShells.childThreadInputsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}

const isRunning = (status: string) =>
  status === "preparing" || status === "queued" || status === "starting" || status === "running";

const DEFAULT_MAX_KEPT_RUNNING_THREADS = 4;
const MCP_THREAD_PREFIX = "mcp:";
const DELEGATED_TASK_THREAD_PREFIX = "thread:delegated-task:";

type KeepAliveThreadShell = Pick<OrchestrationV2ThreadShell, "id" | "status"> &
  Partial<
    Pick<
      OrchestrationV2ThreadShell,
      | "lineage"
      | "archivedAt"
      | "deletedAt"
      | "creationSource"
      | "launchedBy"
      | "lastVisitedAt"
      | "createdAt"
    >
  >;

interface RankedRunningThread {
  readonly id: ThreadId;
  readonly lastVisitedMs: number;
  readonly createdMs: number;
}

function isKeepAliveEligibleRunningThread(thread: KeepAliveThreadShell): boolean {
  if (!isRunning(thread.status)) return false;
  if (thread.archivedAt != null || thread.deletedAt != null) return false;
  if (thread.lineage?.relationshipToParent === "subagent") return false;
  if (thread.creationSource === "mcp") return false;
  if (thread.launchedBy?.via === "delegate_task") return false;
  if (
    thread.id.startsWith(MCP_THREAD_PREFIX) ||
    thread.id.startsWith(DELEGATED_TASK_THREAD_PREFIX) ||
    isChannelWorkerThreadId(thread.id) ||
    isRemoteChannelWorkerThreadId(thread.id) ||
    isGoatBotConversationThreadId(thread.id)
  ) {
    return false;
  }
  return true;
}

type KeptThreads = ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>>;

function keptThreadsEqual(left: KeptThreads | undefined, right: KeptThreads): boolean {
  if (left === undefined || left.size !== right.size) return false;
  for (const [environmentId, rightThreads] of right) {
    const leftThreads = left.get(environmentId);
    if (leftThreads === undefined || leftThreads.size !== rightThreads.size) return false;
    for (const threadId of rightThreads) {
      if (!leftThreads.has(threadId)) return false;
    }
  }
  return true;
}

function isDetailDone<E>(result: AsyncResult.AsyncResult<EnvironmentThreadState, E>): boolean {
  if (!AsyncResult.isSuccess(result)) return true;
  const { status, data, error } = result.value;
  if (status === "deleted" || Option.isSome(error)) return true;
  return (
    status === "live" &&
    !Option.exists(data, (thread) => thread.runs.some((run) => isRunning(run.status)))
  );
}

/**
 * Keeps a bounded set of user-facing running threads mounted, and holds stopped ones until their
 * independent detail stream is live and also reports stopped. Sidebar/tray status comes from shell
 * streams, so background subagents, MCP/delegated workers, and bot threads are excluded.
 */
export function createRunningThreadKeepAliveAtom<E>(input: {
  readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly threadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<KeepAliveThreadShell>>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
  readonly maxKeptThreads?: number;
}) {
  const maxKeptThreads = Math.max(0, input.maxKeptThreads ?? DEFAULT_MAX_KEPT_RUNNING_THREADS);
  const runningCandidatesAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<RankedRunningThread> = [];
    return Atom.make((get) => {
      const next: RankedRunningThread[] = [];
      for (const thread of get(input.threadsAtom(environmentId))) {
        if (!isKeepAliveEligibleRunningThread(thread)) continue;
        next.push({
          id: thread.id,
          lastVisitedMs:
            thread.lastVisitedAt != null ? DateTime.toEpochMillis(thread.lastVisitedAt) : -1,
          createdMs: thread.createdAt != null ? DateTime.toEpochMillis(thread.createdAt) : -1,
        });
      }
      if (
        previous.length === next.length &&
        previous.every(
          (entry, index) =>
            entry.id === next[index]?.id &&
            entry.lastVisitedMs === next[index]?.lastVisitedMs &&
            entry.createdMs === next[index]?.createdMs,
        )
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`web-running-thread-candidates:${environmentId}`));
  });

  return Atom.make((get): KeptThreads => {
    const previous = Option.getOrUndefined(get.self<KeptThreads>());
    const environmentIds = get(input.environmentIdsAtom);
    const candidates: Array<
      RankedRunningThread & {
        readonly environmentId: EnvironmentId;
        readonly wasKept: boolean;
      }
    > = [];
    const runningIdsByEnv = new Map<EnvironmentId, Set<ThreadId>>();
    for (const environmentId of environmentIds) {
      const previousForEnv = previous?.get(environmentId);
      const runningForEnv = new Set<ThreadId>();
      runningIdsByEnv.set(environmentId, runningForEnv);
      for (const candidate of get(runningCandidatesAtom(environmentId))) {
        runningForEnv.add(candidate.id);
        candidates.push({
          environmentId,
          ...candidate,
          wasKept: previousForEnv?.has(candidate.id) === true,
        });
      }
    }
    candidates.sort((left, right) => {
      if (left.lastVisitedMs !== right.lastVisitedMs) {
        return right.lastVisitedMs - left.lastVisitedMs;
      }
      if (left.wasKept !== right.wasKept) {
        return left.wasKept ? -1 : 1;
      }
      return right.createdMs - left.createdMs;
    });

    const selectedByEnv = new Map<EnvironmentId, Set<ThreadId>>();
    for (const environmentId of environmentIds) {
      selectedByEnv.set(environmentId, new Set<ThreadId>());
    }
    for (const candidate of candidates.slice(0, maxKeptThreads)) {
      selectedByEnv.get(candidate.environmentId)?.add(candidate.id);
    }

    const kept = new Map<EnvironmentId, ReadonlySet<ThreadId>>();
    for (const environmentId of environmentIds) {
      const threadIds = selectedByEnv.get(environmentId) ?? new Set<ThreadId>();
      const stillRunning = runningIdsByEnv.get(environmentId);
      for (const threadId of previous?.get(environmentId) ?? []) {
        if (threadIds.has(threadId)) continue;
        // A thread still running was evicted by the cap rather than stopped; release it now.
        if (stillRunning?.has(threadId)) continue;
        const stateAtom = input.stateAtom(environmentId, threadId);
        // A get dependency would hold stopped streams open until another change rebuilds this atom.
        if (isDetailDone(get.once(stateAtom))) continue;
        threadIds.add(threadId);
        get.subscribe(stateAtom, (state) => {
          if (isDetailDone(state)) get.refreshSelf();
        });
      }
      for (const threadId of threadIds) get.mount(input.stateAtom(environmentId, threadId));
      kept.set(environmentId, threadIds);
    }
    return keptThreadsEqual(previous, kept) && previous !== undefined ? previous : kept;
  }).pipe(Atom.withLabel("web-running-thread-keep-alive"));
}

export const runningThreadKeepAliveAtom = createRunningThreadKeepAliveAtom({
  environmentIdsAtom: Atom.map(environmentCatalog.catalogValueAtom, (catalog) => [
    ...enabledEnvironmentIds(catalog),
  ]),
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  stateAtom: environmentThreads.stateAtom,
});
