import {
  isGoatBotSessionThreadId,
  type ChannelTaskKind,
  type EnvironmentId,
  type OrchestrationV2ThreadLauncher,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";

export interface GoatBotVisibilityThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly lineage: Pick<
    OrchestrationV2ThreadShell["lineage"],
    "parentThreadId" | "relationshipToParent"
  >;
  readonly source: {
    readonly launchedBy?:
      | Pick<OrchestrationV2ThreadLauncher, "kind" | "threadId" | "environmentId" | "via">
      | undefined;
  };
}

/** A channel task's worker thread, in the worker's own environment. A missing kind is work. */
export interface GoatBotKnownWorker {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly kind?: ChannelTaskKind | undefined;
}

const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));

// Coding work a thread launched and threads the user promoted are people's work: the walk up
// from a bot thread stops there, and their own children fold as they do today.
const isVisibleWork = (thread: GoatBotVisibilityThread) => {
  const launcher = thread.source.launchedBy;
  return (
    launcher?.kind === "promotion" ||
    (launcher?.kind === "launch" && launcher.via !== "delegate_task")
  );
};

/** The threads this one observes for: its subagent parent and the thread that delegated it. */
function observedParents(thread: GoatBotVisibilityThread) {
  const parents: Array<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }> = [];
  const { parentThreadId, relationshipToParent } = thread.lineage;
  if (relationshipToParent === "subagent" && parentThreadId !== null) {
    parents.push({ environmentId: thread.environmentId, threadId: parentThreadId });
  }
  const launcher = thread.source.launchedBy;
  // A task.create child on another host has no parent there, only this launch record.
  if (launcher?.kind === "launch" && launcher.via === "delegate_task") {
    parents.push({
      environmentId: launcher.environmentId ?? thread.environmentId,
      threadId: launcher.threadId,
    });
  }
  return parents;
}

/**
 * Scoped keys of the threads GOAT Bot runs for observation: its session threads, its per-task
 * turn workers when their tasks are known, and every subagent or delegated child below them.
 */
export function goatBotObservationThreadKeys(input: {
  readonly threads: ReadonlyArray<GoatBotVisibilityThread>;
  readonly knownWorkers?: ReadonlyArray<GoatBotKnownWorker>;
}): ReadonlySet<string> {
  const workerKind = new Map<string, ChannelTaskKind>();
  for (const worker of input.knownWorkers ?? []) {
    workerKind.set(keyOf(worker.environmentId, worker.threadId), worker.kind ?? "work");
  }
  const seeds = new Set<string>();
  for (const [key, kind] of workerKind) if (kind === "turn") seeds.add(key);
  const childrenByParent = new Map<string, string[]>();
  for (const thread of input.threads) {
    const key = keyOf(thread.environmentId, thread.id);
    if (isGoatBotSessionThreadId(thread.id)) {
      seeds.add(key);
      continue;
    }
    if (seeds.has(key) || isVisibleWork(thread) || workerKind.get(key) === "work") continue;
    for (const parent of observedParents(thread)) {
      const parentKey = keyOf(parent.environmentId, parent.threadId);
      // A session parent is known by its id even when its shell is not loaded here.
      if (isGoatBotSessionThreadId(parent.threadId)) seeds.add(parentKey);
      const siblings = childrenByParent.get(parentKey);
      if (siblings === undefined) childrenByParent.set(parentKey, [key]);
      else siblings.push(key);
    }
  }
  const hidden = new Set(seeds);
  const pending = [...seeds];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const child of childrenByParent.get(at) ?? []) {
      if (hidden.has(child)) continue;
      hidden.add(child);
      pending.push(child);
    }
  }
  return hidden;
}
