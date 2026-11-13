import type { BotWorkTask } from "@goat/client-runtime/goatBot";
import type { BotThreadRow, EnvironmentId, ThreadId } from "@goat/contracts";
import { Pressable, Text } from "react-native";
import type { MobileBotHomeItem } from "./MobileBotTaskList";
import { MobileBotRemoteWork } from "./MobileBotRemoteWork";

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
  openThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}): MobileBotHomeItem[] {
  const { entry, openThread } = props;
  const closed = !props.openable;
  const id = entry.row.task.taskId;
  const items: MobileBotHomeItem[] = [
    ...entry.threads.map((thread) => ({
      key: JSON.stringify(["task-detail", id, "thread", thread.environmentId, thread.threadId]),
      render: () => {
        const coding = props.rows.find(
          (row) =>
            row.kind === "coding" &&
            row.environmentId === thread.environmentId &&
            row.threadId === thread.threadId,
        );
        const title = coding?.kind === "coding" ? coding.title || "GOAT thread" : null;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              title === null ? "Work thread: " + entry.row.task.title : "GOAT thread: " + title
            }
            accessibilityState={{ disabled: closed }}
            disabled={closed}
            onPress={() => openThread({ environmentId: thread.environmentId, id: thread.threadId })}
            className="min-h-[44px] justify-center"
          >
            <Text numberOfLines={1} className="text-foreground underline">
              {title ?? "Open work thread"}
            </Text>
          </Pressable>
        );
      },
    })),
    ...entry.remote.map((item) => ({
      key: JSON.stringify(["task-detail", id, "remote", item.childWorkId]),
      render: () => <MobileBotRemoteWork item={item} onOpenThread={openThread} disabled={closed} />,
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
