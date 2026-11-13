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
  /** A task only the conversation still shows, or an older one, opens its own screen. */
  readonly onOpenTask: (id: ChannelTaskId, title?: string) => void;
  readonly onOpenThread: (thread: ThreadSelection) => void;
  readonly onUpdate: (input: ChannelUpdateTaskViewInput) => void;
  /** The last read failed: an empty list then says nothing about whether work exists. */
  readonly failed?: boolean;
  /** Older work read behind Show more; absent where Home does not walk history. */
  readonly history?: MobileBotHomeHistory | undefined;
}): ReadonlyArray<MobileBotHomeItem> {
  const history = props.history;
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
                next={`Ask ${props.botName} in chat to start work.${history?.supported ? "" : " Unpinned tasks that finished more than three days ago aren't listed here."}`}
              />
            ),
          },
          // Older work can still be read behind Show more when nothing recent is listed.
          ...historyTail(props, 0),
        ];
  }
  const act = (row: TaskRow, action: string) => {
    if (action === "pin") props.onUpdate({ taskId: row.task.taskId, pinned: !row.view.pinnedAt });
    if (action === "done") props.onUpdate({ taskId: row.task.taskId, done: !row.view.doneAt });
    if (action === "read")
      props.onUpdate({ taskId: row.task.taskId, readThrough: row.lastActivityAt });
  };
  const openable = props.openable ?? true;
  // A row the current list does not hold came from older work: it offers Show work, Open and Pin.
  const older = (row: TaskRow) =>
    history?.supported === true && !history.currentTaskIds.has(row.task.taskId);
  // The row menu and the open control's assistive actions offer the same choices.
  const actions = (row: TaskRow) => [
    { id: "work", title: props.expanded.has(row.task.taskId) ? "Hide work" : "Show work" },
    ...(older(row)
      ? openable
        ? [
            { id: "open", title: "Open" },
            { id: "pin", title: "Pin", attributes: { disabled: !props.canUpdate } },
          ]
        : []
      : props.canUpdate
        ? [
            { id: "pin", title: row.view.pinnedAt ? "Unpin" : "Pin" },
            { id: "done", title: row.view.doneAt ? "Reopen" : "Mark done" },
            ...(row.unread ? [{ id: "read", title: "Mark read" }] : []),
          ]
        : []),
  ];
  const choose = (row: TaskRow, id: string) => {
    if (id === "work") props.onToggleExpanded(row.task.taskId);
    else if (older(row)) {
      if (id === "open" && openable) props.onOpenTask(row.task.taskId, row.task.title);
      // Pinning an older task only refreshes the list; the pinned task then comes from it.
      if (id === "pin" && props.canUpdate)
        props.onUpdate({ taskId: row.task.taskId, pinned: true });
    } else if (props.canUpdate) act(row, id);
  };
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
                accessibilityActions={actions(row)
                  .filter(
                    (action) => !("attributes" in action && action.attributes?.disabled === true),
                  )
                  .map((action) => ({ name: action.id, label: action.title }))}
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
      if (history?.launchesTruncated.has(row.task.taskId))
        items.push({
          key: JSON.stringify(["task-truncated", row.task.taskId]),
          render: () => (
            <Text className="pb-2 pl-6 text-xs text-foreground-muted">
              Some threads are listed in Threads.
            </Text>
          ),
        });
      if (props.expanded.has(row.task.taskId)) items.push(...props.details(row.task.taskId));
    }
  }
  items.push(...historyTail(props, props.work.finished.length));
  if (others.length > 0) items.push(label("section:other", "Other threads"));
  for (const row of others) {
    items.push({
      key: JSON.stringify(["thread", row.environmentId, row.threadId]),
      render: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={"GOAT thread: " + (row.title || "GOAT thread")}
          accessibilityState={{ disabled: !openable }}
          disabled={!openable}
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
          disabled={!openable}
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

/** What Home's older-work walk tells the list. */
export interface MobileBotHomeHistory {
  readonly supported: boolean;
  readonly currentTaskIds: ReadonlySet<ChannelTaskId>;
  readonly launchesTruncated: ReadonlySet<ChannelTaskId>;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly incomplete: boolean;
  readonly failed: boolean;
  readonly onLoadMore: () => void;
}

/**
 * The two older-work notices, then one Show more entry: it reads older work while history can
 * continue, and otherwise shows or hides finished tasks past the first five. The entry keeps one
 * key either way, so the row a person pressed stays the same row.
 */
function historyTail(
  props: {
    readonly history?: MobileBotHomeHistory | undefined;
    readonly showAllFinished: boolean;
    readonly onToggleFinished: () => void;
  },
  finished: number,
): MobileBotHomeItem[] {
  const history = props.history;
  const items: MobileBotHomeItem[] = [];
  if (history?.incomplete)
    items.push({
      key: "history-incomplete",
      render: () => (
        <Text className="py-2 text-xs text-foreground-muted">Older work may be missing</Text>
      ),
    });
  if (history?.failed)
    items.push({
      key: "history-failed",
      render: () => (
        <Text className="py-2 text-xs text-foreground-muted">Couldn't load older work.</Text>
      ),
    });
  const continues = history?.hasMore === true;
  if (continues || finished > COLLAPSED_FINISHED)
    items.push({
      key: "finished-toggle",
      render: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: continues && history?.loading === true }}
          onPress={() => {
            if (!continues) return props.onToggleFinished();
            if (history?.loading) return;
            if (!props.showAllFinished) props.onToggleFinished();
            history?.onLoadMore();
          }}
          className="min-h-[44px] items-center justify-center"
        >
          <Text className="text-foreground">
            {continues || !props.showAllFinished ? "Show more" : "Show less"}
          </Text>
        </Pressable>
      ),
    });
  return items;
}
