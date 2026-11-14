import {
  isGoatBotConversationThreadId,
  type BotRemoteWork,
  type BotThreadRow,
  type EnvironmentId,
  type OrchestrationV2ThreadLauncher,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { resolveRemoteBotWork } from "./remoteWork.ts";
import type { HomeCurrentOpenableLink } from "./homeCurrentOpenableWork.ts";

export interface GoatBotVisibilityThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
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
  /**
   * Set for a chore on another machine: that machine's own record must name this launcher, so
   * a thread the origin cannot vouch for, such as one an older GOAT recorded without its work
   * kind, stays in lists.
   */
  readonly launchedFrom?: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
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
 * server marked a chore, including chores on other machines this client can open. Coding
 * launches and unmarked ones stay people's work.
 */
export function goatBotListedWork(
  rows: ReadonlyArray<BotThreadRow>,
  remote?: {
    /** The environment whose rows these are, where the bot's launching threads live. */
    readonly originEnvironmentId: EnvironmentId;
    readonly items: ReadonlyArray<BotRemoteWork>;
    readonly isOpenable: (environmentId: EnvironmentId) => boolean;
  },
): GoatBotWorkRef[] {
  const listed: GoatBotWorkRef[] = [];
  for (const row of rows) {
    if (row.kind === "task") {
      if (row.worker !== undefined) listed.push(row.worker);
    } else if (row.workKind === "chore") {
      listed.push({ environmentId: row.environmentId, threadId: row.threadId });
    }
  }
  if (remote === undefined) return listed;
  for (const item of remote.items) {
    if (item.workKind !== "chore") continue;
    const target = resolveRemoteBotWork(item, remote.isOpenable);
    if (target.kind !== "open") continue;
    listed.push({
      ...target.ref,
      launchedFrom: { environmentId: remote.originEnvironmentId, threadId: item.callerThreadId },
    });
  }
  return listed;
}

/** Whether a thread's own launcher record names the launch a remote chore came from. */
const recordsLaunchFrom = (
  thread: GoatBotVisibilityThread,
  from: NonNullable<GoatBotWorkRef["launchedFrom"]>,
  requireChore = true,
) => {
  const launcher = thread.source.launchedBy;
  return (
    launcher?.kind === "launch" &&
    launcher.via === "ssh_thread_launch" &&
    (!requireChore || launcher.workKind === "chore") &&
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
 * Scoped keys of the threads lists leave to GOAT Bot: its conversation threads, the work its
 * rows list (so the bot can always open what is hidden), and every subagent or delegated child
 * below them. Work no row lists yet, or any more, stays in lists.
 */
export function goatBotObservationThreadKeys(input: {
  readonly threads: ReadonlyArray<GoatBotVisibilityThread>;
  readonly listedWork?: ReadonlyArray<GoatBotWorkRef>;
  readonly homeWork?: ReadonlyArray<HomeCurrentOpenableLink>;
}): ReadonlySet<string> {
  // A listed key with launch requirements hides only when the thread meets one of them.
  const listed = new Map<string, Array<NonNullable<GoatBotWorkRef["launchedFrom"]>> | null>();
  for (const ref of input.listedWork ?? []) {
    const key = keyOf(ref.environmentId, ref.threadId);
    const current = listed.get(key);
    if (ref.launchedFrom === undefined || current === null) listed.set(key, null);
    else listed.set(key, [...(current ?? []), ref.launchedFrom]);
  }
  const home = new Map<string, Array<NonNullable<GoatBotWorkRef["launchedFrom"]>> | null>();
  for (const link of input.homeWork ?? []) {
    const key = keyOf(link.environmentId, link.threadId);
    if (link.kind !== "remote") home.set(key, null);
    else if (link.launchedFrom !== undefined && home.get(key) !== null)
      home.set(key, [...(home.get(key) ?? []), link.launchedFrom]);
  }
  const isListed = (key: string, thread: GoatBotVisibilityThread) => {
    const current = home.get(key);
    if (
      current === null ||
      (current !== undefined && current.some((from) => recordsLaunchFrom(thread, from, false)))
    )
      return true;
    const requirements = listed.get(key);
    return (
      requirements === null ||
      (requirements !== undefined && requirements.some((from) => recordsLaunchFrom(thread, from)))
    );
  };
  const seeds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  for (const thread of input.threads) {
    const key = keyOf(thread.environmentId, thread.id);
    if (
      isGoatBotConversationThreadId(thread.id) ||
      (isListed(key, thread) && thread.source.launchedBy?.kind !== "promotion")
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
