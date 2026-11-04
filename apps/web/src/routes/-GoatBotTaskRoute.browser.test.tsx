import { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  narrow: false,
  beside: true,
  supported: true,
  task: undefined as string | undefined,
  sessions: [] as { marker: object }[],
  chatSession: null as object | null,
  paneSession: null as object | null,
  navigate: vi.fn(),
}));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => state.beside }));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({}),
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("../components/goatBot/GoatBotChatView", () => ({
  GoatBotChatView: (props: object) => {
    state.chatSession = props;
    return <div>Main chat</div>;
  },
}));
vi.mock("../components/goatBot/GoatBotTaskPane", () => ({
  GoatBotTaskPane: ({ narrow, session }: { narrow: boolean; session: object }) => {
    state.paneSession = session;
    return <div>{narrow ? "Back to Tasks" : "Close"}</div>;
  },
}));
vi.mock("../components/goatBot/useGoatBotSession", () => ({
  useGoatBotSession: () => {
    const session = {
      availability: { kind: "ready", bot: { environmentId: "env", threadId: "bot" } },
      supportsTaskThreads: state.supported,
      marker: {},
    };
    state.sessions.push(session);
    return session;
  },
}));
vi.mock("../components/goatBot/goatBotHooks", () => ({ useLegacyGlobalAgentRoute: () => null }));
vi.mock("../components/goatBot/useGoatBotHome", () => ({ useGoatBotHomeSettings: () => ({}) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
import { GoatBotTaskRoute, Route } from "./_chat.bot";
import type { useGoatBotSession } from "../components/goatBot/useGoatBotSession";

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
        session={{} as ReturnType<typeof useGoatBotSession>}
        taskId={ChannelTaskId.make("task")}
      />,
      { router: false },
    ); // Navigation is not exercised here.
    await expect.element(screen.getByText(overlay ? "Back to Tasks" : "Close")).toBeVisible();
    if (overlay) expect(screen.getByText("Main chat").query()).toBeNull();
    else await expect.element(screen.getByText("Main chat")).toBeVisible();
  },
);

it("shares the entry session between main chat and task pane", async () => {
  state.narrow = false;
  state.beside = true;
  state.supported = true;
  state.sessions = [];
  state.chatSession = null;
  state.paneSession = null;
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
  await expect.element(screen.getByText("Main chat")).toBeVisible();
  expect(state.sessions).toHaveLength(1);
  expect(state.paneSession).toBe(state.sessions[0]);
  expect(state.chatSession).toMatchObject({ marker: state.sessions[0]?.marker });
});

it("ignores a task query when the server lacks task threads", async () => {
  state.supported = false;
  state.navigate.mockClear();
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
  await expect.element(screen.getByText("Main chat")).toBeVisible();
  expect(screen.getByText("Close").query()).toBeNull();
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/$environmentId/$threadId", replace: true }),
  );
});
