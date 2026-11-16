import { ThreadId, type EnvironmentId } from "@goat/contracts";
import { cloneElement, type ReactElement, type ReactNode, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

// The main row with its real waiting reads: only the server's answers and capabilities are fake.
const state = vi.hoisted(() => ({
  h2: true,
  governed: true,
  status: true,
  waitingRead: true,
  tracking: true,
  // false: connected, but the computer's config has not arrived yet.
  configKnown: true,
  // The hook keeps counts per environment in module state, so a test that needs a clean count
  // uses its own id.
  environmentId: "main-row-waiting" as EnvironmentId,
  getStatus: vi.fn(async (): Promise<{ bot: null; waitingCount: number }> => ({
    bot: null,
    waitingCount: 3,
  })),
  listTasks: vi.fn(async () => ({ tasks: [{ taskId: "legacy", status: "waiting_input" }] })),
  version: 0,
  listeners: new Set<() => void>(),
}));
const publish = () => {
  state.version++;
  for (const listener of state.listeners) listener();
};
const useTick = () =>
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    () => state.version,
  );
const port = { getBotStatus: state.getStatus, listTasks: state.listTasks };
vi.mock("./useGoatBotSession", () => ({
  useGoatBotEnabled: () => {
    useTick();
    return {
      enabled: true,
      generation: 1,
      port,
      environment: {
        environmentId: state.environmentId,
        connected: true,
        supportsBotStatus: state.status && state.configKnown,
        homeTarget: { settingsLoaded: state.configKnown },
      },
    };
  },
}));
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: unknown) => {
      useTick();
      if (atom === "governed") return state.h2 && state.governed;
      if (atom === "main-unread") return 0;
      if (atom === "main-work")
        return { eligible: true, list: "ready", work: { running: [], waiting: [], finished: [] } };
      if (atom === "configs")
        return new Map([
          [
            state.environmentId,
            {
              environment: {
                capabilities: {
                  goatBotTaskThreadsPaged: state.h2,
                  goatBotTaskLookupSearch: state.h2,
                  goatBotStatus: state.status,
                  goatBotWaitingRead: state.waitingRead,
                  threadVisitedTracking: state.tracking,
                },
              },
            },
          ],
        ]);
      return actual.useAtomValue(atom as never);
    },
  };
});
vi.mock("~/state/server", async (original) => ({
  ...(await original<typeof import("~/state/server")>()),
  environmentServerConfigsAtom: "configs",
}));
vi.mock("./goatBotGoverned", () => ({ goatBotGovernedAtom: () => "governed" }));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    homeCurrentOpenableWorkAtom: () => "main-work",
    homeCurrentUnreadAtom: () => "main-unread",
  },
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("~/globalAgentStore", () => ({
  useGlobalAgentStore: Object.assign(
    (select: (value: object) => unknown) =>
      select({ botRef: { environmentId: state.environmentId, threadId: ThreadId.make("bot") } }),
    { getState: () => ({ botRef: null }) },
  ),
}));
vi.mock("~/globalAgentRoute", async (original) => ({
  ...(await original<typeof import("~/globalAgentRoute")>()),
  isGoatBotRoute: () => false,
}));
vi.mock("~/threadRoutes", async (original) => ({
  ...(await original<typeof import("~/threadRoutes")>()),
  resolveThreadRouteTarget: () => null,
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (value: object) => unknown) =>
    selector({ threadLastVisitedAtById: {} }),
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("./useBotRoster", () => ({ useBotThreads: () => ({ rows: [], supported: false }) }));
vi.mock("./GoatBotMemberRows", () => ({ GoatBotMainMenu: () => null }));
vi.mock("./GoatBotModeButton", () => ({ useGoatBotPreferred: () => true }));
vi.mock("./goatBotChannelPort", async () => {
  const React = await import("react");
  return { GoatBotChannelContext: React.createContext(null) };
});
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ pathname: "/", search: {} }),
  useParams: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="/goat">{children}</a>,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ render: link, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(link, {}, children),
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
}));

import { GoatBotSidebarRow } from "./GoatBotSidebarRow";
import { refreshGoatBotWaitingCount } from "./useGoatBotWaitingCount";

function setup() {
  state.h2 = true;
  state.governed = true;
  state.status = true;
  state.waitingRead = true;
  state.tracking = true;
  state.configKnown = true;
  state.environmentId = "main-row-waiting" as EnvironmentId;
  state.getStatus.mockResolvedValue({ bot: null, waitingCount: 3 });
  state.getStatus.mockClear();
  state.listTasks.mockClear();
}
const change = (edit: () => void) => act(() => (edit(), publish()));
const counted = (count: number) => new RegExp(`^${count} waiting for you\\s*GOAT Bot`);

it("a governed main row counts only a successful visit-aware read, and marks the rest unavailable", async () => {
  setup();
  await using screen = await render(<GoatBotSidebarRow />, { router: false });
  await expect.element(screen.getByRole("link", { name: counted(3) })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  state.getStatus.mockRejectedValueOnce(new Error("offline"));
  await act(() => refreshGoatBotWaitingCount(state.environmentId, "failed"));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
  expect(screen.getByRole("link", { name: /waiting for you/ }).query()).toBeNull();
  await change(() => (state.waitingRead = false));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
  await change(() => ((state.waitingRead = true), (state.tracking = false)));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
});

it("a capable main row Home does not govern keeps the older count, and switches with governance", async () => {
  setup();
  state.governed = false;
  state.waitingRead = false;
  await using screen = await render(<GoatBotSidebarRow />, { router: false });
  await expect.element(screen.getByRole("link", { name: counted(3) })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  await change(() => (state.governed = true));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
  expect(screen.getByRole("link", { name: /waiting for you/ }).query()).toBeNull();
  await change(() => (state.governed = false));
  await expect.element(screen.getByRole("link", { name: counted(3) })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
});

it("an older server's main row keeps its legacy count with no marks", async () => {
  setup();
  state.h2 = false;
  state.status = false;
  await using screen = await render(<GoatBotSidebarRow />, { router: false });
  await expect.element(screen.getByRole("link", { name: counted(1) })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
});

it("the main row's count reads nothing while the computer's config is unknown, never the unscoped page, and keeps its last count (#3448)", async () => {
  setup();
  state.environmentId = "main-row-config-unknown" as EnvironmentId;
  state.governed = false;
  state.configKnown = false;
  await using screen = await render(<GoatBotSidebarRow />, { router: false });
  await expect.element(screen.getByRole("link", { name: /GOAT Bot/ })).toBeVisible();
  expect(state.listTasks).not.toHaveBeenCalled();
  expect(state.getStatus).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /waiting for you/ }).query()).toBeNull();
  await change(() => (state.configKnown = true));
  await expect.element(screen.getByRole("link", { name: counted(3) })).toBeVisible();
  expect(state.getStatus).toHaveBeenCalledTimes(1);
  await change(() => (state.configKnown = false));
  await expect.element(screen.getByRole("link", { name: counted(3) })).toBeVisible();
  expect(state.getStatus).toHaveBeenCalledTimes(1);
  expect(state.listTasks).not.toHaveBeenCalled();
});
