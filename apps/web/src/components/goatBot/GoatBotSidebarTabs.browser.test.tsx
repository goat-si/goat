import { BotThreadRow, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useGlobalAgentStore } from "~/globalAgentStore";

const actions = vi.hoisted(() => ({ show: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: "/", environmentId: "", threadId: "" }));
const bots = vi.hoisted(() => ({
  roster: [{ kind: "main", profile: { name: "Helper" } }] as Array<object>,
  members: [] as Array<object>,
  supportsMembers: false,
  memberShell: null as object | null,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: navigation.pathname, search: {} }),
  useParams: () => ({ environmentId: navigation.environmentId, threadId: navigation.threadId }),
  Link: ({
    to,
    params,
    children,
    ...props
  }: ComponentProps<"a"> & {
    to: string;
    params?: { environmentId: string; threadId: string };
  }) => (
    <a
      {...props}
      href={params ? `/${params.environmentId}/${params.threadId}` : to}
      onClick={(event) => {
        event.preventDefault();
        navigation.pathname = params ? `/${params.environmentId}/${params.threadId}` : to;
        navigation.environmentId = params?.environmentId ?? "";
        navigation.threadId = params?.threadId ?? "";
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("./useGoatBotHome", () => ({ useGoatBotHome: () => undefined }));
vi.mock("./useGoatBotSession", () => ({ useGoatBotEnabled: () => ({ enabled: true }) }));
vi.mock("./useGoatBotWaitingCount", () => ({ useGoatBotWaitingCount: () => 3 }));
vi.mock("./useGoatBotMemberStatus", () => ({
  useGoatBotMemberWaitingCount: () => 0,
  useGoatBotMemberStatus: () => ({ waitingCount: 0, latest: undefined }),
}));
vi.mock("~/state/entities", async (original) => {
  const entities = await original<typeof import("~/state/entities")>();
  return {
    ...entities,
    useThreadShell: (ref: Parameters<typeof entities.useThreadShell>[0]) => {
      const shell = entities.useThreadShell(ref);
      return ref?.threadId === "member-session" ? bots.memberShell : shell;
    },
  };
});
vi.mock("./GoatBotSidebarRow", () => ({
  GoatBotSidebarRow: ({ name }: { name: string }) => <div>{name} Main</div>,
}));
// The create form has its own test; here only that New bot opens it.
vi.mock("./GoatBotNewBotDialog", () => ({
  GoatBotNewBotDialog: () => <div role="dialog" aria-label="New bot" />,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => actions.update }));
vi.mock("~/localApi", () => {
  const api = () => ({ contextMenu: { show: actions.show } });
  return { readLocalApi: api, ensureLocalApi: api };
});
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    updateTaskView: { permissionAtom: () => null },
    createBot: { permissionAtom: () => null },
    setBotHidden: { permissionAtom: () => null },
    updateBot: { permissionAtom: () => null },
  },
}));
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, render }: { children: ReactNode; render?: ReactElement }) =>
    render ? cloneElement(render, {}, children) : <>{children}</>,
  TooltipPopup: () => null,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({
    render: link,
    children,
    isActive: _isActive,
    size: _size,
    ...props
  }: Omit<ComponentProps<"button">, "size"> & {
    render?: ReactElement;
    isActive?: boolean;
    size?: "default" | "icon" | "lg" | "sm";
    children: ReactNode;
  }) => (link ? cloneElement(link, props, children) : <button {...props}>{children}</button>),
}));
const at = "2026-11-04T10:00:00.000Z";
const decodeRow = Schema.decodeSync(BotThreadRow);
const rows = [
  Schema.decodeSync(BotThreadRow)({
    kind: "task",
    task: { taskId: "task-1", title: "Review work", status: "waiting_input", updatedAt: at },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: true,
    mainMessagesSinceQuiet: 0,
  }),
  Schema.decodeSync(BotThreadRow)({
    kind: "coding",
    taskId: "task-1",
    environmentId: "env-1",
    threadId: "thread-1",
    title: "Fix code",
    state: "bound",
    lastActivityAt: at,
  }),
];
vi.mock("./useBotRoster", () => ({
  useBotRoster: () => ({
    roster: [...bots.roster],
    groups: { main: null, members: bots.members, hidden: [], deleted: [] },
    supportsMembers: bots.supportsMembers,
    rows,
    rowsLoaded: true,
    environmentId: EnvironmentId.make("env-1"),
    refresh: actions.refresh,
    slackEnabled: false,
  }),
}));
import { GoatBotSidebarTabs } from "./GoatBotSidebarTabs";

it("Bots tab lists the main bot and its task threads and keeps its selection when a coding thread opens", async () => {
  useGlobalAgentStore.getState().setMode("thread");
  // The router is mocked to inspect navigation without mounting the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await userEvent.click(screen.getByRole("tab", { name: "Bots" }));
  await expect.element(screen.getByText("Helper Main")).toBeVisible();
  await expect.element(screen.getByText("Review work")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "GOAT thread: Fix code" })).toBeVisible();
  await userEvent.click(screen.getByText("Fix code"));
  await screen.rerender(<GoatBotSidebarTabs />);
  expect(navigation.pathname).toBe("/env-1/thread-1");
  await expect
    .element(screen.getByRole("tab", { name: "Bots" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByText("Fix code")).toBeVisible();
});

it("updates a task view and refreshes the roster after the server accepts it", async () => {
  actions.show.mockResolvedValue("pin");
  actions.update.mockResolvedValue({ _tag: "Success" });
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked so the test can focus on the task command.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await userEvent.click(screen.getByRole("button", { name: "Actions for Review work" }));
  await vi.waitFor(() =>
    expect(actions.update).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { taskId: "task-1", pinned: true },
    }),
  );
  expect(actions.refresh).toHaveBeenCalled();
});

it("expands and collapses older task rows", async () => {
  const extra = Array.from({ length: 6 }, (_, i) =>
    decodeRow({
      kind: "task",
      task: { taskId: `old-${i}`, title: `Older task ${i}`, status: "completed", updatedAt: at },
      view: { taskId: `old-${i}`, pinnedAt: null, doneAt: null, readThrough: at },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    }),
  );
  rows.push(...extra);
  try {
    useGlobalAgentStore.getState().setMode("bot");
    // The router is mocked to exercise roster disclosure without the application route tree.
    await using screen = await render(<GoatBotSidebarTabs />, { router: false });
    const more = screen.getByRole("button", { name: "Show more" });
    await expect.element(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    await expect.element(screen.getByText("Older task 5")).toBeVisible();
    const less = screen.getByRole("button", { name: "Show less" });
    await expect.element(less).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(less);
    await expect.element(screen.getByRole("button", { name: "Show more" })).toBeVisible();
    await expect.element(screen.getByText("Older task 5")).not.toBeInTheDocument();
  } finally {
    rows.splice(2);
  }
});

it("labels task status", async () => {
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to exercise the roster independently.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByRole("img", { name: "Needs your input" })).toBeInTheDocument();
});

it("opens the task actions with the keyboard and returns focus on Escape", async () => {
  const { showContextMenuFallback } = await import("~/contextMenuFallback");
  actions.show.mockImplementationOnce(showContextMenuFallback);
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked while the real browser context menu handles keyboard input.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  const row = screen.getByRole("link", { name: /Review work/ });
  await userEvent.click(row);
  await userEvent.keyboard("{Tab}");
  const action = screen.getByRole("button", { name: "Actions for Review work" });
  await expect.element(action).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(document.body.querySelector<HTMLElement>('[role="menu"]')!).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Escape}");
  await expect.element(action).toHaveFocus();
});

it("keeps New bot disabled until the server offers member bots", async () => {
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to render the roster without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByRole("button", { name: /New bot/ })).toBeDisabled();
  await expect.element(screen.getByText("Coming soon")).toBeVisible();
  bots.supportsMembers = true;
  try {
    await screen.rerender(<GoatBotSidebarTabs />);
    await expect.element(screen.getByRole("button", { name: "New bot" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "New bot" }));
    await expect.element(screen.getByRole("dialog", { name: "New bot" })).toBeInTheDocument();
  } finally {
    bots.supportsMembers = false;
  }
});

it("draws a member bot's face from its own session, never the main bot's waiting count", async () => {
  const { DateTime } = await import("effect");
  bots.supportsMembers = true;
  bots.members = [
    {
      botId: "member",
      role: "member",
      name: "Scout",
      environmentId: "env-1",
      sessionThreadId: "member-session",
    },
  ];
  bots.memberShell = {
    source: {
      activityRunStatus: "running",
      pendingRuntimeRequest: null,
      latestRunCompletedAt: null,
      status: "running",
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      createdAt: DateTime.makeUnsafe("2026-11-07T10:00:00.000Z"),
    },
  };
  try {
    useGlobalAgentStore.getState().setMode("bot");
    // The router is mocked to render the roster without the application route tree.
    await using screen = await render(<GoatBotSidebarTabs />, { router: false });
    const member = screen.getByRole("link", { name: /Scout/ });
    await expect.element(member.getByRole("img", { name: "Working" })).toBeInTheDocument();
    await expect
      .element(member.getByRole("img", { name: "Waiting for you" }))
      .not.toBeInTheDocument();
  } finally {
    bots.supportsMembers = false;
    bots.members = [];
    bots.memberShell = null;
  }
});
