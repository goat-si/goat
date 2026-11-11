import { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: true,
  revision: 0,
  data: null as unknown,
  error: null as string | null,
  refresh: vi.fn(),
  navigate: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ _tag: "Success", value: { revision: state.revision }, waiting: false }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      environment: {
        capabilities: {
          goatBotOpenAsks: state.supported,
          goatBotTaskChanges: true,
        },
      },
    },
  }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    taskChanges: () => "changes",
    listOpenAsks: (target: unknown) => {
      state.requested(target);
      return "asks";
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    error: state.error,
    refresh: state.refresh,
  }),
}));
vi.mock("~/components/RelativeTimeLabel", () => ({ RelativeTimeLabel: () => <span>1h</span> }));
import { GoatBotNeedsYou } from "./GoatBotNeedsYou";
import { dispatchMenuAction } from "~/shortcuts/dispatcher";

const environmentId = EnvironmentId.make("env");
const asks = [
  {
    botId: BotId.make("hidden"),
    taskId: ChannelTaskId.make("task-2"),
    kind: "question",
    text: "Which branch?",
    askedAt: "2026-11-11T00:00:00.000Z",
  },
  {
    botId: BotId.make("main"),
    taskId: ChannelTaskId.make("task-1"),
    kind: "approval",
    text: "Approve build?",
    askedAt: "2026-11-10T00:00:00.000Z",
  },
];
const bots = [
  { botId: "hidden", name: "Scout" },
  { botId: "main", name: "Helper" },
] as unknown as React.ComponentProps<typeof GoatBotNeedsYou>["bots"];
function setup(data: unknown, error: string | null = null) {
  state.supported = true;
  state.revision = 0;
  state.data = data;
  state.error = error;
  state.refresh.mockReset();
  state.navigate.mockReset();
  state.requested.mockReset();
}
const view = () => <GoatBotNeedsYou environmentId={environmentId} bots={bots} visible />;

it("hides for unsupported servers and empty results", async () => {
  setup({ asks: [], total: 0, truncated: false });
  state.supported = false;
  await using screen = await render(view());
  expect(state.requested).not.toHaveBeenCalled();
  expect(screen.container.textContent).toBe("");
  state.supported = true;
  await screen.rerender(view());
  expect(screen.container.textContent).toBe("");
});

it("summarizes, expands, and opens a hidden bot's task", async () => {
  setup({ asks, total: 50, truncated: true });
  await using screen = await render(view());
  const collapsed = screen.getByRole("button", { name: /Needs you · 50\+/ });
  expect(collapsed.element().textContent).toContain("Which branch? · Scout · 1h");
  await expect.element(collapsed).toHaveAttribute("aria-expanded", "false");
  state.refresh.mockClear();
  await userEvent.click(collapsed);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText("Approve build?")).toBeVisible();
  await expect.element(screen.getByText("Helper · 1h")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /Which branch\?/ }));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/bot",
    search: { bot: "hidden", task: "task-2" },
  });
});

it("retries a failed initial read", async () => {
  setup(null, "failed");
  await using screen = await render(view());
  await expect.element(screen.getByText("Couldn't check what waits for you.")).toBeVisible();
  state.refresh.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("keeps stale asks after a failed refresh and can retry", async () => {
  setup({ asks, total: 2, truncated: false }, "failed");
  await using screen = await render(view());
  await expect.element(screen.getByText(/may be out of date/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Needs you · 2/ })).toBeVisible();
  state.refresh.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("rereads when the shared task revision changes", async () => {
  setup({ asks, total: 2, truncated: false });
  await using screen = await render(view());
  state.refresh.mockClear();
  state.revision = 1;
  await screen.rerender(view());
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("cycles through asks with the registered command", async () => {
  setup({ asks, total: 2, truncated: false });
  await using _screen = await render(view());
  dispatchMenuAction("goatBot.nextAsk");
  dispatchMenuAction("goatBot.nextAsk");
  dispatchMenuAction("goatBot.nextAsk");
  expect(state.navigate.mock.calls.map(([options]) => options.search)).toEqual([
    { bot: "hidden", task: "task-2" },
    { task: "task-1" },
    { bot: "hidden", task: "task-2" },
  ]);
});
