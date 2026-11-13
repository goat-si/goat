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
const current = (rows: unknown[]) => ({ rows, mainMessageCount: 0 }) as ChannelListBotThreadsResult;
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
      {history.rows
        .filter((item) => item.kind === "task")
        .map((item) => (
          <p key={item.task.taskId}>
            {item.task.title} {item.view.pinnedAt ? "Pinned" : "Unpinned"}
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

it("caps a crossing page and warns while keeping the earlier work", async () => {
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
  await expect.element(screen.getByText("Task item-500 Unpinned")).not.toBeInTheDocument();
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
