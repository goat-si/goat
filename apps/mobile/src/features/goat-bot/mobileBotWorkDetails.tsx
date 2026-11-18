import type { BotWorkTask, HomeCurrentOpenableLink } from "@goat/client-runtime/goatBot";
import type { BotThreadRow, BotWorkResult, EnvironmentId, ThreadId } from "@goat/contracts";
import { Text } from "react-native";
import type { MobileBotHomeItem } from "./MobileBotTaskList";
import { MobileBotRemoteWork } from "./MobileBotRemoteWork";
import { MobileWorkThreadLink } from "./MobileWorkThreadLink";

const workThreadName = (title: string | undefined) => title?.trim() || "Open work thread";
const threadKey = (thread: { environmentId: EnvironmentId; threadId: ThreadId }) =>
  JSON.stringify([thread.environmentId, thread.threadId]);

type WorkThread = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
/**
 * A task's work thread as a link: a coding thread by its title (as on web), else a plain label.
 * The worker and a thread with no coding row are named after the task to a screen reader.
 */
export function workThreadLink(input: {
  thread: WorkThread;
  worker: WorkThread | undefined;
  rows: ReadonlyArray<BotThreadRow | BotWorkResult["codingRows"][number]>;
  taskTitle: string;
}) {
  const { thread, worker } = input;
  const isWorker =
    worker?.environmentId === thread.environmentId && worker.threadId === thread.threadId;
  const coding = isWorker
    ? undefined
    : input.rows.find(
        (row) =>
          row.kind === "coding" &&
          row.environmentId === thread.environmentId &&
          row.threadId === thread.threadId,
      );
  if (coding?.kind !== "coding")
    return { text: "Open work thread", label: "Work thread: " + input.taskTitle };
  const text = workThreadName(coding.title);
  return { text, label: "GOAT thread: " + text };
}

export function mobileBotWorkDetails(props: {
  entry: BotWorkTask;
  /** The bot list's rows, which carry each coding thread's title. */
  rows: ReadonlyArray<BotThreadRow>;
  /** Offline, the work stays listed but nothing opens, as with the task rows. */
  openable: boolean;
  supported: boolean;
  error: string | null;
  pending: boolean;
  /** How many children the read returned for this task; null when it left the task out. */
  groupChildren: number | null;
  /**
   * For a task in the bot's current list, the links Home's shared value opens for it (the same
   * value that hides those threads from Threads); null for older work or before that list is read.
   */
  currentLinks?: ReadonlyArray<HomeCurrentOpenableLink> | null;
  openThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}): MobileBotHomeItem[] {
  const { entry, openThread } = props;
  const closed = !props.openable;
  const id = entry.row.task.taskId;
  const currentLinks = props.currentLinks ?? null;
  const worker = entry.row.worker;
  // The list's own threads for the task; anything else in entry.threads came from the child read.
  const listed = new Set(
    [
      ...(worker === undefined ? [] : [worker]),
      ...props.rows.flatMap((row) => (row.kind === "coding" && row.taskId === id ? [row] : [])),
      ...(currentLinks ?? []),
    ].map(threadKey),
  );
  const threads =
    currentLinks === null
      ? entry.threads
      : [
          ...currentLinks.filter((link) => link.kind !== "remote"),
          ...entry.threads.filter((thread) => !listed.has(threadKey(thread))),
        ];
  const items: MobileBotHomeItem[] = [
    ...threads.map((thread) => ({
      key: JSON.stringify(["task-detail", id, "thread", thread.environmentId, thread.threadId]),
      render: () => (
        <MobileWorkThreadLink
          link={workThreadLink({
            thread,
            worker,
            rows: props.rows,
            taskTitle: entry.row.task.title,
          })}
          disabled={closed}
          onPress={() => openThread({ environmentId: thread.environmentId, id: thread.threadId })}
        />
      ),
    })),
    ...entry.remote.map((item) => ({
      key: JSON.stringify(["task-detail", id, "remote", item.childWorkId]),
      render: () => (
        <MobileBotRemoteWork
          item={item}
          onOpenThread={openThread}
          disabled={closed}
          // A current task's remote work opens exactly when Home's shared value links it.
          {...(currentLinks === null
            ? {}
            : {
                openable: currentLinks.some(
                  (link) => link.kind === "remote" && link.remoteChildWorkId === item.childWorkId,
                ),
              })}
        />
      ),
    })),
    ...entry.subagents.map((agent) => ({
      key: JSON.stringify(["task-detail", id, "subagent", agent.childWorkId]),
      render: () => (
        <Text className="text-foreground-muted">
          {agent.host ?? agent.destinationHint ?? "Subagent"} · {agent.label}
        </Text>
      ),
    })),
  ];
  const supported = props.supported;
  // The shared child-work read has no re-read of its own, so a failure says so without a Try
  // again that could not read again; the peek and the task's own screen still list its threads.
  if (supported && props.error)
    items.push({
      key: JSON.stringify(["task-detail-status", id]),
      render: () => <Text className="text-danger-foreground">Couldn't load subagents.</Text>,
    });
  else if (supported && props.groupChildren === null && props.pending)
    items.push({
      key: JSON.stringify(["task-detail-status", id]),
      render: () => <Text className="text-foreground-muted">Loading work…</Text>,
    });
  else if (entry.truncated)
    items.push({
      key: JSON.stringify(["task-detail-status", id]),
      render: () => <Text className="text-foreground-muted">More work is available.</Text>,
    });
  else if (supported && props.groupChildren === 0 && items.length === 0)
    items.push({
      key: JSON.stringify(["task-detail-status", id]),
      render: () => <Text className="text-foreground-muted">No other work.</Text>,
    });
  return items;
}
