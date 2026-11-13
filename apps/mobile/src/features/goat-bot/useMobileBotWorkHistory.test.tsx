import type { BotThreadRow, ChannelListBotThreadsResult } from "@goat/contracts";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/channels", () => ({ channelEnvironment: { listBotThreadsPage: "page" } }));
const net = vi.hoisted(() => ({
  calls: [] as Array<{
    cursor: string | undefined;
    answer: (value: ChannelListBotThreadsResult) => Promise<void>;
    fail: () => Promise<void>;
  }>,
}));
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/runtime")>();
  return {
    ...real,
    runAtomCommand: (
      _registry: unknown,
      _command: unknown,
      value: { input: { history?: { cursor?: string } } },
    ) =>
      new Promise((resolve) => {
        net.calls.push({
          cursor: value.input.history?.cursor,
          answer: (result) => act(async () => resolve({ _tag: "Success", value: result })),
          fail: () => act(async () => resolve({ _tag: "Failure", cause: "down" })),
        });
      }),
  };
});

import { useMobileBotWorkHistory } from "./useMobileBotWorkHistory";

type Props = Parameters<typeof useMobileBotWorkHistory>[0];
const seen = { current: null as ReturnType<typeof useMobileBotWorkHistory> | null };
function Probe(props: Props) {
  const view = useMobileBotWorkHistory(props);
  useEffect(() => {
    seen.current = view;
  });
  return null;
}

const at = (minute: number) => `2026-11-10T00:${String(minute).padStart(2, "0")}:00.000Z`;
const task = (
  id: string,
  extra: { title?: string; status?: string; unread?: boolean; activity?: number } = {},
) =>
  ({
    kind: "task",
    task: {
      taskId: id,
      title: extra.title ?? id,
      status: extra.status ?? "completed",
      updatedAt: at(0),
    },
    view: { taskId: id, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at(extra.activity ?? 0),
    unread: extra.unread ?? false,
    mainMessagesSinceQuiet: 0,
  }) as unknown as BotThreadRow;
const coding = (taskId: string, threadId: string, title: string) =>
  ({
    kind: "coding",
    taskId,
    environmentId: "env",
    threadId,
    title,
    state: "bound",
    lastActivityAt: at(0),
  }) as unknown as BotThreadRow;
const list = (rows: BotThreadRow[]): ChannelListBotThreadsResult => ({
  rows,
  remoteWork: [],
  mainMessageCount: 0,
});
const page = (rows: BotThreadRow[], nextCursor?: string): ChannelListBotThreadsResult => ({
  rows,
  remoteWork: [],
  mainMessageCount: 0,
  history: nextCursor === undefined ? {} : { nextCursor },
});

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | null = null;
function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.calls = [];
  seen.current = null;
  root?.unmount();
  root = createRoot(container);
}
const base: Props = {
  environmentId: "env" as Props["environmentId"],
  botId: null,
  capabilities: { goatBotTaskThreadsPaged: true } as Props["capabilities"],
  current: list([task("now")]),
  loaded: true,
  enabled: true,
  scope: "env:bot:1",
};
async function show(props: Partial<Props> = {}) {
  await act(async () => root?.render(<Probe {...base} {...props} />));
}
const view = () => {
  if (seen.current === null) throw new Error("not rendered");
  return seen.current;
};
const titles = () => view().rows.flatMap((row) => (row.kind === "task" ? [row.task.title] : []));
async function press() {
  await act(async () => void view().loadMore());
}

it("asks for one page at a time: a second press while one runs sends nothing", async () => {
  setup();
  await show();
  await press();
  await press();
  expect(net.calls).toHaveLength(1);
  await net.calls[0]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  expect(titles()).toEqual(["now", "a", "b", "c", "d", "e"]);
});

it("a press whose later request fails applies nothing, and Try again reads from the same cursor", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(page([task("a")], "c1"));
  expect(net.calls[1]?.cursor).toBe("c1");
  await net.calls[1]?.fail();
  expect(titles()).toEqual(["now"]);
  expect(view().failed).toBe(true);
  expect(view().loading).toBe(false);
  await press();
  expect(net.calls[2]?.cursor).toBeUndefined();
});

it("keeps today's list on a server without paged history, and remembers one that answers without the marker", async () => {
  setup();
  await show({ capabilities: {} as Props["capabilities"] });
  expect(view().supported).toBe(false);
  expect(view().hasMore).toBe(false);
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(list([task("a")]));
  expect(view().supported).toBe(false);
  await show({ current: list([task("now"), task("fresh")]) });
  expect(view().supported).toBe(false);
  expect(view().hasMore).toBe(false);
  expect(titles()).toEqual(["now", "fresh"]);
});

it("lets the current list change while a page is pending, then applies the whole page", async () => {
  setup();
  await show();
  await press();
  await show({ current: list([task("now"), task("b", { title: "b from the list" })]) });
  await net.calls[0]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  expect(titles()).toEqual(["now", "b from the list", "a", "c", "d", "e"]);
});

it("moves an older task's read-through only forward", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(
    page(
      [task("a", { unread: true, activity: 5 }), task("b"), task("c"), task("d"), task("e")],
      "c1",
    ),
  );
  const readThrough = () =>
    view().rows.find((row) => row.kind === "task" && row.task.taskId === "a")?.kind === "task"
      ? (view().rows.find((row) => row.kind === "task" && row.task.taskId === "a") as Extract<
          BotThreadRow,
          { kind: "task" }
        >)
      : null;
  await act(async () => view().markRead("env:bot:1", "a" as never, at(5)));
  expect(readThrough()?.view.readThrough).toBe(at(5));
  expect(readThrough()?.unread).toBe(false);
  await act(async () => view().markRead("env:bot:1", "a" as never, at(2)));
  expect(readThrough()?.view.readThrough).toBe(at(5));
  await act(async () => view().markRead("env:bot:1", "a" as never, "not a time"));
  expect(readThrough()?.view.readThrough).toBe(at(5));
});

it("shows the current list's coding row over the page's copy of the same thread", async () => {
  setup();
  await show({ current: list([task("now")]) });
  await press();
  await net.calls[0]?.answer(
    page(
      [task("a"), coding("a", "t-1", "from history"), task("b"), task("c"), task("d"), task("e")],
      "c1",
    ),
  );
  await show({ current: list([task("now"), task("a"), coding("a", "t-1", "from the list")]) });
  const threads = view().rows.flatMap((row) => (row.kind === "coding" ? [row.title] : []));
  expect(threads).toEqual(["from the list"]);
});

it("keeps what the current list last said about a task after it leaves that list", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(
    page([task("a", { status: "running" }), task("b"), task("c"), task("d"), task("e")], "c1"),
  );
  await show({
    current: list([task("now"), task("a", { status: "completed", title: "a, finished" })]),
  });
  await show({ current: list([task("now")]) });
  const a = view().rows.find((row) => row.kind === "task" && row.task.taskId === "a") as Extract<
    BotThreadRow,
    { kind: "task" }
  >;
  expect(a.task.title).toBe("a, finished");
  expect(a.task.status).toBe("completed");
});

it("applies nothing from a press that lost its computer, even once it reconnects, and fails nothing", async () => {
  setup();
  await show();
  await press();
  await show({ enabled: false });
  await show({ enabled: true });
  await net.calls[0]?.answer(page([task("a")]));
  expect(titles()).toEqual(["now"]);
  expect(view().failed).toBe(false);
  expect(net.calls).toHaveLength(1);
  await press();
  expect(net.calls[1]?.cursor).toBeUndefined();
  await show({ enabled: false });
  await net.calls[1]?.fail();
  expect(view().failed).toBe(false);
});

it("drops a late page and a late read mark that belong to an earlier opening of Home", async () => {
  setup();
  await show();
  await press();
  await show({ scope: "env:bot:2" });
  await net.calls[0]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  expect(titles()).toEqual(["now"]);
  await press();
  await net.calls[1]?.answer(
    page(
      [task("a", { unread: true, activity: 5 }), task("b"), task("c"), task("d"), task("e")],
      "c1",
    ),
  );
  await act(async () => view().markRead("env:bot:1", "a" as never, at(5)));
  const a = view().rows.find((row) => row.kind === "task" && row.task.taskId === "a") as Extract<
    BotThreadRow,
    { kind: "task" }
  >;
  expect(a.unread).toBe(true);
});
