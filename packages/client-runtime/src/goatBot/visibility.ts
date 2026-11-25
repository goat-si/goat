import {
  isChannelWorkerThreadId,
  isGoatBotConversationThreadId,
  isRemoteChannelWorkerThreadId,
  type BotThreadRow,
  type EnvironmentId,
  type OrchestrationV2ThreadLauncher,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { HomeCurrentOpenableLink } from "./homeCurrentOpenableWork.ts";

export interface GoatBotVisibilityThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly worktreePath: OrchestrationV2ThreadShell["worktreePath"];
  readonly lineage: Pick<
    OrchestrationV2ThreadShell["lineage"],
    "parentThreadId" | "relationshipToParent"
  >;
  readonly source: {
    readonly launchedBy?:
      | Pick<
          OrchestrationV2ThreadLauncher,
          "kind" | "threadId" | "environmentId" | "via" | "workKind"
        >
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

// The server names a launch it admitted for GOAT Bot after its child-work record.
const CHANNEL_CHILD_WORK_THREAD_PREFIX = "channel-child-work:";

/** Threads that run for a bot by their id: its conversations and every task's worker. */
const isGoatBotThreadId = (threadId: string) =>
  isGoatBotConversationThreadId(threadId) ||
  isChannelWorkerThreadId(threadId) ||
  isRemoteChannelWorkerThreadId(threadId);

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
    isChannelWorkerThreadId(launcher.threadId));

/**
 * Whether the thread's own record says it is a bot's work rather than a person's: a task's
 * worker, or a launch the server marked a chore. A bot launch from before work kinds were
 * recorded counts as a chore when it ran outside a worktree, the line the server draws today.
 * Coding a bot sends to a worktree, and anything the user promoted, stays people's work.
 */
export function isGoatBotOwnWork(thread: GoatBotVisibilityThread): boolean {
  const launcher = thread.source.launchedBy;
  if (launcher?.kind === "promotion") return false;
  if (isChannelWorkerThreadId(thread.id) || isRemoteChannelWorkerThreadId(thread.id)) return true;
  if (launcher?.kind !== "launch" || launcher.via === "delegate_task") return false;
  if (launcher.workKind !== undefined) return launcher.workKind === "chore";
  return (
    thread.id.startsWith(CHANNEL_CHILD_WORK_THREAD_PREFIX) &&
    thread.worktreePath === null &&
    isGoatBotLaunch(launcher)
  );
}

/**
 * The threads a bot's rows open that are its own work: each task's worker and every launch the
 * server marked a chore. Coding launches and unmarked ones stay people's work; a chore on
 * another machine leaves lists by that machine's own record.
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

/** Whether a thread's own launcher record names the launch a remote Home link came from. */
const recordsLaunchFrom = (
  thread: GoatBotVisibilityThread,
  from: NonNullable<HomeCurrentOpenableLink["launchedFrom"]>,
) => {
  const launcher = thread.source.launchedBy;
  return (
    launcher?.kind === "launch" &&
    launcher.via === "ssh_thread_launch" &&
    launcher.environmentId === from.environmentId &&
    launcher.threadId === from.threadId
  );
};

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
 * Scoped keys of the threads lists leave to GOAT Bot: its conversation threads, its own work by
 * the thread's record (see isGoatBotOwnWork), whatever its rows or Home list now, and every
 * subagent or delegated child below them. Search and Show GOAT Bot threads still reach them.
 */
export function goatBotObservationThreadKeys(input: {
  readonly threads: ReadonlyArray<GoatBotVisibilityThread>;
  readonly listedWork?: ReadonlyArray<GoatBotWorkRef>;
  readonly homeWork?: ReadonlyArray<HomeCurrentOpenableLink>;
}): ReadonlySet<string> {
  const listed = new Set(
    (input.listedWork ?? []).map((ref) => keyOf(ref.environmentId, ref.threadId)),
  );
  // A remote Home link hides only when the thread's own launcher names the launch it came from.
  const home = new Map<
    string,
    Array<NonNullable<HomeCurrentOpenableLink["launchedFrom"]>> | null
  >();
  for (const link of input.homeWork ?? []) {
    const key = keyOf(link.environmentId, link.threadId);
    if (link.kind !== "remote") home.set(key, null);
    else if (link.launchedFrom !== undefined && home.get(key) !== null)
      home.set(key, [...(home.get(key) ?? []), link.launchedFrom]);
  }
  const isListed = (key: string, thread: GoatBotVisibilityThread) => {
    const current = home.get(key);
    return (
      listed.has(key) ||
      current === null ||
      (current !== undefined && current.some((from) => recordsLaunchFrom(thread, from)))
    );
  };
  const seeds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  const loaded = new Set(input.threads.map((thread) => keyOf(thread.environmentId, thread.id)));
  for (const thread of input.threads) {
    const key = keyOf(thread.environmentId, thread.id);
    if (
      isGoatBotConversationThreadId(thread.id) ||
      isGoatBotOwnWork(thread) ||
      (isListed(key, thread) && thread.source.launchedBy?.kind !== "promotion")
    ) {
      seeds.add(key);
      continue;
    }
    if (isVisibleWork(thread)) continue;
    for (const parent of observedParents(thread)) {
      const parentKey = keyOf(parent.environmentId, parent.threadId);
      // A conversation or worker parent not loaded here is known by its id; a loaded one decides
      // for itself, so a worker the user promoted keeps its children.
      if (!loaded.has(parentKey) && isGoatBotThreadId(parent.threadId)) seeds.add(parentKey);
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
