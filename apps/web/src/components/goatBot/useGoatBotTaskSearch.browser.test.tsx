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
    input: { botId: "main", query: "papers" },
  });
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "env",
    input: { botId: "research", query: "papers" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Find papers" })).toBeVisible();
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "env",
    input: { botId: "research", query: "papers", cursor: "next" },
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
  await using screen = await render(<Search query="papers" />);
  expect(state.read).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: /tasks/ }).query()).toBeNull();
});

it("shows a search error without claiming there were no results", async () => {
  setup();
  state.read.mockResolvedValue({ _tag: "Failure" });
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
  await act(() => finish({ _tag: "Failure" }));
  expect(screen.getByRole("status", { name: "Bot task search" }).element().textContent).toBe("");
  expect(screen.getByRole("button", { name: "Retry task search" }).query()).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});
