import {
  isGoatBotConversationThreadId,
  type BotThreadRow,
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

/** A thread in its own environment. */
export interface GoatBotWorkRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));

/** Whether GOAT Bot's own work launched this thread, rather than a person or their agent. */
export const isGoatBotLaunch = (
  launcher:
    | Pick<OrchestrationV2ThreadLauncher, "kind" | "threadId" | "via" | "workKind">
    | undefined,
) =>
  launcher?.kind === "launch" &&
  launcher.via !== "delegate_task" &&
  (launcher.workKind !== undefined ||
    isGoatBotConversationThreadId(launcher.threadId) ||
    launcher.threadId.startsWith("channel-worker:"));

/**
 * The threads a bot's rows open that are its own work: each task's worker and every launch the
 * server marked a chore. Coding launches and unmarked ones stay people's work.
 */
export function goatBotListedWork(rows: ReadonlyArray<BotThreadRow>): GoatBotWorkRef[] {
  const listed: GoatBotWorkRef[] = [];
  for (const row of rows) {
    if (row.kind === "task") {
      if (row.worker !== undefined) listed.push(row.worker);
    } else if (row.workKind === "chore") {
      listed.push({ environmentId: row.environmentId, threadId: row.threadId });
    }
  }
  return listed;
}

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
 * Scoped keys of the threads lists leave to GOAT Bot: its conversation threads, the work its
 * rows list (so the bot can always open what is hidden), and every subagent or delegated child
 * below them. Work no row lists yet, or any more, stays in lists.
 */
export function goatBotObservationThreadKeys(input: {
  readonly threads: ReadonlyArray<GoatBotVisibilityThread>;
  readonly listedWork?: ReadonlyArray<GoatBotWorkRef>;
}): ReadonlySet<string> {
  const listed = new Set<string>();
  for (const ref of input.listedWork ?? []) listed.add(keyOf(ref.environmentId, ref.threadId));
  const seeds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  for (const thread of input.threads) {
    const key = keyOf(thread.environmentId, thread.id);
    if (
      isGoatBotConversationThreadId(thread.id) ||
      (listed.has(key) && thread.source.launchedBy?.kind !== "promotion")
    ) {
      seeds.add(key);
      continue;
    }
    if (isVisibleWork(thread)) continue;
    for (const parent of observedParents(thread)) {
      const parentKey = keyOf(parent.environmentId, parent.threadId);
      // A conversation parent is known by its id even when its shell is not loaded here.
      if (isGoatBotConversationThreadId(parent.threadId)) seeds.add(parentKey);
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
