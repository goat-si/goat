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
    /** Answers without flushing React, so a render can land in the same batch. */
    settle: (value: ChannelListBotThreadsResult) => void;
    /** Fails without flushing React. */
    settleFail: () => void;
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
          settle: (result) => resolve({ _tag: "Success", value: result }),
          settleFail: () => resolve({ _tag: "Failure", cause: "down" }),
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
  owner: "env:bot",
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
  await act(async () => view().markRead("env:bot", "a" as never, at(5)));
  expect(readThrough()?.view.readThrough).toBe(at(5));
  expect(readThrough()?.unread).toBe(false);
  await act(async () => view().markRead("env:bot", "a" as never, at(2)));
  expect(readThrough()?.view.readThrough).toBe(at(5));
  await act(async () => view().markRead("env:bot", "a" as never, "not a time"));
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

it("frees Show more on reconnect while the press that lost its computer is still unanswered", async () => {
  setup();
  await show();
  await press();
  await show({ enabled: false });
  await show({ enabled: true });
  expect(view().loading).toBe(false);
  await press();
  expect(net.calls).toHaveLength(2);
  expect(net.calls[1]?.cursor).toBeUndefined();
  await net.calls[0]?.answer(page([task("x")]));
  expect(view().loading).toBe(true);
  expect(titles()).toEqual(["now"]);
  await net.calls[1]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  expect(view().loading).toBe(false);
  expect(titles()).toEqual(["now", "a", "b", "c", "d", "e"]);
});

it("drops a late page from an earlier opening of Home, and its read mark reaches the reopened walk", async () => {
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
  await act(async () => view().markRead("env:bot", "a" as never, at(5)));
  const a = view().rows.find((row) => row.kind === "task" && row.task.taskId === "a") as Extract<
    BotThreadRow,
    { kind: "task" }
  >;
  expect(a.unread).toBe(false);
});

it("going back to the first computer starts a new walk: a late page lands nowhere, a read mark only on its computer", async () => {
  setup();
  const a = () =>
    view().rows.find((row) => row.kind === "task" && row.task.taskId === "a") as Extract<
      BotThreadRow,
      { kind: "task" }
    >;
  await show({ scope: "A", owner: "A" });
  await press();
  await show({ scope: "B", owner: "B" });
  await net.calls[0]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  expect(titles()).toEqual(["now"]);
  await press();
  await net.calls[1]?.answer(
    page([task("a", { unread: true, activity: 5 }), task("b"), task("c"), task("d"), task("e")]),
  );
  await act(async () => view().markRead("A", "a" as never, at(5)));
  expect(a().unread).toBe(true);
  await show({ scope: "A", owner: "A" });
  expect(titles()).toEqual(["now"]);
  expect(view().loading).toBe(false);
  await press();
  expect(net.calls).toHaveLength(3);
  expect(net.calls[2]?.cursor).toBeUndefined();
  await net.calls[2]?.answer(
    page([task("a", { unread: true, activity: 5 }), task("b"), task("c"), task("d"), task("e")]),
  );
  await act(async () => view().markRead("A", "a" as never, at(5)));
  expect(a().unread).toBe(false);
});

it("a disconnect in the same batch as the last answer applies nothing and reports no failure", async () => {
  setup();
  await show();
  await press();
  await act(async () => {
    root?.render(<Probe {...base} enabled={false} />);
    net.calls[0]?.settle(page([task("a"), task("b"), task("c"), task("d"), task("e")]));
  });
  await show();
  expect(titles()).toEqual(["now"]);
  expect(view().failed).toBe(false);
  await press();
  await act(async () => {
    root?.render(<Probe {...base} enabled={false} />);
    net.calls[1]?.settleFail();
  });
  await show();
  expect(view().failed).toBe(false);
  expect(view().loading).toBe(false);
});

it("an unmount in the same batch as the last answer sends and writes nothing", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const finish of ["settle", "settleFail"] as const) {
      setup();
      // setup() unmounts the previous test's root outside act; only what follows counts.
      errors.mockClear();
      await show();
      await press();
      await act(async () => {
        root?.unmount();
        if (finish === "settle") net.calls[0]?.settle(page([task("a")], "c1"));
        else net.calls[0]?.settleFail();
      });
      root = null;
      expect(net.calls).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    }
  } finally {
    errors.mockRestore();
  }
});

it("stops a press when Home unmounts, while its first page or a later page is pending", async () => {
  setup();
  await show();
  await press();
  await act(async () => root?.unmount());
  root = null;
  await net.calls[0]?.answer(page([task("a")], "c1"));
  expect(net.calls).toHaveLength(1);
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(page([task("a")], "c1"));
  expect(net.calls).toHaveLength(2);
  const before = view();
  await act(async () => root?.unmount());
  root = null;
  await net.calls[1]?.answer(page([task("b")], "c2"));
  expect(net.calls).toHaveLength(2);
  expect(seen.current).toBe(before);
});

it("cancels a press at each step: before its first request, between requests, and after the last answer", async () => {
  setup();
  await show();
  const stale = view().loadMore;
  await show({ enabled: false });
  await show({ enabled: true });
  await act(async () => void stale());
  expect(net.calls).toHaveLength(0);
  await press();
  await show({ enabled: false });
  await net.calls[0]?.answer(page([task("a")], "c1"));
  expect(net.calls).toHaveLength(1);
  await show({ enabled: true });
  await press();
  await net.calls[1]?.answer(page([task("a")], "c1"));
  await show({ enabled: false });
  await net.calls[2]?.answer(page([task("b")]));
  await show({ enabled: true });
  expect(titles()).toEqual(["now"]);
  expect(view().failed).toBe(false);
});

it("drops a page whose walk changes after its last check, in the same batch as the answer", async () => {
  setup();
  await show({ scope: "A" });
  await press();
  await act(async () => {
    net.calls[0]?.settle(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
    root?.render(<Probe {...base} scope="B" />);
  });
  expect(titles()).toEqual(["now"]);
  expect(view().loading).toBe(false);
});

it("follows a computer that stops offering paged history while connected: no Show more, no read, rows stay", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  expect(view().hasMore).toBe(true);
  await show({ capabilities: { goatBotTaskThreadsPaged: false } as Props["capabilities"] });
  expect(view().hasMore).toBe(false);
  await press();
  expect(net.calls).toHaveLength(1);
  expect(titles()).toEqual(["now", "a", "b", "c", "d", "e"]);
});

it("says a read mark is this Home's only while mounted and for its own computer and bot", async () => {
  setup();
  await show();
  let ours = false;
  await act(async () => void (ours = view().markRead("env:bot", "a" as never, at(5))));
  expect(ours).toBe(true);
  await act(async () => void (ours = view().markRead("other", "a" as never, at(5))));
  expect(ours).toBe(false);
  const late = view().markRead;
  await act(async () => root?.unmount());
  root = null;
  expect(late("env:bot", "a" as never, at(5))).toBe(false);
});

const unpaged = { goatBotTaskThreadsPaged: false } as Props["capabilities"];

it("ends a press when the computer stops offering paged history while its first page is pending", async () => {
  setup();
  await show();
  await press();
  await show({ capabilities: unpaged });
  await net.calls[0]?.answer(page([task("a")], "c1"));
  expect(net.calls).toHaveLength(1);
  expect(view().failed).toBe(false);
  expect(view().loading).toBe(false);
  expect(view().hasMore).toBe(false);
  expect(titles()).toEqual(["now"]);
});

it("ends a press when the computer stops offering paged history while a later page is pending, keeping read rows", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(page([task("a"), task("b"), task("c"), task("d"), task("e")], "c1"));
  await press();
  await net.calls[1]?.answer(page([task("f")], "c2"));
  expect(net.calls).toHaveLength(3);
  await show({ capabilities: unpaged });
  await net.calls[2]?.answer(page([task("g")], "c3"));
  expect(net.calls).toHaveLength(3);
  expect(view().failed).toBe(false);
  expect(view().loading).toBe(false);
  expect(view().hasMore).toBe(false);
  expect(titles()).toEqual(["now", "a", "b", "c", "d", "e"]);
  await show();
  expect(view().hasMore).toBe(true);
});

it("going offline clears the failure notice, also when the failure lands in the same batch", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.fail();
  expect(view().failed).toBe(true);
  await show({ enabled: false });
  expect(view().failed).toBe(false);
  await show();
  await press();
  await act(async () => {
    net.calls[1]?.settleFail();
    root?.render(<Probe {...base} enabled={false} />);
  });
  expect(view().failed).toBe(false);
});

it("a late mark for earlier activity reads the task through that activity only", async () => {
  setup();
  await show();
  await press();
  await net.calls[0]?.answer(
    page([task("a", { unread: true, activity: 5 }), task("b"), task("c"), task("d"), task("e")]),
  );
  const a = () =>
    view().rows.find((row) => row.kind === "task" && row.task.taskId === "a") as Extract<
      BotThreadRow,
      { kind: "task" }
    >;
  await act(async () => view().markRead("env:bot", "a" as never, at(3)));
  expect(a().view.readThrough).toBe(at(3));
  expect(a().unread).toBe(true);
  await act(async () => view().markRead("env:bot", "a" as never, at(5)));
  expect(a().unread).toBe(false);
});
