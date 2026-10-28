import { createDecisionInboxAtoms } from "@goat/client-runtime/state/decision-inbox";
import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@goat/client-runtime/state/entities";
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
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { appAtomRegistry } from "./atom-registry";
import {
  pendingThreadCreationOutcomesAtom,
  selectThreadCreationDetail,
} from "./pending-thread-creation";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";

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
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);

const EMPTY_THREAD_STATE_RESULT = AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
// A thread whose creation is still queued or failed loads as not found, and that miss parks
// its stream as deleted, so every detail read waits until creation is delivered.
const awaitingCreationFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  const outboxKey = scopedThreadKey(ref.environmentId, ref.threadId);
  return Atom.make(
    (get) =>
      selectThreadCreationDetail({
        threadRef: ref,
        threadKey: outboxKey,
        queuedMessagesByThreadKey: get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
        outcomes: get(pendingThreadCreationOutcomesAtom),
      }).detailRef === null,
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`mobile-thread-awaiting-creation:${key}`));
});
const createdThreadStateFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) =>
    get(awaitingCreationFamily(key))
      ? EMPTY_THREAD_STATE_RESULT
      : get(environmentThreads.stateAtom(ref.environmentId, ref.threadId)),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`mobile-created-thread-state:${key}`));
});
function createdThreadStateAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  return createdThreadStateFamily(threadKey({ environmentId, threadId }));
}

export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(createdThreadStateAtom);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

export const decisionInbox = createDecisionInboxAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  presentationAtom: environmentPresentations.presentationAtom,
  details: environmentThreadDetails,
  feedAtom: serverEnvironment.decisionFeed,
});
/** Keeps the subagent tree under `rootThreadId` in the thread list while the caller shows it. */
export function useThreadFamily(
  environmentId: EnvironmentId | null,
  rootThreadId: ThreadId | null,
): void {
  useEffect(() => {
    if (environmentId === null || rootThreadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId);
  }, [environmentId, rootThreadId]);
}

// Long enough for the opened screen to subscribe; its subscription keeps the thread after this.
const OPENING_THREAD_HOLD_MS = 3_000;

/**
 * Starts loading a thread being opened before its screen renders and subscribes, which
 * otherwise waits for navigation to commit.
 */
export function startOpeningEnvironmentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  // A thread whose creation is still queued would load as not found and stay deleted;
  // the opened screen loads it once creation is delivered.
  const { detailRef } = selectThreadCreationDetail({
    threadRef: { environmentId, threadId },
    threadKey: scopedThreadKey(environmentId, threadId),
    queuedMessagesByThreadKey: appAtomRegistry.get(
      threadOutboxManager.queuedMessagesByThreadKeyAtom,
    ),
    outcomes: appAtomRegistry.get(pendingThreadCreationOutcomesAtom),
  });
  if (detailRef === null) return;
  const release = appAtomRegistry.mount(environmentThreads.stateAtom(environmentId, threadId));
  setTimeout(release, OPENING_THREAD_HOLD_MS);
}

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? createdThreadStateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}

/** Whether this app is live on that environment now; a prepared connection may still be opening. */
export function useEnvironmentLive(environmentId: EnvironmentId | null, fallback: EnvironmentId) {
  const status = useAtomValue(environmentShell.stateValueAtom(environmentId ?? fallback)).status;
  return environmentId !== null && status === "live";
}
