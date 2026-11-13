import type { BotWorkTask } from "@goat/client-runtime/goatBot";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { Pressable, Text } from "react-native";
import type { MobileBotHomeItem } from "./MobileBotTaskList";
import { MobileBotRemoteWork } from "./MobileBotRemoteWork";

export function mobileBotWorkDetails(props: {
  entry: BotWorkTask;
  supported: boolean;
  error: string | null;
  pending: boolean;
  hasData: boolean;
  openThread: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}): MobileBotHomeItem[] {
  const { entry, openThread } = props;
  const id = entry.row.task.taskId;
  const items: MobileBotHomeItem[] = [
    ...entry.threads.map((thread) => ({
      key: JSON.stringify(["task-detail", id, "thread", thread.environmentId, thread.threadId]),
      render: () => (
        <Pressable
          accessibilityRole="button"
          onPress={() => openThread({ environmentId: thread.environmentId, id: thread.threadId })}
          className="min-h-[44px] justify-center"
        >
          <Text className="text-foreground underline">Open work thread</Text>
        </Pressable>
      ),
    })),
    ...entry.remote.map((item) => ({
      key: JSON.stringify(["task-detail", id, "remote", item.childWorkId]),
      render: () => <MobileBotRemoteWork item={item} onOpenThread={openThread} />,
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
  else if (supported && !props.hasData && props.pending)
    items.push({
      key: JSON.stringify(["task-detail-status", id]),
      render: () => <Text className="text-foreground-muted">Loading work…</Text>,
    });
  else if (entry.truncated)
    items.push({
      key: JSON.stringify(["task-detail-status", id]),
      render: () => <Text className="text-foreground-muted">More work is available.</Text>,
    });
  return items;
}
