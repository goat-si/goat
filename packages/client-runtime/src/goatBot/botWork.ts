import {
  isGoatBotConversationThreadId,
  type BotRemoteWork,
  type BotThreadRow,
  type ChannelChildWork,
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
