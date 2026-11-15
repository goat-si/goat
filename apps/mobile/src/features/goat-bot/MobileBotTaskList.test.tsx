import { act, Profiler, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BotThreadRow, ChannelTaskId, type ChannelUpdateTaskViewInput } from "@goat/contracts";
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
import { taskChip } from "./mobileTaskChipFixture";

// Each entry commits under its own Profiler, so a test can count which rows re-rendered.
const commits = new Map<string, number>();
function TaskList(props: Parameters<typeof mobileBotTaskListItems>[0]) {
  return (
    <>
      {mobileBotTaskListItems(props).map((item) => (
        <Profiler
          key={item.key}
          id={item.key}
          onRender={(id) => commits.set(id, (commits.get(id) ?? 0) + 1)}
        >
          <div>{item.render()}</div>
        </Profiler>
      ))}
    </>
  );
}

/** Fakes timers and the clock at `iso` until the test ends. */
function pinClock(iso: string) {
  vi.useFakeTimers({ now: Date.parse(iso) });
  return { [Symbol.dispose]: () => vi.useRealTimers() };
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
  commits.clear();
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
        chips={new Map()}
        ticking
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

it("a task marked done reads Done, whatever its worker still asks", async () => {
  using _clock = pinClock("2026-11-11T04:00:00.000Z");
  const done = decode({
    kind: "task",
    task: { taskId: "task-done", title: "Ship", status: "running", updatedAt: at },
    view: { taskId: "task-done", pinnedAt: null, doneAt: at, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  }) as Extract<BotThreadRow, { kind: "task" }>;
  const asks = taskChip("task-done", { openQuestionCount: 1 });
  await show({
    work: { running: [], waiting: [], finished: [{ ...listedTask, row: done }] },
    rows: [done],
    chips: new Map([[ChannelTaskId.make("task-done"), asks]]),
  });
  expect(container.querySelector('[aria-label="Ship, Done, 2 hours ago"]')).not.toBeNull();
});

it("lists a task with its status, unread and pinned state, and the actions the bot list had", async () => {
  using _clock = pinClock("2026-11-11T04:00:00.000Z");
  const calls = await show({ work: work([listedTask]), rows: [task] });
  const row = container.querySelector(
    '[aria-label="Review, Waiting for you, 2 hours ago, unread, pinned"]',
  );
  expect(row).not.toBeNull();
  // Assistive actions are the menu's own choices.
  expect(row?.getAttribute("data-actions")).toBe("Show work,Unpin,Mark done,Mark read");
  expect(container.textContent).toContain("Waiting for you · 2h · Unread");
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
  using _clock = pinClock("2026-11-11T04:00:00.000Z");
  const calls = await show({ work: work([listedTask]), rows: [task] });
  const row = container.querySelector(
    '[aria-label="Review, Waiting for you, 2 hours ago, unread, pinned"]',
  );
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

it("says a task's other threads are in Threads only while it is older work, not once it is current again", async () => {
  const history = {
    supported: true,
    currentTaskIds: new Set<ChannelTaskId>(),
    launchesTruncated: new Set([ChannelTaskId.make("task-1")]),
    currentEligible: true,
    hasMore: false,
    loading: false,
    incomplete: false,
    failed: false,
    onLoadMore: () => {},
  };
  await show({ work: work([listedTask]), rows: [task], history });
  expect(container.textContent).toContain("Some threads are listed in Threads.");
  // Pinned from the walk, the task is in the current list again.
  await show({
    work: work([listedTask]),
    rows: [task],
    history: { ...history, currentTaskIds: new Set([ChannelTaskId.make("task-1")]) },
  });
  expect(container.textContent).not.toContain("Some threads are listed in Threads.");
});

const withPullRequests = (
  taskId: string,
  title: string,
  pullRequests: ReadonlyArray<{ repository: string; number: number; state?: string }>,
  omitted?: number,
) =>
  decode({
    kind: "task",
    task: { taskId, title, status: "completed", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
    pullRequests: pullRequests.map((item) => ({ ...item, watching: false })),
    ...(omitted === undefined ? {} : { pullRequestsOmitted: omitted }),
  }) as Extract<BotThreadRow, { kind: "task" }>;
const finishedWork = (...rows: ReadonlyArray<Extract<BotThreadRow, { kind: "task" }>>) => ({
  running: [],
  waiting: [],
  finished: rows.map((row) => ({ ...listedTask, row })),
});
const rowNamed = (title: string) =>
  [...container.querySelectorAll("button")].find((item) =>
    item.getAttribute("aria-label")?.startsWith(`${title}, `),
  );

it("a work row names its pull requests and their state, two at most, and counts the rest", async () => {
  using _clock = pinClock("2026-11-11T04:00:00.000Z");
  const row = withPullRequests(
    "task-pr",
    "Fix the slow test",
    [
      { repository: "goat-si/goat", number: 9, state: "open" },
      { repository: "goat-si/goat", number: 8 },
      { repository: "goat-si/goat", number: 7, state: "merged" },
      { repository: "goat-si/goat", number: 6, state: "merged" },
      { repository: "goat-si/goat", number: 5, state: "closed" },
    ],
    2,
  );
  await show({ work: finishedWork(row), rows: [row] });
  expect(container.textContent).toContain("#9 Open");
  // A pull request whose state is not read shows its number alone, without a state word.
  expect(container.textContent).toContain("#8+5 more");
  expect(container.textContent).not.toContain("#7");
  expect(rowNamed("Fix the slow test")?.getAttribute("aria-label")).toBe(
    "Fix the slow test, Done, 2 hours ago, Pull request goat-si/goat#9, open, " +
      "Pull request goat-si/goat#8, state unknown, 5 more pull requests",
  );
});

it("pull requests across repositories name their repository, in full where short names match", async () => {
  const spread = withPullRequests("task-a", "Spread", [
    { repository: "goat-si/goat", number: 42, state: "merged" },
    { repository: "goat-si/app", number: 7, state: "open" },
  ]);
  const twins = withPullRequests("task-b", "Twins", [
    { repository: "alpha/app", number: 42, state: "open" },
    { repository: "beta/app", number: 42, state: "closed" },
  ]);
  await show({ work: finishedWork(spread, twins), rows: [spread, twins] });
  expect(container.textContent).toContain("goat#42 Merged");
  expect(container.textContent).toContain("app#7 Open");
  expect(container.textContent).toContain("alpha/app#42 Open");
  expect(container.textContent).toContain("beta/app#42 Closed");
  expect(rowNamed("Twins")?.getAttribute("aria-label")).toContain(
    "Pull request alpha/app#42, open, Pull request beta/app#42, closed",
  );
});

it("a row without pull requests has no chip line and names none", async () => {
  await show({ work: work([listedTask]), rows: [task] });
  expect(container.textContent).not.toContain("more");
  expect(rowNamed("Review")?.getAttribute("aria-label")).not.toContain("Pull request");
});

it("a row only Show more holds shows its pull requests, and its press still opens the peek", async () => {
  const older = withPullRequests("task-old", "Old fix", [
    { repository: "goat-si/goat", number: 3, state: "merged" },
  ]);
  const calls = await show({
    work: finishedWork(older),
    rows: [older],
    history: {
      supported: true,
      currentTaskIds: new Set(),
      launchesTruncated: new Set(),
      hasMore: false,
      loading: false,
      incomplete: false,
      failed: false,
      onLoadMore: () => {},
    },
  });
  expect(container.textContent).toContain("#3 Merged");
  const row = rowNamed("Old fix");
  expect(row?.getAttribute("data-actions")).toContain("Open");
  await act(async () => (row as HTMLButtonElement).click());
  expect(calls.peek).toHaveBeenCalledWith("task-old");
});

it("a row says how long ago its task was active, and the words change when the time or the task does", async () => {
  using _clock = pinClock("2026-11-11T02:05:00.000Z");
  await show({ work: work([listedTask]), rows: [task] });
  expect(container.textContent).toContain("Waiting for you · 5m");
  expect(rowNamed("Review")?.getAttribute("aria-label")).toContain(", 5 minutes ago,");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(container.textContent).toContain("Waiting for you · 6m");
  expect(rowNamed("Review")?.getAttribute("aria-label")).toContain(", 6 minutes ago,");
  // The same row, active again just now: the text follows the new time.
  const later = { ...task, lastActivityAt: "2026-11-11T02:06:00.000Z" };
  await show({ work: work([{ ...listedTask, row: later }]), rows: [later] });
  expect(container.textContent).toContain("Waiting for you · now");
  expect(rowNamed("Review")?.getAttribute("aria-label")).toContain(", just now,");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(container.textContent).toContain("Waiting for you · 1m");
  expect(rowNamed("Review")?.getAttribute("aria-label")).toContain(", 1 minute ago,");
  await act(async () => root?.unmount());
  root = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps no clock while Home is hidden, and shows the right time again once it is shown", async () => {
  using _clock = pinClock("2026-11-11T02:05:00.000Z");
  await show({ work: work([listedTask]), rows: [task], ticking: false });
  expect(container.textContent).toContain("Waiting for you · 5m");
  expect(vi.getTimerCount()).toBe(0);
  commits.clear();
  await act(async () => vi.advanceTimersByTime(30 * 60_000));
  expect(commits.size).toBe(0);
  await show({ work: work([listedTask]), rows: [task], ticking: true });
  expect(container.textContent).toContain("Waiting for you · 35m");
  expect(vi.getTimerCount()).toBe(1);
});

it("a minute's tick re-renders only the row whose text changed", async () => {
  using _clock = pinClock("2026-11-11T05:05:00.000Z");
  const recent = { ...task, lastActivityAt: "2026-11-11T05:00:00.000Z" };
  const old = withPullRequests("task-pr", "Fix the slow test", []);
  await show({
    work: { running: [], waiting: [{ ...listedTask, row: recent }], finished: [{ ...listedTask, row: old }] },
    rows: [recent, old],
  });
  commits.clear();
  await act(async () => vi.advanceTimersByTime(60_000));
  expect([...commits.keys()]).toEqual([JSON.stringify(["task", "task-1"])]);
});
