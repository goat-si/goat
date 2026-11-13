import {
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
import { resetHistoryTasksForTests, updateHistoryView } from "./botWorkHistoryStore";
import { disposeGoatBotEnvironment } from "./goatBotEnvironmentLifecycle";

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
function History({ list, revision = 0 }: { list: ChannelListBotThreadsResult; revision?: number }) {
  const history = useBotWorkHistory(env, null, capabilities, list, revision, true);
  return (
    <>
      {history.hasMore && <button onClick={history.loadMore}>Read history</button>}
      <button
        onClick={() =>
          updateHistoryView(env, taskId, { ...old.view, pinnedAt: "2026-11-13T01:00:00Z" })
        }
      >
        Pin old
      </button>
      {history.incomplete && <p>Older work may be missing</p>}
      {history.rows
        .filter((item) => item.kind === "task")
        .map((item) => (
          <p key={item.task.taskId}>
            {item.task.title} {item.view.pinnedAt ? "Pinned" : "Unpinned"}
          </p>
        ))}
    </>
  );
}
function setup() {
  resetHistoryTasksForTests();
  mock.read.mockReset();
}

it("keeps the current task view when it leaves the current list", async () => {
  setup();
  mock.read.mockResolvedValueOnce(page([old], {}));
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  const latest = { ...old, view: { ...old.view, pinnedAt: "2026-11-13T01:00:00Z" } };
  await screen.rerender(<History list={current([latest])} revision={1} />);
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
  await screen.rerender(<History list={current([])} revision={2} />);
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
});

it("removing an environment clears a mounted history and discards a pending answer", async () => {
  setup();
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  const firstPage = [
    old,
    ...Array.from({ length: 4 }, (_, index) => ({
      ...old,
      task: { ...old.task, taskId: ChannelTaskId.make(`extra-${index}`), title: `Extra ${index}` },
      view: { ...old.view, taskId: ChannelTaskId.make(`extra-${index}`) },
    })),
  ];
  mock.read.mockResolvedValueOnce(page(firstPage, { nextCursor: "next" }));
  mock.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<History list={current([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Old task Unpinned")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await act(() => disposeGoatBotEnvironment(env));
  await expect.element(screen.getByText("Old task Unpinned")).not.toBeInTheDocument();
  await act(() => finish(page([old], {})));
  await expect.element(screen.getByText("Old task Unpinned")).not.toBeInTheDocument();
});

it("keeps Pin when a page started earlier arrives late", async () => {
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
  await userEvent.click(screen.getByRole("button", { name: "Pin old" }));
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
  const firstId = ChannelTaskId.make("item-0");
  await act(() =>
    updateHistoryView(env, firstId, {
      ...old.view,
      taskId: firstId,
      pinnedAt: "2026-11-13T01:00:00Z",
    }),
  );
  for (let batch = 1; batch < 11; batch++)
    await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await expect.element(screen.getByText("Older work may be missing")).toBeVisible();
  await expect.element(screen.getByText("Task item-0 Pinned")).toBeVisible();
  await expect.element(screen.getByText("Task item-499 Unpinned")).toBeVisible();
  await expect.element(screen.getByText("Task item-500 Unpinned")).not.toBeInTheDocument();
  expect(mock.read).toHaveBeenCalledTimes(11);
  await expect
    .element(screen.getByRole("button", { name: "Read history" }))
    .not.toBeInTheDocument();
});

it("does not let an unchanged current list undo a newer view update", async () => {
  setup();
  mock.read.mockResolvedValueOnce(page([old], {}));
  await using screen = await render(<History list={current([old])} />);
  await userEvent.click(screen.getByRole("button", { name: "Read history" }));
  await act(() =>
    updateHistoryView(env, taskId, { ...old.view, pinnedAt: "2026-11-13T01:00:00Z" }),
  );
  await screen.rerender(<History list={current([])} revision={1} />);
  await expect.element(screen.getByText("Old task Pinned")).toBeVisible();
});
