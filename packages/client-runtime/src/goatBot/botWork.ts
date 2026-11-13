import {
  isGoatBotConversationThreadId,
  type BotRemoteWork,
  type BotThreadRow,
  type ChannelChildWork,
  type ChannelTaskId,
  type ChannelChildWorkGroup,
  type EnvironmentId,
  type ThreadId,
} from "@goat/contracts";

export interface BotWorkTask {
  readonly row: Extract<BotThreadRow, { readonly kind: "task" }>;
  readonly subagents: ReadonlyArray<{
    readonly childWorkId: ChannelChildWork["childWorkId"];
    readonly state: ChannelChildWork["state"];
    readonly label: string;
    readonly host?: string;
    readonly destinationHint?: string;
  }>;
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }>;
  /** Threads it launched on other machines; resolveRemoteBotWork says which can be opened. */
  readonly remote: ReadonlyArray<BotRemoteWork>;
  readonly truncated: boolean;
}

export function groupBotWork(
  rows: ReadonlyArray<BotThreadRow>,
  groups: ReadonlyArray<ChannelChildWorkGroup>,
  environmentId: EnvironmentId,
  remoteWork: ReadonlyArray<BotRemoteWork> = [],
): { readonly inProgress: ReadonlyArray<BotWorkTask>; readonly done: ReadonlyArray<BotWorkTask> } {
  const groupByTask = new Map(groups.map((group) => [group.taskId, group]));
  const inProgress: BotWorkTask[] = [];
  const done: BotWorkTask[] = [];
  for (const row of rows) {
    if (row.kind !== "task") continue;
    const group = groupByTask.get(row.task.taskId);
    const subagents: BotWorkTask["subagents"][number][] = [];
    const threads: BotWorkTask["threads"][number][] = [];
    const seen = new Set<string>();
    const addThread = (env: EnvironmentId, threadId: ThreadId) => {
      const key = JSON.stringify([env, threadId]);
      if (!seen.has(key)) {
        seen.add(key);
        threads.push({ environmentId: env, threadId });
      }
    };
    // Lists leave the worker to the bot, so its task opens it; a bot turn's worker is the chat.
    if (row.worker !== undefined && !isGoatBotConversationThreadId(row.worker.threadId))
      addThread(row.worker.environmentId, row.worker.threadId);
    for (const coding of rows) {
      if (coding.kind === "coding" && coding.taskId === row.task.taskId)
        addThread(coding.environmentId, coding.threadId);
    }
    for (const child of group?.children ?? []) {
      if (child.surface === "delegate_local" || child.surface === "delegate_remote") {
        subagents.push({
          childWorkId: child.childWorkId,
          state: child.state,
          label: child.state === "unknown" ? "uncertain" : child.state,
          ...(child.destination?.host === undefined ? {} : { host: child.destination.host }),
          ...(child.destinationHint === undefined
            ? {}
            : { destinationHint: child.destinationHint }),
        });
      } else if (child.surface === "thread_launch" && child.destination?.threadId !== undefined) {
        addThread(environmentId, child.destination.threadId);
      }
    }
    const remote = remoteWork.filter((item) => item.taskId === row.task.taskId);
    const task = { row, subagents, threads, remote, truncated: group?.truncated ?? false };
    (row.view.doneAt !== null || ["completed", "failed", "cancelled"].includes(row.task.status)
      ? done
      : inProgress
    ).push(task);
  }
  return { inProgress, done };
}

/** A bot's Home work, in the order Home shows it: going, then waiting on a person, then finished. */
export interface BotHomeWork {
  readonly running: ReadonlyArray<BotWorkTask>;
  readonly waiting: ReadonlyArray<BotWorkTask>;
  readonly finished: ReadonlyArray<BotWorkTask>;
}

/** Newest activity first, which is the order the server's list is already in. */
const byActivity = (a: BotWorkTask, b: BotWorkTask) =>
  Date.parse(b.row.lastActivityAt) - Date.parse(a.row.lastActivityAt);

/**
 * Home's Work groups. A task a person marked done is finished whatever its run says, and a task
 * whose worker asks for an answer waits. Running is newest first; finished keeps the server's
 * order, so recent work reads top to bottom.
 */
export function botHomeWork(
  rows: ReadonlyArray<BotThreadRow>,
  groups: ReadonlyArray<ChannelChildWorkGroup>,
  environmentId: EnvironmentId,
  remoteWork: ReadonlyArray<BotRemoteWork> = [],
): BotHomeWork {
  const work = groupBotWork(rows, groups, environmentId, remoteWork);
  const running: BotWorkTask[] = [];
  const waiting: BotWorkTask[] = [];
  for (const task of [...work.inProgress].sort(byActivity)) {
    if (task.row.view.doneAt === null && task.row.task.status === "waiting_input")
      waiting.push(task);
    else running.push(task);
  }
  return { running, waiting, finished: work.done };
}

/** Finished work past this many rows waits behind Show more. */
export const COLLAPSED_FINISHED = 5;

/** Whether a task's row now sits behind Show more, so a view opens the list to give it focus. */
export function workRowCollapsed(
  rows: ReadonlyArray<BotThreadRow>,
  environmentId: EnvironmentId,
  remoteWork: ReadonlyArray<BotRemoteWork>,
  taskId: ChannelTaskId,
): boolean {
  return botHomeWork(rows, [], environmentId, remoteWork)
    .finished.slice(COLLAPSED_FINISHED)
    .some((task) => task.row.task.taskId === taskId);
}

/** A refusal that reading again cannot change, so no retry is offered for it. */
export function accessDenied(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    (failure as { readonly _tag?: unknown })._tag === "EnvironmentAuthorizationError"
  );
}
