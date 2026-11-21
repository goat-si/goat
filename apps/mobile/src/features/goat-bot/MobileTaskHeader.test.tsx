import type { BotWorkTask } from "@goat/client-runtime/goatBot";
import { type BotWorkResult, EnvironmentId, ThreadId } from "@goat/contracts";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Props = Record<string, unknown> & { children?: ReactNode };
const spoken = vi.hoisted(() => ({ lines: [] as string[] }));
const platform = vi.hoisted(() => ({ OS: "ios" }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: (line: string) => spoken.lines.push(line) },
  Platform: platform,
  ScrollView: (props: Props) => <div>{props.children}</div>,
  View: (props: Props & { accessibilityRole?: string; accessibilityLabel?: string }) => (
    <div role={props.accessibilityRole} aria-label={props.accessibilityLabel}>
      {props.children}
    </div>
  ),
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (
    props: Props & { onPress?: () => void; disabled?: boolean; accessibilityLabel?: string },
  ) => (
    <button onClick={props.onPress} disabled={props.disabled} aria-label={props.accessibilityLabel}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref?.environmentId === "env" && ref.threadId === "channel-worker:local"
      ? { title: "Review the release notes" }
      : null,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: nativeMenu("iOS") }));
vi.mock("@react-native-menu/menu", () => ({ MenuView: nativeMenu("Android") }));
vi.mock("./GoatBotTaskRow", () => ({ GoatBotTaskRow: () => <span>chat card</span> }));
vi.mock("./MobileTaskRetry", () => ({ MobileTaskRetry: () => <button>Retry</button> }));
vi.mock("./MobileBotRemoteWork", () => ({
  MobileBotRemoteWork: () => <button>Remote work</button>,
}));

function nativeMenu(surface: string) {
  return function NativeMenu(props: {
    children: ReactNode;
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <div onClick={() => setOpen(true)}>{props.children}</div>
        {open && (
          <div role="menu" aria-label={surface}>
            {props.actions.map(({ id, title }) => (
              <button
                key={id}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  props.onPressAction({ nativeEvent: { event: id } });
                }}
              >
                {title}
              </button>
            ))}
          </div>
        )}
      </>
    );
  };
}

import { MobileTaskHeader } from "./MobileTaskHeader";
import { taskChip } from "./mobileTaskChipFixture";
import type { MobileTaskLookup } from "./useMobileBotTaskLookup";

const at = "2026-11-01T00:00:00.000Z";
const row = {
  kind: "task",
  task: {
    taskId: "t1",
    title: "Old report",
    status: "completed",
    updatedAt: at,
    titleTruncated: true,
  },
  view: { taskId: "t1", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: false,
  mainMessagesSinceQuiet: 0,
} as const;
const result = (task: BotWorkResult["task"], extra: Partial<BotWorkResult> = {}) =>
  ({
    task,
    codingRows: [],
    remoteWork: [],
    launchesTruncated: false,
    partial: false,
    ...extra,
  }) as BotWorkResult;
const knownTask = {
  row,
  subagents: [],
  threads: [{ environmentId: "env", threadId: "w-1" }],
  remote: [],
} as unknown as BotWorkTask;

const container = document.createElement("div");
const retry = vi.fn();
const openHome = vi.fn();
async function render(
  lookup: MobileTaskLookup,
  enabled = true,
  card: unknown = null,
  chips: ReadonlyMap<string, unknown> = new Map(),
  snooze?: Parameters<typeof MobileTaskHeader>[0]["screen"]["snooze"],
  listed?: BotWorkTask,
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MobileTaskHeader
        task={listed}
        rows={[]}
        chips={chips as never}
        screen={{ lookup, canUpdate: true, update: async () => true, retried: () => {}, snooze }}
        title="Old report"
        botName="GOAT Bot"
        environmentId={"env" as never}
        enabled={enabled}
        canRetry
        older
        loading={false}
        failed={false}
        childError={false}
        onRetryRead={() => {}}
        onOpenThread={() => {}}
        onOpenHome={openHome}
        card={card as never}
      />,
    ),
  );
  return root;
}
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);

it("a looked-up task shows its status and actions instead of the older-work explanation", async () => {
  const root = await render({
    state: "known",
    task: knownTask,
    result: result({ state: "known", row } as never, { launchesTruncated: true, partial: true }),
  });
  expect(text()).toContain("Old report…");
  expect(text()).toContain("Done");
  expect(button("Pin")).toBeDefined();
  expect(button("Open work thread")).toBeDefined();
  expect(text()).toContain("More of this task's work isn't shown here.");
  expect(text()).toContain("Some task details could not be checked.");
  expect(text()).not.toContain("Status and actions for older work");
  await act(async () => root.unmount());
});

it("an unavailable task shows its status and work but nothing that needs its read, pinned or done state", async () => {
  const root = await render({
    state: "unavailable",
    task: {
      state: "unavailable",
      task: { taskId: "t1", title: "Old report", status: "failed", updatedAt: at },
      worker: { environmentId: "env", threadId: "w-1" },
    } as never,
    result: result({ state: "unavailable" } as never, { launchesTruncated: true, partial: true }),
  });
  expect(text()).toContain("Failed");
  expect(text()).toContain("Its read, pinned and done state couldn't be read.");
  expect(button("Pin")).toBeUndefined();
  expect(button("Mark done")).toBeUndefined();
  expect(button("Retry")).toBeDefined();
  expect(button("Open work thread")).toBeDefined();
  expect(text()).toContain("More of this task's work isn't shown here.");
  expect(text()).toContain("Some task details could not be checked.");
  await act(async () => root.unmount());
});

it("a task's header says what its worker asks, from the conversation's chip, as Home does", async () => {
  const running = { ...row, task: { ...row.task, status: "running" } };
  const root = await render(
    {
      state: "known",
      task: { ...knownTask, row: running },
      result: result({ state: "known", row: running } as never),
    } as never,
    true,
    null,
    new Map([["t1", taskChip("t1", { openQuestionCount: 1 })]]),
  );
  expect(text()).toContain("Waiting for your answer");
  expect(text()).not.toContain("Working");
  await act(async () => root.unmount());
});

it("an unavailable task says what its worker asks, from the conversation's chip, as Home does", async () => {
  const root = await render(
    {
      state: "unavailable",
      task: {
        state: "unavailable",
        task: { taskId: "t1", title: "Old report", status: "running", updatedAt: at },
      },
      result: result({ state: "unavailable" } as never),
    } as never,
    true,
    null,
    new Map([["t1", taskChip("t1", { openQuestionCount: 1 })]]),
  );
  expect(text()).toContain("Waiting for your answer");
  expect(text()).not.toContain("Working");
  await act(async () => root.unmount());
});

it("a task the server does not have says so once, with no way to Home", async () => {
  const root = await render({ state: "missing" });
  expect(text()).toContain("This task cannot be found here.");
  expect(button("Open Home")).toBeUndefined();
  await act(async () => root.unmount());
});

it("a failed lookup keeps the explanation and offers Try again", async () => {
  retry.mockClear();
  const root = await render({ state: "failed", retry });
  expect(text()).toContain("Status and actions for older work are in GOAT Bot's Home.");
  await act(async () => button("Couldn't load this task. Try again")?.click());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("without the lookup, or without permission, the older-work explanation stays as before", async () => {
  let root = await render({ state: "off" });
  expect(text()).toContain("Status and actions for older work are in GOAT Bot's Home.");
  expect(button("Open Home")).toBeDefined();
  await act(async () => root.unmount());
  root = await render({ state: "denied" });
  expect(text()).toContain("Permission to read this task is unavailable.");
  expect(button("Open Home")).toBeDefined();
  await act(async () => root.unmount());
});

it("a task the server does not have shows no chat card, so nothing on the screen opens it", async () => {
  const root = await render({ state: "missing" }, true, {
    key: "t1",
    revision: 1,
    updatedAt: at,
    title: "Old report",
    statusLabel: "Done",
    target: { kind: "thread", threadId: "w-1" },
  });
  expect(text()).toContain("This task cannot be found here.");
  expect(text()).not.toContain("chat card");
  await act(async () => root.unmount());
});

it("tells the screen reader once when the lookup settles on a failure, a refusal or partial details", async () => {
  spoken.lines = [];
  const root = await render({ state: "loading" });
  expect(spoken.lines).toEqual([]);
  const next = async (lookup: MobileTaskLookup) =>
    act(async () =>
      root.render(
        <MobileTaskHeader
          task={undefined}
          rows={[]}
          chips={new Map()}
          screen={{ lookup, canUpdate: true, update: async () => true, retried: () => {} }}
          title="Old report"
          botName="GOAT Bot"
          environmentId={"env" as never}
          enabled
          canRetry
          older
          loading={false}
          failed={false}
          childError={false}
          onRetryRead={() => {}}
          onOpenThread={() => {}}
          onOpenHome={openHome}
          card={null}
        />,
      ),
    );
  await next({ state: "failed", retry });
  await next({ state: "failed", retry });
  await next({ state: "denied" });
  await next({
    state: "known",
    task: knownTask,
    result: result({ state: "known", row } as never, { partial: true }),
  });
  expect(spoken.lines).toEqual([
    "Couldn't load this task.",
    "Permission to read this task is unavailable.",
    "Some task details could not be checked.",
  ]);
  await act(async () => root.unmount());
});

it("a status already showing when the header mounts is told to the screen reader once", async () => {
  spoken.lines = [];
  const root = await render({ state: "denied" });
  expect(spoken.lines).toEqual(["Permission to read this task is unavailable."]);
  await act(async () => root.unmount());
});

const codingRow = (threadId: string, title?: string) => ({
  kind: "coding" as const,
  taskId: "t1",
  environmentId: "env",
  threadId,
  ...(title === undefined ? {} : { title }),
  state: "bound" as const,
  lastActivityAt: at,
});
const threadLinks = () =>
  [...container.querySelectorAll("button")]
    .filter((item) => /^(GOAT|Work) thread: /.test(item.getAttribute("aria-label") ?? ""))
    .map((item) => [item.getAttribute("aria-label"), item.textContent]);

it("a looked-up task names its coding threads from the lookup's rows (#3307)", async () => {
  const withWorker = { ...row, worker: { environmentId: "env", threadId: "w-1" } };
  const root = await render({
    state: "known",
    task: {
      ...knownTask,
      row: withWorker,
      threads: [
        { environmentId: "env", threadId: "w-1" },
        { environmentId: "env", threadId: "thread-a" },
        { environmentId: "env", threadId: "thread-b" },
        { environmentId: "env", threadId: "child-thread" },
      ],
    } as never,
    result: result({ state: "known", row: withWorker } as never, {
      codingRows: [codingRow("thread-a", "Patch web"), codingRow("thread-b")] as never,
    }),
  });
  expect(threadLinks()).toEqual([
    ["Work thread: Old report…", "Open work thread"],
    ["GOAT thread: Patch web", "Patch web"],
    ["GOAT thread: Open work thread", "Open work thread"],
    ["Work thread: Old report…", "Open work thread"],
  ]);
  await act(async () => root.unmount());
});

it("an unavailable looked-up task names its coding threads the same way (#3307)", async () => {
  const root = await render({
    state: "unavailable",
    task: {
      state: "unavailable",
      task: { taskId: "t1", title: "Old report", status: "failed", updatedAt: at },
      worker: { environmentId: "env", threadId: "w-1" },
    } as never,
    result: result({ state: "unavailable" } as never, {
      codingRows: [codingRow("thread-a", "Patch web"), codingRow("thread-b")] as never,
    }),
  });
  expect(threadLinks()).toEqual([
    ["Work thread: Old report", "Open work thread"],
    ["GOAT thread: Patch web", "Patch web"],
    ["GOAT thread: Open work thread", "Open work thread"],
  ]);
  await act(async () => root.unmount());
});

it("shows the bot's criterion and uses readable worker names in Activity", async () => {
  const task = {
    ...knownTask,
    row: {
      ...knownTask.row,
      task: { ...knownTask.row.task, doneMeans: "The release notes are reviewed." },
    },
  };
  const lookup = {
    state: "known",
    task,
    result: result(
      { state: "known", row: task.row },
      {
        activity: {
          entries: [
            {
              id: "started:local",
              type: "worker_started",
              actor: "bot",
              at,
              threadId: ThreadId.make("channel-worker:local"),
              environmentId: EnvironmentId.make("env"),
            },
            {
              id: "started:ssh",
              type: "worker_started",
              actor: "bot",
              at,
              threadId: ThreadId.make("remote-worker"),
              host: "unpaired",
            },
            {
              id: "finished:ssh",
              type: "worker_finished",
              actor: "goat",
              at,
              threadId: ThreadId.make("remote-worker"),
              host: "unpaired",
            },
            {
              id: "linked:42",
              type: "pr_linked",
              actor: "goat",
              at,
              repo: "example/release",
              number: 42,
            },
          ],
        },
      },
    ),
  } as const satisfies MobileTaskLookup;
  const current = await render(lookup);
  expect(button("Snooze")).toBeUndefined();
  expect(text()).toContain("The release notes are reviewed.");
  await act(async () => button("Activity")?.click());
  expect(text()).toContain("Pull request linked · example/release#42");
  expect(text()).toContain("Worker started · Review the release notes");
  expect(text()).not.toMatch(/channel-worker:local|remote-worker/);
  for (const action of ["started", "finished"]) {
    const entry = [...container.querySelectorAll("span")].find(
      (item) => item.textContent === `Worker ${action} · Work thread on unpaired`,
    );
    expect(entry?.closest("a, button, [role='link']")).toBeNull();
  }
  await act(async () => current.unmount());
});

it.each([
  ["ios", "iOS"],
  ["android", "Android"],
])("opens Snooze choices in a platform menu on %s", async (os, surface) => {
  platform.OS = os;
  const change = vi.fn(async () => {});
  const current = await render(
    {
      state: "known",
      task: knownTask,
      result: result({ state: "known", row } as never),
    },
    true,
    null,
    new Map(),
    { enabled: () => true, change },
  );
  try {
    const trigger =
      container.querySelector<HTMLElement>('[aria-label="Snooze"]') ?? button("Snooze");
    expect(trigger).toBeDefined();
    expect(text()).not.toContain("1 hour");
    await act(async () => trigger?.click());
    const menu = container.querySelector(`[role="menu"][aria-label="${surface}"]`);
    const choices = [...(menu?.querySelectorAll("button") ?? [])];
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "1 hour",
      "Tomorrow",
      "Next week",
    ]);
    expect(button("Pin")?.closest('[role="menu"]')).toBeNull();
    expect(button("Mark done")?.closest('[role="menu"]')).toBeNull();
    expect(button("Open work thread")?.closest('[role="menu"]')).toBeNull();
    await act(async () => choices[0]?.click());
    expect(change).toHaveBeenCalledWith(knownTask.row.view, "hour");
    expect(text()).not.toContain("1 hour");
  } finally {
    await act(async () => current.unmount());
    platform.OS = "ios";
  }
});

it("keeps every listed worker when Activity arrives with capped worker details", async () => {
  const linked = Array.from({ length: 21 }, (_, index) => ({
    childWorkId: "worker-" + index,
    taskId: row.task.taskId,
    callerThreadId: "bot",
    host: "worker-box",
    state: "completed",
    lastActivityAt: at,
  })) as unknown as BotWorkResult["remoteWork"];
  const task = { ...knownTask, remote: linked };
  const lookup: MobileTaskLookup = {
    state: "known",
    task: { ...task, remote: linked.slice(1) },
    result: result({ state: "known", row } as never, {
      remoteWork: linked.slice(1),
      launchesTruncated: true,
      activity: { entries: [] },
    }),
  };
  const root = await render(lookup, true, null, new Map(), undefined, task);
  expect(
    [...container.querySelectorAll("button")].filter((item) => item.textContent === "Remote work"),
  ).toHaveLength(21);
  await act(async () => root.unmount());
});
