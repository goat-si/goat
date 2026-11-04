import { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({ narrow: false, beside: true }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => state.beside }));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({}),
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("../components/goatBot/GoatBotChatView", () => ({
  GoatBotChatView: () => <div>Main chat</div>,
}));
vi.mock("../components/goatBot/GoatBotTaskPane", () => ({
  GoatBotTaskPane: ({ narrow }: { narrow: boolean }) => (
    <div>{narrow ? "Back to Tasks" : "Close"}</div>
  ),
}));
vi.mock("../components/goatBot/useGoatBotSession", () => ({ useGoatBotSession: () => ({}) }));
vi.mock("../components/goatBot/goatBotHooks", () => ({ useLegacyGlobalAgentRoute: () => null }));
vi.mock("../components/goatBot/useGoatBotHome", () => ({ useGoatBotHomeSettings: () => ({}) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => {},
}));
import { GoatBotTaskRoute } from "./_chat.bot";

it.each([
  { narrow: false, beside: true, overlay: false },
  { narrow: true, beside: true, overlay: true },
  { narrow: false, beside: false, overlay: true },
])(
  "chooses task layout for viewport and client preference %#",
  async ({ narrow, beside, overlay }) => {
    state.narrow = narrow;
    state.beside = beside;
    await using screen = await render(
      <GoatBotTaskRoute
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        taskId={ChannelTaskId.make("task")}
      />,
      { router: false },
    ); // Navigation is not exercised here.
    await expect.element(screen.getByText(overlay ? "Back to Tasks" : "Close")).toBeVisible();
    if (overlay) expect(screen.getByText("Main chat").query()).toBeNull();
    else await expect.element(screen.getByText("Main chat")).toBeVisible();
  },
);
