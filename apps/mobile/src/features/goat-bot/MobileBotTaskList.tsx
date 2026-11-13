import {
  COLLAPSED_FINISHED,
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
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GoatBotTaskRow } from "./GoatBotTaskRow";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";
import { MobileBotRowMenu } from "./MobileBotRowMenu";

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
  readonly details: (id: ChannelTaskId) => ReadonlyArray<MobileBotHomeItem>;
  readonly canUpdate: boolean;
  /** A row opens its peek only while the list can be read; offline rows stay listed but closed. */
  readonly openable?: boolean;
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
  // The row menu and the open control's assistive actions offer the same choices.
  const actions = (row: TaskRow) => [
    { id: "work", title: props.expanded.has(row.task.taskId) ? "Hide work" : "Show work" },
    ...(props.canUpdate
      ? [
          { id: "pin", title: row.view.pinnedAt ? "Unpin" : "Pin" },
          { id: "done", title: row.view.doneAt ? "Reopen" : "Mark done" },
          ...(row.unread ? [{ id: "read", title: "Mark read" }] : []),
        ]
      : []),
  ];
  const choose = (row: TaskRow, id: string) => {
    if (id === "work") props.onToggleExpanded(row.task.taskId);
    else if (props.canUpdate) act(row, id);
  };
  const openable = props.openable ?? true;
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
          <MobileBotRowMenu
            label={`Actions for ${row.task.title}`}
            title={row.task.title}
            actions={actions(row)}
            onSelect={(id) => choose(row, id)}
            row={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={mobileBotTaskLabel(row)}
                accessibilityActions={actions(row).map((action) => ({
                  name: action.id,
                  label: action.title,
                }))}
                onAccessibilityAction={(event) => choose(row, event.nativeEvent.actionName)}
                accessibilityState={{ disabled: !openable }}
                disabled={!openable}
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
                      section === "waiting"
                        ? "accent-warning-foreground"
                        : "accent-foreground-muted"
                    }
                  />
                )}
                <View className="flex-1">
                  <Text className="text-foreground">{row.task.title}</Text>
                  <View className="flex-row items-center gap-1">
                    {row.view.pinnedAt ? (
                      <SymbolView
                        name="pin"
                        size={12}
                        tintColorClassName="accent-foreground-muted"
                      />
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
            }
          />
        ),
      });
      if (props.expanded.has(row.task.taskId)) items.push(...props.details(row.task.taskId));
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

export function carded(items: ReadonlyArray<MobileBotHomeItem>): MobileBotHomeItem[] {
  return items.map((item, index) => ({
    ...item,
    card:
      items.length === 1
        ? "only"
        : index === 0
          ? "first"
          : index === items.length - 1
            ? "last"
            : "middle",
  }));
}
