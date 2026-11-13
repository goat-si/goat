import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BotThreadRow, type ChannelUpdateTaskViewInput } from "@goat/contracts";
import type { BotWorkTask, GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vite-plus/test";

const alert = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Alert: { alert },
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    onPress?: () => void;
    onLongPress?: () => void;
    disabled?: boolean;
    accessibilityState?: { disabled?: boolean };
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      aria-disabled={props.accessibilityState?.disabled}
      data-actions={props.accessibilityActions?.map((action) => action.label).join(",")}
      onClick={props.onPress}
      onContextMenu={props.onLongPress}
      onKeyDown={(event) =>
        props.onAccessibilityAction?.({ nativeEvent: { actionName: event.key } })
      }
    >
      {props.children}
    </button>
  ),
}));
// The row menu is native; this stands in for it and hands its choices to the Alert mock.
vi.mock("./MobileBotRowMenu", () => ({
  MobileBotRowMenu: (props: {
    label: string;
    title: string;
    actions: ReadonlyArray<{ id: string; title: string }>;
    onSelect: (id: string) => void;
    row?: ReactNode;
  }) => {
    const open = () =>
      alert(
        props.title,
        undefined,
        props.actions.map((action) => ({
          text: action.title,
          onPress: () => props.onSelect(action.id),
        })),
      );
    // A long press of the row opens the same menu; a context menu stands for that press.
    return (
      <>
        <div onContextMenu={open}>{props.row}</div>
        <button aria-label={props.label} onClick={open} />
      </>
    );
  },
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => <i>pin</i> }));
vi.mock("./MobileBotPanelEmpty", () => ({
  MobileBotPanelEmpty: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("./GoatBotTaskRow", () => ({
  GoatBotTaskRow: (props: {
    card: GoatBotTaskCard;
    onOpenTask?: () => void;
    disabled?: boolean;
  }) => (
    <button
      aria-label={`card:${props.card.title}`}
      disabled={props.disabled}
      onClick={props.onOpenTask}
    >
      {props.card.attentionLabel}
    </button>
  ),
}));
import { mobileBotTaskListItems } from "./MobileBotTaskList";

function TaskList(props: Parameters<typeof mobileBotTaskListItems>[0]) {
  return (
    <>
      {mobileBotTaskListItems(props).map((item) => (
        <div key={item.key}>{item.render()}</div>
      ))}
    </>
  );
}

const at = "2026-11-11T02:00:00.000Z";
const decode = Schema.decodeUnknownSync(BotThreadRow);
const task = decode({
  kind: "task",
  task: { taskId: "task-1", title: "Review", status: "waiting_input", updatedAt: at },
  view: { taskId: "task-1", pinnedAt: at, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: true,
  mainMessagesSinceQuiet: 0,
}) as Extract<BotThreadRow, { kind: "task" }>;
const coding = decode({
  kind: "coding",
  // Its task is one the server no longer lists.
  taskId: "task-gone",
  environmentId: "env",
  threadId: "thread-9",
  title: "Fix the build",
  state: "bound",
  lastActivityAt: at,
});
const listedTask: BotWorkTask = {
  row: task,
  threads: [],
  subagents: [],
  remote: [],
  truncated: false,
};
const work = (tasks: ReadonlyArray<BotWorkTask>) => ({ running: [], waiting: tasks, finished: [] });
const omitted = {
  key: "task-old",
  revision: 3,
  updatedAt: at,
  title: "Summarize the README",
  statusLabel: "Needs your input",
  tone: "attention",
  sourceLabel: null,
  summary: null,
  attentionLabel: "1 question",
  pullRequests: [],
  target: { kind: "none", label: "No thread" },
} as GoatBotTaskCard;

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  alert.mockClear();
});
async function show(props: Partial<Parameters<typeof mobileBotTaskListItems>[0]> = {}) {
  const calls = {
    open: vi.fn(),
    peek: vi.fn(),
    thread: vi.fn(),
    update: vi.fn<(input: ChannelUpdateTaskViewInput) => void>(),
  };
  root ??= createRoot(container);
  await act(async () =>
    root?.render(
      <TaskList
        botName="GOAT Bot"
        canUpdate
        expanded={new Set()}
        details={() => []}
        onToggleExpanded={() => {}}
        showAllFinished={false}
        onToggleFinished={() => {}}
        work={work([])}
        rows={[]}
        chatTasks={[]}
        onOpenTask={calls.open}
        onPeekTask={calls.peek}
        onOpenThread={calls.thread}
        onUpdate={calls.update}
        {...props}
      />,
    ),
  );
  return calls;
}

it("lists a task with its status, unread and pinned state, and the actions the bot list had", async () => {
  const calls = await show({ work: work([listedTask]), rows: [task] });
  const row = container.querySelector('[aria-label="Review, Needs your input, unread, pinned"]');
  expect(row).not.toBeNull();
  // Assistive actions are the menu's own choices.
  expect(row?.getAttribute("data-actions")).toBe("Show work,Unpin,Mark done,Mark read");
  expect(container.textContent).toContain("Needs your input · Unread");
  await act(async () =>
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: "read", bubbles: true })),
  );
  expect(calls.update).toHaveBeenLastCalledWith({ taskId: "task-1", readThrough: at });
  const actionsButton = container.querySelector('[aria-label="Actions for Review"]');
  await act(async () => (actionsButton as HTMLButtonElement).click());
  const choices = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
  expect(choices.map((choice) => choice.text)).toEqual([
    "Show work",
    "Unpin",
    "Mark done",
    "Mark read",
  ]);
  await act(async () => {
    choices[1]?.onPress?.();
    choices[2]?.onPress?.();
  });
  expect(calls.update.mock.calls.slice(-2)).toEqual([
    [{ taskId: "task-1", pinned: false }],
    [{ taskId: "task-1", done: true }],
  ]);
  // A listed task opens its peek on the bot's home, not its conversation.
  await act(async () => (row as HTMLButtonElement).click());
  expect(calls.peek).toHaveBeenCalledWith("task-1");
  expect(calls.open).not.toHaveBeenCalled();
});

it("opens the same row actions on a long press of the task, as the bot list did", async () => {
  const calls = await show({ work: work([listedTask]), rows: [task] });
  const row = container.querySelector('[aria-label="Review, Needs your input, unread, pinned"]');
  await act(async () =>
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  const choices = alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
  expect(choices.map((choice) => choice.text)).toEqual([
    "Show work",
    "Unpin",
    "Mark done",
    "Mark read",
  ]);
  await act(async () => choices[3]?.onPress?.());
  expect(calls.update).toHaveBeenLastCalledWith({ taskId: "task-1", readThrough: at });
  expect(calls.peek).not.toHaveBeenCalled();
});

it("lists coding threads no task owns under Other threads, even when there are no tasks", async () => {
  const calls = await show({ rows: [coding] });
  expect(container.textContent).toContain("Other threads");
  expect(container.textContent).not.toContain("No recent tasks");
  await act(async () =>
    (
      container.querySelector('[aria-label="GOAT thread: Fix the build"]') as HTMLButtonElement
    ).click(),
  );
  expect(calls.thread).toHaveBeenCalledWith({ environmentId: "env", id: "thread-9" });
});

it("keeps a task the conversation shows but the server no longer lists, opening its conversation", async () => {
  const calls = await show({ work: work([listedTask]), rows: [task], chatTasks: [omitted] });
  expect(container.textContent).toContain("Earlier in chat");
  expect(container.textContent).toContain("1 question");
  await act(async () =>
    (
      container.querySelector('[aria-label="card:Summarize the README"]') as HTMLButtonElement
    ).click(),
  );
  expect(calls.open).toHaveBeenCalledWith("task-old");
  expect(calls.peek).not.toHaveBeenCalled();
});

it("lists a conversation card only once when the server still lists its task", async () => {
  await show({
    work: work([listedTask]),
    rows: [task],
    chatTasks: [{ ...omitted, key: "task-1", title: "Review" }],
  });
  expect(container.textContent).not.toContain("Earlier in chat");
});

it("says there is no work yet only when nothing at all is listed", async () => {
  await show();
  expect(container.textContent).toContain("No recent tasks");
});
it("does not list a task's work threads in the card", async () => {
  const threads = [
    { environmentId: "env", threadId: "thread-3" },
  ] as unknown as BotWorkTask["threads"];
  await show({ work: work([{ ...listedTask, threads }]), rows: [task] });
  expect(container.querySelector('[aria-label="Work thread: Review"]')).toBeNull();
  expect(container.querySelectorAll('[aria-label="Actions for Review"]')).toHaveLength(1);
});

it("offline, keeps other threads and earlier chat tasks listed but closed, as task rows are", async () => {
  const calls = await show({ rows: [coding], chatTasks: [omitted], openable: false });
  const thread = container.querySelector('[aria-label="GOAT thread: Fix the build"]');
  const card = container.querySelector('[aria-label="card:Summarize the README"]');
  expect(thread?.hasAttribute("disabled")).toBe(true);
  expect(thread?.getAttribute("aria-disabled")).toBe("true");
  expect(card?.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    (thread as HTMLButtonElement).click();
    (card as HTMLButtonElement).click();
  });
  expect(calls.thread).not.toHaveBeenCalled();
  expect(calls.open).not.toHaveBeenCalled();
});
