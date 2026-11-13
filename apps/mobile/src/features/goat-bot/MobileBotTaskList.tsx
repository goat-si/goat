import {
  presentTaskStatus,
  type BotHomeWork,
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
import { COLLAPSED_FINISHED } from "./mobileBotWorkShared";

type ThreadSelection = { readonly environmentId: EnvironmentId; readonly id: ThreadId };
type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
/** One entry of the bot's Home list, which mounts only the entries near the screen. */
export interface MobileBotHomeItem {
  readonly key: string;
  readonly card?: "only" | "first" | "middle" | "last";
  /** Builds the entry when the list mounts it, so off-screen entries cost nothing. */
  readonly render: () => ReactNode;
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
  readonly work: BotHomeWork;
  readonly showAllFinished: boolean;
  readonly onToggleFinished: () => void;
  readonly expanded: ReadonlySet<ChannelTaskId>;
  readonly onToggleExpanded: (id: ChannelTaskId) => void;
  readonly canUpdate: boolean;
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
    [...props.work.running, ...props.work.waiting, ...props.work.finished].map((entry) =>
      String(entry.row.task.taskId),
    ),
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
            render: () => (
              <MobileBotPanelEmpty
                title="No recent tasks"
                next={`Ask ${props.botName} in chat to start work. Unpinned tasks that finished more than three days ago aren't listed here.`}
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
      {
        text: props.expanded.has(row.task.taskId) ? "Hide work" : "Show work",
        onPress: () => props.onToggleExpanded(row.task.taskId),
      },
      ...(props.canUpdate
        ? [
            { text: row.view.pinnedAt ? "Unpin" : "Pin", onPress: () => act(row, "pin") },
            { text: row.view.doneAt ? "Reopen" : "Mark done", onPress: () => act(row, "done") },
            ...(row.unread ? [{ text: "Mark read", onPress: () => act(row, "read") }] : []),
          ]
        : []),
      { text: "Cancel", style: "cancel" },
    ]);
  const label = (key: string, text: string): MobileBotHomeItem => ({
    key,
    render: () => <Text className="pt-2 font-semibold text-foreground">{text}</Text>,
  });
  const items: MobileBotHomeItem[] = [];
  for (const [section, tasks] of [
    ["running", props.work.running],
    ["waiting", props.work.waiting],
    [
      "finished",
      props.showAllFinished
        ? props.work.finished
        : props.work.finished.slice(0, COLLAPSED_FINISHED),
    ],
  ] as const) {
    for (const { row } of tasks) {
      items.push({
        key: JSON.stringify(["task", row.task.taskId]),
        render: () => (
          <View className="flex-row items-center">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mobileBotTaskLabel(row)}
              accessibilityActions={[
                { name: "pin", label: row.view.pinnedAt ? "Unpin" : "Pin" },
                { name: "done", label: row.view.doneAt ? "Reopen" : "Mark done" },
                { name: "read", label: "Mark read" },
              ]}
              onAccessibilityAction={(event) => {
                if (props.canUpdate) act(row, event.nativeEvent.actionName);
              }}
              onLongPress={() => menu(row)}
              className="min-h-[44px] flex-1 flex-row items-center gap-2"
              onPress={() => props.onPeekTask(row.task.taskId)}
            >
              {section === "running" ? (
                <View className="h-2 w-2 rounded-full bg-adaptive-blue-500-400" />
              ) : (
                <SymbolView
                  name={section === "waiting" ? "questionmark.bubble" : "checkmark"}
                  size={14}
                  tintColorClassName={
                    section === "waiting" ? "accent-warning-foreground" : "accent-foreground-muted"
                  }
                />
              )}
              <View className="flex-1">
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
              </View>
              <SymbolView
                name="chevron.right"
                size={14}
                tintColorClassName="accent-foreground-muted"
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Actions for ${row.task.title}`}
              onPress={() => menu(row)}
              className="h-11 w-11 items-center justify-center"
            >
              <Text className="text-foreground-muted">…</Text>
            </Pressable>
          </View>
        ),
      });
    }
    if (section === "finished" && props.work.finished.length > COLLAPSED_FINISHED) {
      items.push({
        key: "finished-toggle",
        render: () => (
          <Pressable
            accessibilityRole="button"
            onPress={props.onToggleFinished}
            className="min-h-[44px] items-center justify-center"
          >
            <Text className="text-foreground">
              {props.showAllFinished ? "Show less" : "Show more"}
            </Text>
          </Pressable>
        ),
      });
    }
  }
  if (others.length > 0) items.push(label("section:other", "Other threads"));
  for (const row of others) {
    items.push({
      key: JSON.stringify(["thread", row.environmentId, row.threadId]),
      render: () => (
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
      key: JSON.stringify(["earlier", card.key]),
      render: () => (
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
