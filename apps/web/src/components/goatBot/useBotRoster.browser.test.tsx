import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: false,
  listThreads: vi.fn(() => "threads"),
}));
vi.mock("./useGoatBotSession", () => ({
  useGoatBotEnabled: () => ({ environment: { environmentId: "env-1" } }),
}));
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
    refresh: vi.fn(),
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
