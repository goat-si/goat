import { BotThreadRow, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useGlobalAgentStore } from "~/globalAgentStore";

const actions = vi.hoisted(() => ({ show: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: "/", environmentId: "", threadId: "" }));
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
vi.mock("./GoatBotSidebarRow", () => ({
  GoatBotSidebarRow: ({ name }: { name: string }) => <div>{name} Main</div>,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => actions.update }));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: actions.show } }) }));
vi.mock("~/state/channels", () => ({
  channelEnvironment: { updateTaskView: { permissionAtom: () => null } },
}));
vi.mock("../ui/tooltip", () => ({
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
    ...props
  }: {
    render: ReactElement;
    children: ReactNode;
  }) => cloneElement(link, props, children),
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
    roster: [{ kind: "main", profile: { name: "Helper" } }],
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

it("labels task status and explains an empty bot roster", async () => {
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to exercise the roster independently.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByRole("img", { name: "Needs your input" })).toBeInTheDocument();
  const saved = rows.splice(0);
  await screen.rerender(<GoatBotSidebarTabs />);
  await expect.element(screen.getByText("Work GOAT Bot starts will appear here.")).toBeVisible();
  rows.push(...saved);
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
