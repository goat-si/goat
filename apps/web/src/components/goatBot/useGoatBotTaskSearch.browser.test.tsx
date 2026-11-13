import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({ supported: true, read: vi.fn(), navigate: vi.fn() }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      ["env", { environment: { capabilities: { goatBotTaskLookupSearch: state.supported } } }],
    ]),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: { searchBotTasks: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.read }));
import { useGoatBotTaskSearch } from "./useGoatBotTaskSearch";
const decodeProfile = Schema.decodeSync(BotProfile);
const profile = (botId: string, role: "main" | "member", name: string) =>
  decodeProfile({
    botId,
    role,
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });
const bots = [profile("main", "main", "Goaty"), profile("research", "member", "Research")];
function Search({
  query,
  profiles = bots,
  enabled = true,
}: {
  query: string;
  profiles?: readonly BotProfile[];
  enabled?: boolean;
}) {
  const { groups, status } = useGoatBotTaskSearch(profiles, query, enabled, state.navigate);
  return (
    <div>
      <div role="status" aria-label="Bot task search">
        {status}
      </div>
      {groups.map((group) => (
        <section key={group.value} aria-label={group.label}>
          <h2>{group.label}</h2>
          {group.note && <p>{group.note}</p>}
          {group.items.map((item) => (
            <button
              key={item.value}
              disabled={item.disabled}
              onClick={() => item.kind === "action" && void item.run()}
            >
              {item.title}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
function setup() {
  state.supported = true;
  state.read.mockReset();
  state.navigate.mockReset();
  state.navigate.mockResolvedValue(undefined);
}

it("searches each bot and follows a cursor through an empty page", async () => {
  setup();
  state.read.mockImplementation(
    async ({ input }: { input: { botId: string; cursor?: string } }) => ({
      _tag: "Success",
      value:
        input.botId === "research" && !input.cursor
          ? { tasks: [], nextCursor: "next", partial: true }
          : input.botId === "research"
            ? {
                tasks: [
                  { taskId: "t1", title: "Find papers", createdAt: "2026-11-07T00:00:00.000Z" },
                ],
                endedEarly: true,
              }
            : {
                tasks: [
                  { taskId: "t-main", title: "Main papers", createdAt: "2026-11-07T00:00:00.000Z" },
                ],
              },
    }),
  );
  await using screen = await render(<Search query="" />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="papers" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect.element(screen.getByRole("button", { name: "Load more" })).toBeVisible();
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "env",
    input: { botId: "main", query: "papers", limit: 20 },
  });
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "env",
    input: { botId: "research", query: "papers", limit: 20 },
  });
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Find papers" })).toBeVisible();
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "env",
    input: { botId: "research", query: "papers", cursor: "next", limit: 20 },
  });
  await vi.waitFor(() =>
    expect(screen.getByRole("status", { name: "Bot task search" }).element().textContent).toContain(
      "Some results could not be checked.",
    ),
  );
  await vi.waitFor(() =>
    expect(screen.getByRole("status", { name: "Bot task search" }).element().textContent).toContain(
      "Search ended early.",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Find papers" }));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/bot",
    search: { task: "t1", taskTitle: "Find papers", bot: "research" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Main papers" }));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/bot",
    search: { task: "t-main", taskTitle: "Main papers" },
  });
});

it("does not search an older server", async () => {
  setup();
  state.supported = false;
  await using screen = await render(<Search query="" />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="papers" />);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(state.read).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: /tasks/ }).query()).toBeNull();
});

it("shows a search error without claiming there were no results", async () => {
  setup();
  state.read.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
  await using screen = await render(<Search query="" />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="papers" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await vi.waitFor(() =>
    expect(screen.getByRole("status", { name: "Bot task search" }).element().textContent).toContain(
      "Couldn't search tasks.",
    ),
  );
  await expect
    .element(
      screen
        .getByRole("region", { name: "Research tasks" })
        .getByRole("button", { name: "Retry task search" }),
    )
    .toBeVisible();
});

it("supersedes an old query and ignores its late results", async () => {
  setup();
  let finish!: (value: unknown) => void;
  const old = new Promise((resolve) => {
    finish = resolve;
  });
  state.read.mockImplementation(({ input }: { input: { query: string } }) =>
    input.query === "a"
      ? old
      : Promise.resolve({
          _tag: "Success",
          value: {
            tasks: [{ taskId: "new", title: "New result", createdAt: "2026-11-07T00:00:00.000Z" }],
          },
        }),
  );
  await using screen = await render(<Search query="" />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="a" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await screen.rerender(<Search query="ab" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect
    .element(
      screen
        .getByRole("region", { name: "Goaty tasks" })
        .getByRole("button", { name: "New result" }),
    )
    .toBeVisible();
  await act(() =>
    finish({
      _tag: "Success",
      value: {
        tasks: [{ taskId: "old", title: "Old result", createdAt: "2026-11-07T00:00:00.000Z" }],
      },
    }),
  );
  expect(screen.getByRole("button", { name: "Old result" }).query()).toBeNull();
});

it("does not offer searches for deleted or unknown bots", async () => {
  setup();
  state.read.mockResolvedValue({ _tag: "Success", value: { tasks: [] } });
  const profiles = [bots[0]!, { ...bots[1]!, state: "deleted" as const }];
  await using screen = await render(<Search query="" profiles={profiles} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="papers" profiles={profiles} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect
    .element(screen.getByRole("status", { name: "Bot task search" }))
    .toHaveTextContent("Goaty: No matching tasks.");
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("region", { name: "Research tasks" }).query()).toBeNull();
  expect(screen.getByRole("region", { name: "Unknown tasks" }).query()).toBeNull();
});

it.each([{ partial: true }, { endedEarly: true }])(
  "does not claim a complete empty search when %j",
  async (flags) => {
    setup();
    state.read.mockResolvedValue({ _tag: "Success", value: { tasks: [], ...flags } });
    await using screen = await render(<Search query="" />);
    using _clock = fakeTimers();
    await screen.rerender(<Search query="papers" />);
    await act(() => vi.advanceTimersByTimeAsync(250));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Bot task search" }).element().textContent,
      ).toContain("No matching tasks found. Some tasks could not be checked."),
    );
    expect(
      screen.getByRole("status", { name: "Bot task search" }).element().textContent,
    ).not.toContain("Goaty: No matching tasks.");
  },
);

it("ignores a late answer after the palette closes", async () => {
  setup();
  let finish!: (value: unknown) => void;
  state.read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<Search query="" />);
  using _clock = fakeTimers();
  using errors = vi.spyOn(console, "error");
  await screen.rerender(<Search query="papers" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await screen.rerender(<Search query="papers" enabled={false} />);
  await act(() => finish(AsyncResult.failure(Cause.fail(new Error("offline")))));
  expect(screen.getByRole("status", { name: "Bot task search" }).element().textContent).toBe("");
  expect(screen.getByRole("button", { name: "Retry task search" }).query()).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});

it("does not redisplay an old page when returning to an earlier query", async () => {
  setup();
  let finish!: (answer: unknown) => void;
  state.read.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      tasks: [{ taskId: "old", title: "Old A", createdAt: "2026-11-07T00:00:00.000Z" }],
      nextCursor: "old-cursor",
    },
  });
  state.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const profiles = [bots[0]!];
  await using screen = await render(<Search query="" profiles={profiles} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="a" profiles={profiles} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect.element(screen.getByRole("button", { name: "Old A" })).toBeVisible();
  await screen.rerender(<Search query="ab" profiles={profiles} />);
  await screen.rerender(<Search query="a" profiles={profiles} />);
  expect(screen.getByRole("button", { name: "Old A" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Load more" }).query()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(250));
  await act(() =>
    finish({
      _tag: "Success",
      value: {
        tasks: [{ taskId: "fresh", title: "Fresh A", createdAt: "2026-11-07T00:00:00.000Z" }],
      },
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Fresh A" })).toBeVisible();
});

it.each([
  ["ASCII 256", "x".repeat(256), true],
  ["ASCII 257", "x".repeat(257), false],
  ["Korean 256", "한".repeat(85) + "a", true],
  ["Korean 258", "한".repeat(86), false],
  ["emoji 256", "😀".repeat(64), true],
  ["emoji 260", "😀".repeat(65), false],
])("enforces UTF-8 search byte bounds: %s", async (_label, query, allowed) => {
  setup();
  state.read.mockResolvedValue({ _tag: "Success", value: { tasks: [] } });
  await using screen = await render(<Search query="" profiles={[bots[0]!]} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query={query} profiles={[bots[0]!]} />);
  await act(() => vi.advanceTimersByTimeAsync(300));
  if (allowed) expect(state.read).toHaveBeenCalledOnce();
  else {
    expect(state.read).not.toHaveBeenCalled();
    await expect
      .element(
        screen
          .getByRole("region", { name: "Task titles" })
          .getByText("Search text is too long for task titles."),
      )
      .toBeVisible();
  }
});

it("caps each bot's retained results at 50 and requests only the remaining slots", async () => {
  setup();
  state.read.mockImplementation(
    async ({ input }: { input: { cursor?: string; limit?: number } }) => {
      const start = input.cursor === "c20" ? 20 : input.cursor === "c40" ? 40 : 0;
      const count = input.limit ?? 20;
      return {
        _tag: "Success",
        value: {
          tasks: Array.from({ length: count }, (_, i) => ({
            taskId: `t${start + i}`,
            title: `Result ${start + i}`,
            createdAt: "2026-11-07T00:00:00.000Z",
          })),
          nextCursor: `c${start + count}`,
        },
      };
    },
  );
  await using screen = await render(<Search query="" profiles={[bots[0]!]} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="work" profiles={[bots[0]!]} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect.element(screen.getByRole("button", { name: "Load more" })).toBeVisible();
  expect(state.read.mock.calls[0]?.[0].input.limit).toBe(20);
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Result 39" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Result 49" })).toBeVisible();
  expect(state.read.mock.calls.map((call) => call[0].input.limit)).toEqual([20, 20, 10]);
  expect(screen.getByRole("button", { name: "Load more" }).query()).toBeNull();
  await expect
    .element(screen.getByRole("region", { name: "Goaty tasks" }).getByText(/narrow/i))
    .toBeVisible();
});

it("limits in-flight reads across superseded queries and starts the latest as slots free", async () => {
  setup();
  const releases: Array<() => void> = [];
  state.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve({ _tag: "Success", value: { tasks: [] } }));
      }),
  );
  const profiles = Array.from({ length: 6 }, (_, i) =>
    profile(`b${i}`, i === 0 ? "main" : "member", `Bot ${i}`),
  );
  await using screen = await render(<Search query="" profiles={profiles} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="a" profiles={profiles} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(state.read).toHaveBeenCalledTimes(4);
  await screen.rerender(<Search query="ab" profiles={profiles} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(state.read).toHaveBeenCalledTimes(4);
  await screen.rerender(<Search query="abc" profiles={profiles} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(state.read).toHaveBeenCalledTimes(4);
  await act(() => releases[0]?.());
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledTimes(5));
  expect(state.read.mock.calls[4]?.[0].input.query).toBe("abc");
  expect(state.read.mock.calls.some((call) => call[0].input.query === "ab")).toBe(false);
  await screen.rerender(<Search query="abc" profiles={profiles} enabled={false} />);
  await act(() => {
    for (const release of releases) release();
  });
});

it("stops reading and removes sections when capability is withdrawn", async () => {
  setup();
  state.read.mockResolvedValue({
    _tag: "Success",
    value: { tasks: [{ taskId: "t", title: "A task", createdAt: "2026-11-07T00:00:00.000Z" }] },
  });
  await using screen = await render(<Search query="" profiles={[bots[0]!]} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="work" profiles={[bots[0]!]} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect.element(screen.getByRole("button", { name: "A task" })).toBeVisible();
  state.supported = false;
  await screen.rerender(<Search query="other" profiles={[bots[0]!]} />);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(state.read).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "A task" }).query()).toBeNull();
});

it.each([false, true])("shows a cap notice only with continuation: %s", async (more) => {
  setup();
  state.read.mockImplementation(
    async ({ input }: { input: { cursor?: string; limit: number } }) => {
      const start = input.cursor === "c20" ? 20 : input.cursor === "c40" ? 40 : 0;
      return {
        _tag: "Success",
        value: {
          tasks: Array.from({ length: input.limit }, (_, i) => ({
            taskId: `t${start + i}`,
            title: `Result ${start + i}`,
            createdAt: "2026-11-07T00:00:00.000Z",
          })),
          ...(start < 40 || more ? { nextCursor: `c${start + input.limit}` } : {}),
        },
      };
    },
  );
  await using screen = await render(<Search query="" profiles={[bots[0]!]} />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="work" profiles={[bots[0]!]} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Result 39" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Result 49" })).toBeVisible();
  expect(
    screen
      .getByRole("region", { name: "Goaty tasks" })
      .getByText(/More tasks may exist/)
      .query() !== null,
  ).toBe(more);
});

it.each(["reject", "throw"] as const)(
  "shows a search error and frees its slot when a request %s",
  async (kind) => {
    setup();
    const first =
      kind === "throw"
        ? () => {
            throw new Error("offline");
          }
        : () => Promise.reject(new Error("offline"));
    state.read.mockImplementationOnce(first).mockResolvedValue({
      _tag: "Success",
      value: {
        tasks: [{ taskId: "ok", title: "Later result", createdAt: "2026-11-07T00:00:00.000Z" }],
      },
    });
    await using screen = await render(<Search query="" profiles={[bots[0]!]} />);
    using _clock = fakeTimers();
    await screen.rerender(<Search query="first" profiles={[bots[0]!]} />);
    await act(() => vi.advanceTimersByTimeAsync(250));
    await expect.element(screen.getByRole("button", { name: "Retry task search" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry task search" }));
    await expect.element(screen.getByRole("button", { name: "Later result" })).toBeVisible();
  },
);
