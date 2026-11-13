import {
  BotId,
  ChannelTaskId,
  EnvironmentId,
  type ChannelListBotThreadsResult,
  type ExecutionEnvironmentCapabilities,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("~/state/channels", () => ({ channelEnvironment: { listBotThreadsPage: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mock.read }));
import { useBotWorkHistory } from "./useBotWorkHistory";

const env = EnvironmentId.make("round3");
const taskId = ChannelTaskId.make("old");
const capabilities = { goatBotTaskThreadsPaged: true } as ExecutionEnvironmentCapabilities;
const old = {
  kind: "task",
  task: { taskId, title: "Old task", status: "completed", updatedAt: "2026-11-13T00:00:00Z" },
  view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: "2026-11-13T00:00:00Z",
  unread: false,
  mainMessagesSinceQuiet: 0,
} as const;
const page = (rows: readonly unknown[], history: Record<string, unknown>) => ({
  _tag: "Success",
  value: { rows, mainMessageCount: 0, history },
});
const current = (rows: unknown[], remoteWork: unknown[] = []) =>
  ({ rows, remoteWork, mainMessageCount: 0 }) as ChannelListBotThreadsResult;
const pinnedOld = { ...old, view: { ...old.view, pinnedAt: "2026-11-13T01:00:00Z" } };
// Home is keyed by environment and bot in GoatBotChatView, so a switch remounts the walk.
function KeyedHistory(props: { list: ChannelListBotThreadsResult; botId?: BotId | null }) {
  return <History key={JSON.stringify([env, props.botId ?? null])} {...props} />;
}
function History({
  list,
  botId = null,
}: {
  list: ChannelListBotThreadsResult;
  botId?: BotId | null;
}) {
  const history = useBotWorkHistory(env, botId, capabilities, list, true);
  return (
    <>
      {history.hasMore && <button onClick={history.loadMore}>Read history</button>}
      <button onClick={() => history.markRead(taskId, "2026-11-13T01:00:00Z")}>Read valid</button>
      <button onClick={() => history.markRead(taskId, "invalid")}>Read invalid</button>
      {history.incomplete && <p>Older work may be missing</p>}
      {history.remoteWork.map((item) => (
        <span key={item.childWorkId}>remote {item.childWorkId}</span>
      ))}
      {history.rows
        .filter((item) => item.kind === "task")
        .map((item) => (
          <p key={item.task.taskId}>
            {item.task.title} {item.view.pinnedAt ? "Pinned" : "Unpinned"}
            {item.unread && <span> Unread</span>}
            {item.view.doneAt && <span> Done</span>}
            {item.view.readThrough && <span>Read through {item.view.readThrough}</span>}
          </p>
        ))}
    </>
  );
}

it("keeps the walk and its pending page when the current list refreshes", async () => {
  setup();
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await screen.rerender(<History list={current([])} />);
  await act(() => finish(page([old], {})));
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  expect(mock.read).toHaveBeenCalledTimes(1);
});

it("remembers unsupported history across current-list refreshes", async () => {
  setup();
  mock.read.mockResolvedValueOnce({ _tag: "Success", value: { rows: [], mainMessageCount: 0 } });
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect
    .element(screen.getByRole("button", { name: "Read history" }))
    .not.toBeInTheDocument();
  await screen.rerender(<History list={current([])} />);
  await expect
    .element(screen.getByRole("button", { name: "Read history" }))
    .not.toBeInTheDocument();
});

it("drops a pending page for the previous bot", async () => {
  setup();
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(
    <KeyedHistory list={current([])} botId={BotId.make("first")} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await screen.rerender(<KeyedHistory list={current([])} botId={BotId.make("second")} />);
  await act(() => finish(page([old], {})));
  await screen.rerender(<KeyedHistory list={current([])} botId={BotId.make("first")} />);
  await expect.element(screen.getByText("Old task Unpinned")).not.toBeInTheDocument();
});
function setup() {
  mock.read.mockReset();
}

it("a page that arrives after Pin, still saying unpinned, does not change the pinned row", async () => {
  setup();
  const firstPage = [
    old,
    ...Array.from({ length: 4 }, (_, index) => ({
      ...old,
      task: { ...old.task, taskId: ChannelTaskId.make(`first-${index}`), title: `First ${index}` },
      view: { ...old.view, taskId: ChannelTaskId.make(`first-${index}`) },
    })),
  ];
  mock.read.mockResolvedValueOnce(page(firstPage, { nextCursor: "next" }));
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  // Pin refreshes the current list, which now lists the task as pinned.
  await screen.rerender(<History list={current([pinnedOld])} />);
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
  await act(() => finish(page([old], {})));
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
});

it("a press that crosses 500 older tasks is applied whole, then the walk stops with the notice", async () => {
  setup();
  for (let batch = 0; batch < 10; batch++) {
    const count = batch === 9 ? 49 : 50;
    const rows = Array.from({ length: count }, (_, index) => {
      const id = ChannelTaskId.make(`item-${batch * 50 + index}`);
      return {
        ...old,
        task: { ...old.task, taskId: id, title: `Task ${id}` },
        view: { ...old.view, taskId: id },
      };
    });
    mock.read.mockResolvedValueOnce(page(rows, { nextCursor: `cursor-${batch}` }));
  }
  const last = [499, 500, 501, 502, 503, 504].map((index) => {
    const id = ChannelTaskId.make(`item-${index}`);
    return {
      ...old,
      task: { ...old.task, taskId: id, title: `Task ${id}` },
      view: { ...old.view, taskId: id },
    };
  });
  mock.read.mockResolvedValueOnce(page(last, { nextCursor: "still-more" }));
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  for (let batch = 1; batch < 11; batch++)
    await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Older work may be missing")).toBeVisible();
  await expect.element(screen.getByText("Task item-0 Unpinned")).toBeVisible();
  await expect.element(screen.getByText("Task item-499 Unpinned")).toBeVisible();
  await expect.element(screen.getByText("Task item-504 Unpinned")).toBeVisible();
  expect(mock.read).toHaveBeenCalledTimes(11);
  await expect
    .element(screen.getByRole("button", { name: "Read history" }))
    .not.toBeInTheDocument();
});

it("a task unpinned from the current list returns to its history row", async () => {
  setup();
  mock.read.mockResolvedValueOnce(page([old], {}));
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await screen.rerender(<History list={current([pinnedOld])} />);
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
  await screen.rerender(<History list={current([])} />);
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
});

it("ignores an invalid acknowledgement timestamp", async () => {
  setup();
  mock.read.mockResolvedValueOnce(page([old], {}));
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await userEvent.click(screen.getByRole("button", { name: "Read valid" }));
  await userEvent.click(screen.getByRole("button", { name: "Read invalid" }));
  await expect.element(screen.getByText("Read through 2026-11-13T01:00:00Z")).toBeVisible();
});

it("does not warn when exactly 500 history tasks complete the walk", async () => {
  setup();
  const rows = Array.from({ length: 500 }, (_, index) => {
    const id = ChannelTaskId.make(`complete-${index}`);
    return {
      ...old,
      task: { ...old.task, taskId: id, title: `Task ${id}` },
      view: { ...old.view, taskId: id },
    };
  });
  mock.read.mockResolvedValueOnce(page(rows, {}));
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Task complete-499 Unpinned")).toBeVisible();
  expect(screen.getByText("Older work may be missing").query()).toBeNull();
  expect(screen.getByRole("button", { name: "Read history" }).query()).toBeNull();
});

it("reopens the first bot's walk after switching away while a page is pending", async () => {
  setup();
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mock.read.mockResolvedValueOnce(page([old], {}));
  await using screen = await render(
    <KeyedHistory list={current([])} botId={BotId.make("first")} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await screen.rerender(<KeyedHistory list={current([])} botId={BotId.make("second")} />);
  await screen.rerender(<KeyedHistory list={current([])} botId={BotId.make("first")} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  await act(() => finish(page([], {})));
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
});

it("a task that leaves the current list keeps the state the list last reported, and a late page cannot undo it", async () => {
  setup();
  const filler = (index: number) => ({
    ...old,
    task: { ...old.task, taskId: ChannelTaskId.make(`fill-${index}`), title: `Filler ${index}` },
    view: { ...old.view, taskId: ChannelTaskId.make(`fill-${index}`) },
  });
  mock.read.mockResolvedValueOnce(
    page([{ ...old, unread: true }, ...[0, 1, 2, 3].map(filler)], { nextCursor: "more" }),
  );
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Old task Unpinned Unread")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  // Pinned, then marked read and done on its current row.
  const handled = {
    ...pinnedOld,
    unread: false,
    view: { ...pinnedOld.view, doneAt: "2026-11-13T01:30:00Z", readThrough: old.lastActivityAt },
  };
  await screen.rerender(<History list={current([handled])} />);
  await expect.element(screen.getByText(/Old task Pinned Done/)).toBeVisible();
  // It leaves the current list; its entry keeps the last reported read and done state.
  await screen.rerender(<History list={current([])} />);
  await expect.element(screen.getByText(/Old task .* Done/)).toBeVisible();
  expect(screen.getByText(/Unread/).query()).toBeNull();
  await act(() => finish(page([{ ...old, unread: true }], {})));
  await expect.element(screen.getByText(/Old task .* Done/)).toBeVisible();
  expect(screen.getByText(/Unread/).query()).toBeNull();
});

it("tasks the current list holds do not count toward the 500 older tasks", async () => {
  setup();
  const task = (id: string) => ({
    ...old,
    task: { ...old.task, taskId: ChannelTaskId.make(id), title: `Task ${id}` },
    view: { ...old.view, taskId: ChannelTaskId.make(id) },
  });
  const listed = Array.from({ length: 30 }, (_, index) => task(`current-${index}`));
  const older = Array.from({ length: 501 }, (_, index) => task(`older-${index}`));
  mock.read.mockResolvedValueOnce(page([...listed, ...older.slice(0, 20)], { nextCursor: "c0" }));
  for (let batch = 0; batch < 9; batch++)
    mock.read.mockResolvedValueOnce(
      page(older.slice(20 + batch * 50, 70 + batch * 50), { nextCursor: `c${batch + 1}` }),
    );
  mock.read.mockResolvedValueOnce(page(older.slice(470), { nextCursor: "still-more" }));
  await using screen = await render(<History list={current(listed)} />);
  for (let press = 0; press < 11; press++)
    await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Task older-500 Unpinned")).toBeVisible();
  await expect.element(screen.getByText("Older work may be missing")).toBeVisible();
  expect(screen.getByRole("button", { name: "Read history" }).query()).toBeNull();
});

it("exactly 500 older tasks beside current ones complete the walk without a warning", async () => {
  setup();
  const task = (id: string) => ({
    ...old,
    task: { ...old.task, taskId: ChannelTaskId.make(id), title: `Task ${id}` },
    view: { ...old.view, taskId: ChannelTaskId.make(id) },
  });
  const listed = Array.from({ length: 30 }, (_, index) => task(`current-${index}`));
  const older = Array.from({ length: 500 }, (_, index) => task(`older-${index}`));
  mock.read.mockResolvedValueOnce(page([...listed, ...older], {}));
  await using screen = await render(<History list={current(listed)} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Task older-499 Unpinned")).toBeVisible();
  expect(screen.getByText("Older work may be missing").query()).toBeNull();
});

it("marking an older task read through one activity leaves newer activity unread", async () => {
  setup();
  mock.read.mockResolvedValueOnce(
    page([{ ...old, unread: true, lastActivityAt: "2026-11-13T02:00:00Z" }], {}),
  );
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await userEvent.click(screen.getByRole("button", { name: "Read valid" }));
  await expect.element(screen.getByText("Read through 2026-11-13T01:00:00Z")).toBeVisible();
  await expect.element(screen.getByText(/Old task Unpinned Unread/)).toBeVisible();
});

const olderTask = (id: string) => ({
  ...old,
  task: { ...old.task, taskId: ChannelTaskId.make(id), title: `Task ${id}` },
  view: { ...old.view, taskId: ChannelTaskId.make(id) },
});

function holdNextRead() {
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  return (value: ReturnType<typeof page>) => act(() => finish(value));
}

it("a held task entering the current list during a read: the whole page is applied and the limit follows the new count", async () => {
  setup();
  const held = Array.from({ length: 499 }, (_, index) => olderTask(`held-${index}`));
  mock.read.mockResolvedValueOnce(page(held, { nextCursor: "c1" }));
  const land = holdNextRead();
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Task held-498 Unpinned")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await screen.rerender(<History list={current([olderTask("held-0")])} />);
  const fresh = Array.from({ length: 5 }, (_, index) => olderTask(`new-${index}`));
  await land(page(fresh, { nextCursor: "c2" }));
  for (const index of [0, 1, 2, 3, 4])
    await expect.element(screen.getByText(`Task new-${index} Unpinned`)).toBeVisible();
  await expect.element(screen.getByText("Older work may be missing")).toBeVisible();
  expect(screen.getByRole("button", { name: "Read history" }).query()).toBeNull();
});

it("a current task leaving during a read drops nothing, and the notice follows the count", async () => {
  setup();
  const leaving = olderTask("leaving");
  const held = Array.from({ length: 496 }, (_, index) => olderTask(`held-${index}`));
  mock.read.mockResolvedValueOnce(page([leaving, ...held], { nextCursor: "c1" }));
  const land = holdNextRead();
  await using screen = await render(<History list={current([leaving])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Task held-495 Unpinned")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await screen.rerender(<History list={current([])} />);
  const fresh = Array.from({ length: 5 }, (_, index) => olderTask(`new-${index}`));
  await land(page(fresh, { nextCursor: "c2" }));
  for (const index of [0, 1, 2, 3, 4])
    await expect.element(screen.getByText(`Task new-${index} Unpinned`)).toBeVisible();
  await expect.element(screen.getByText("Older work may be missing")).toBeVisible();
  expect(screen.getByRole("button", { name: "Read history" }).query()).toBeNull();
});

it("a released remote launch only history lists stays with the task through Pin and Unpin, listed once", async () => {
  setup();
  const launch = {
    childWorkId: "remote-1",
    taskId,
    callerThreadId: "bot",
    host: "macbook",
    state: "released",
    lastActivityAt: "2026-11-13T00:00:00Z",
    threadId: "remote-thread",
    environmentId: "remote-env",
  };
  mock.read.mockResolvedValueOnce({
    _tag: "Success",
    value: { rows: [old], remoteWork: [launch], mainMessageCount: 0, history: {} },
  });
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("remote remote-1")).toBeVisible();
  await screen.rerender(<History list={current([pinnedOld])} />);
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
  expect(screen.getByText("remote remote-1").all()).toHaveLength(1);
  await screen.rerender(<History list={current([])} />);
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  await expect.element(screen.getByText("remote remote-1")).toBeVisible();
});

it("a launch the current list stops listing is not kept as a stale in-progress row", async () => {
  setup();
  const launch = {
    childWorkId: "remote-2",
    taskId,
    callerThreadId: "bot",
    host: "macbook",
    state: "launched",
    lastActivityAt: "2026-11-13T00:00:00Z",
  };
  mock.read.mockResolvedValueOnce(page([old], {}));
  await using screen = await render(<History list={current([old], [launch])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("remote remote-2")).toBeVisible();
  await screen.rerender(<History list={current([old])} />);
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  expect(screen.getByText("remote remote-2").query()).toBeNull();
});
