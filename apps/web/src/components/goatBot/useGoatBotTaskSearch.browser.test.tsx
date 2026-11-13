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
function Search({ query }: { query: string }) {
  const groups = useGoatBotTaskSearch(bots, query, true, state.navigate);
  return (
    <div>
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
            : { tasks: [] },
    }),
  );
  await using screen = await render(<Search query="" />);
  using _clock = fakeTimers();
  await screen.rerender(<Search query="papers" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect.element(screen.getByRole("button", { name: "Load more" })).toBeVisible();
  expect(state.read).toHaveBeenCalledWith(
    {
      environmentId: "env",
      input: { botId: "main", query: "papers" },
    },
    expect.any(AbortSignal),
  );
  expect(state.read).toHaveBeenCalledWith(
    {
      environmentId: "env",
      input: { botId: "research", query: "papers" },
    },
    expect.any(AbortSignal),
  );
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByRole("button", { name: "Find papers" })).toBeVisible();
  expect(state.read).toHaveBeenCalledWith(
    {
      environmentId: "env",
      input: { botId: "research", query: "papers", cursor: "next" },
    },
    expect.any(AbortSignal),
  );
  await expect.element(screen.getByText("Some results could not be checked.")).toBeVisible();
  await expect.element(screen.getByText("Search ended early.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Find papers" }));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/bot",
    search: { task: "t1", taskTitle: "Find papers", bot: "research" },
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
  await expect
    .element(
      screen.getByRole("region", { name: "Research tasks" }).getByText("Couldn't search tasks."),
    )
    .toBeVisible();
  await expect
    .element(
      screen
        .getByRole("region", { name: "Research tasks" })
        .getByRole("button", { name: "Retry task search" }),
    )
    .toBeVisible();
});

it("cancels an old query and ignores its late results", async () => {
  setup();
  let finish!: (value: unknown) => void;
  const old = new Promise((resolve) => {
    finish = resolve;
  });
  state.read.mockImplementation(({ input }: { input: { query: string } }) =>
    input.query === "old"
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
  await screen.rerender(<Search query="old" />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  const oldSignal = state.read.mock.calls[0]?.[1] as AbortSignal;
  expect(oldSignal.aborted).toBe(false);
  await screen.rerender(<Search query="new" />);
  expect(oldSignal.aborted).toBe(true);
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
