import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: false,
  listThreads: vi.fn(() => "threads"),
  refresh: vi.fn(),
  items: [] as unknown[],
}));
vi.mock("./useGoatBotSession", () => ({
  useGoatBotEnabled: () => ({ environment: { environmentId: "env-1" } }),
}));
vi.mock("~/globalAgentStore", () => ({
  useGlobalAgentStore: (select: (state: unknown) => unknown) =>
    select({ botRef: { environmentId: "env-1", threadId: "bot" } }),
}));
vi.mock("~/state/entities", () => ({ useThreadVisibleTurnItems: () => state.items }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { goatBotTaskThreads: state.supported } } },
  }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBots: vi.fn(),
    listBotThreads: state.listThreads,
    slackSettings: vi.fn(),
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data: atom === "threads" ? { rows: [{ kind: "task" }], mainMessageCount: 0 } : null,
    refresh: state.refresh,
  }),
}));
import { useBotRoster } from "./useBotRoster";

function RosterProbe() {
  const { roster, rows } = useBotRoster();
  return (
    <span>
      {roster.length} bots, {rows.length} tasks
    </span>
  );
}

it("queries task threads only when the server advertises the capability", async () => {
  state.supported = false;
  state.listThreads.mockClear();
  // This probe has no route-dependent behavior.
  await using screen = await render(<RosterProbe />, { router: false });
  await expect.element(screen.getByText("1 bots, 0 tasks")).toBeVisible();
  expect(state.listThreads).not.toHaveBeenCalled();
  state.supported = true;
  await screen.rerender(<RosterProbe />);
  await expect.element(screen.getByText("1 bots, 1 tasks")).toBeVisible();
  expect(state.listThreads).toHaveBeenCalledWith({ environmentId: "env-1", input: {} });
});

it("refreshes the task roster when a new task chip appears", async () => {
  state.supported = true;
  state.items = [];
  state.refresh.mockClear();
  await using screen = await render(<RosterProbe />, { router: false });
  state.refresh.mockClear();
  state.items = [
    {
      sourceItemId: "chip-1",
      item: { type: "notification", ledgerTask: { taskId: "task-1" }, updatedAt: "2026-01-01" },
    },
  ];
  await screen.rerender(<RosterProbe />);
  expect(state.refresh).toHaveBeenCalled();
});
