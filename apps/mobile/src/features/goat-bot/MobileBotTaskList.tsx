import {
  presentTaskStatus,
  type BotWorkTask,
  type GoatBotTaskCard,
} from "@goat/client-runtime/goatBot";
import type {
  BotThreadRow,
  ChannelTaskId,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import type { ReactNode } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GoatBotTaskRow } from "./GoatBotTaskRow";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

type ThreadSelection = { readonly environmentId: EnvironmentId; readonly id: ThreadId };
type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
/** One entry of the bot's Home list, which mounts only the entries near the screen. */
export interface MobileBotHomeItem {
  readonly key: string;
  readonly node: ReactNode;
}

/** The words a task row says and VoiceOver reads: title, status, then unread and pinned. */
export function mobileBotTaskLabel(row: TaskRow): string {
  const status = presentTaskStatus(row.task.status, row.view.doneAt).label;
  return `${row.task.title}, ${status}${row.unread ? ", unread" : ""}${row.view.pinnedAt ? ", pinned" : ""}`;
}

/**
 * The only list of the work a bot started, as Home list entries: its tasks with their state and
 * actions, coding threads no listed task owns, and tasks the conversation still shows that the
 * server no longer lists.
 */
export function mobileBotTaskListItems(props: {
  readonly botName: string;
  readonly work: {
    readonly inProgress: ReadonlyArray<BotWorkTask>;
    readonly done: ReadonlyArray<BotWorkTask>;
  };
  readonly rows: ReadonlyArray<BotThreadRow>;
  /** Task cards in the conversation; ones the list lacks show under "Earlier in chat". */
  readonly chatTasks: ReadonlyArray<GoatBotTaskCard>;
  /** A listed task opens its peek on the bot's home. */
  readonly onPeekTask: (id: ChannelTaskId) => void;
  /** A task only the conversation still shows opens its own conversation. */
  readonly onOpenTask: (id: ChannelTaskId) => void;
  readonly onOpenThread: (thread: ThreadSelection) => void;
  readonly onUpdate: (input: ChannelUpdateTaskViewInput) => void;
  /** The last read failed: an empty list then says nothing about whether work exists. */
  readonly failed?: boolean;
}): ReadonlyArray<MobileBotHomeItem> {
  const listed = new Set(
    [...props.work.inProgress, ...props.work.done].map((entry) => String(entry.row.task.taskId)),
  );
  const others = props.rows.filter(
    (row): row is Extract<BotThreadRow, { kind: "coding" }> =>
      row.kind === "coding" && !listed.has(String(row.taskId)),
  );
  const earlier = props.chatTasks.filter((card) => !listed.has(card.key));
  if (listed.size + others.length + earlier.length === 0) {
    return props.failed
      ? []
      : [
          {
            key: "tasks-empty",
            node: (
              <MobileBotPanelEmpty
                title="No tasks yet"
                next={`Ask ${props.botName} in chat to start work.`}
              />
            ),
          },
        ];
  }
  const act = (row: TaskRow, action: string) => {
    if (action === "pin") props.onUpdate({ taskId: row.task.taskId, pinned: !row.view.pinnedAt });
    if (action === "done") props.onUpdate({ taskId: row.task.taskId, done: !row.view.doneAt });
    if (action === "read")
      props.onUpdate({ taskId: row.task.taskId, readThrough: row.lastActivityAt });
  };
  const menu = (row: TaskRow) =>
    Alert.alert(row.task.title, undefined, [
      { text: row.view.pinnedAt ? "Unpin" : "Pin", onPress: () => act(row, "pin") },
      { text: row.view.doneAt ? "Reopen" : "Mark done", onPress: () => act(row, "done") },
      { text: "Mark read", onPress: () => act(row, "read") },
      { text: "Cancel", style: "cancel" },
    ]);
  const label = (key: string, text: string): MobileBotHomeItem => ({
    key,
    node: <Text className="pt-2 font-semibold text-foreground">{text}</Text>,
  });
  const items: MobileBotHomeItem[] = [];
  for (const [section, tasks] of [
    ["In progress", props.work.inProgress],
    ["Done", props.work.done],
  ] as const) {
    if (tasks.length === 0) continue;
    items.push(label(`section:${section}`, section));
    for (const { row, threads } of tasks) {
      items.push({
        key: `task:${row.task.taskId}`,
        node: (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mobileBotTaskLabel(row)}
              accessibilityActions={[
                { name: "pin", label: row.view.pinnedAt ? "Unpin" : "Pin" },
                { name: "done", label: row.view.doneAt ? "Reopen" : "Mark done" },
                { name: "read", label: "Mark read" },
              ]}
              onAccessibilityAction={(event) => act(row, event.nativeEvent.actionName)}
              onLongPress={() => menu(row)}
              className="min-h-[44px] justify-center"
              onPress={() => props.onPeekTask(row.task.taskId)}
            >
              <Text className="text-foreground">{row.task.title}</Text>
              <View className="flex-row items-center gap-1">
                {row.view.pinnedAt ? (
                  <SymbolView name="pin" size={12} tintColorClassName="accent-foreground-muted" />
                ) : null}
                {row.unread ? (
                  <View
                    accessibilityElementsHidden
                    className="h-2 w-2 rounded-full bg-adaptive-blue-500-400"
                  />
                ) : null}
                <Text className="text-xs text-foreground-muted">
                  {presentTaskStatus(row.task.status, row.view.doneAt).label}
                  {row.unread ? " · Unread" : ""}
                </Text>
              </View>
            </Pressable>
            {threads.map((thread) => {
              const coding = props.rows.find(
                (candidate) =>
                  candidate.kind === "coding" &&
                  candidate.environmentId === thread.environmentId &&
                  candidate.threadId === thread.threadId,
              );
              const title = coding?.kind === "coding" ? coding.title || "GOAT thread" : null;
              return (
                <Pressable
                  key={thread.environmentId + ":" + thread.threadId}
                  accessibilityRole="button"
                  accessibilityLabel={
                    title === null ? "Work thread: " + row.task.title : "GOAT thread: " + title
                  }
                  className="ml-4 min-h-[44px] justify-center"
                  onPress={() =>
                    props.onOpenThread({ environmentId: thread.environmentId, id: thread.threadId })
                  }
                >
                  <Text numberOfLines={1} className="text-foreground-muted">
                    {title ?? "Work thread"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ),
      });
    }
  }
  if (others.length > 0) items.push(label("section:other", "Other threads"));
  for (const row of others) {
    items.push({
      key: `thread:${row.environmentId}:${row.threadId}`,
      node: (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={"GOAT thread: " + (row.title || "GOAT thread")}
          className="min-h-[44px] justify-center"
          onPress={() => props.onOpenThread({ environmentId: row.environmentId, id: row.threadId })}
        >
          <Text numberOfLines={1} className="text-foreground">
            {row.title || "GOAT thread"}
          </Text>
        </Pressable>
      ),
    });
  }
  if (earlier.length > 0) items.push(label("section:earlier", "Earlier in chat"));
  for (const card of earlier) {
    items.push({
      key: `earlier:${card.key}`,
      node: (
        <GoatBotTaskRow
          card={card}
          onSelectThread={(thread) =>
            props.onOpenThread({ environmentId: thread.environmentId, id: thread.id })
          }
          onOpenTask={() => props.onOpenTask(card.key as ChannelTaskId)}
        />
      ),
    });
  }
  return items;
}
