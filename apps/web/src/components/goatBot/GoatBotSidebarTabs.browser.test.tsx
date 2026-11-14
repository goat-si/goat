import { forgetNewBotEnvironment, newBotSlot } from "@goat/client-runtime/goatBot";
import { BotProfile, BotThreadRow, EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useGlobalAgentStore } from "~/globalAgentStore";

const actions = vi.hoisted(() => ({
  show: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  refresh: vi.fn(),
  retryBots: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ pathname: "/", environmentId: "", threadId: "" }));
const bots = vi.hoisted(() => ({
  roster: [{ kind: "main", profile: { name: "Helper" } }] as Array<object>,
  profiles: [] as Array<object>,
  members: [] as Array<object>,
  supportsMembers: false,
  memberShell: null as object | null,
  error: null as string | null,
  eligible: false,
  rosterKnown: true,
}));
const channels = vi.hoisted(() => ({
  homeCurrentOpenableWorkAtom: () => "current-work",
  homeCurrentUnreadAtom: () => "unread-count",
  updateTaskView: { permissionAtom: () => null },
  createBot: { permissionAtom: () => null },
  setBotHidden: { permissionAtom: () => null },
  updateBot: { permissionAtom: () => null },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: navigation.pathname, search: {} }),
  useParams: () => ({ environmentId: navigation.environmentId, threadId: navigation.threadId }),
  useNavigate: () => (options: { to: string }) => {
    navigation.pathname = options.to;
    return Promise.resolve();
  },
  useRouter: () => ({
    state: { location: { href: navigation.pathname } },
    navigate: (options: { to: string }) => {
      navigation.pathname = options.to;
      return Promise.resolve();
    },
    subscribe: () => () => {},
  }),
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
  useGoatBotMemberStatus: () => ({ waitingCount: 0, sidebarWaitingCount: 0, latest: undefined }),
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { goatBotProfileEdit: true } } },
  }),
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
vi.mock("./GoatBotNeedsYou", () => ({ GoatBotNeedsYou: () => null }));
vi.mock("./GoatBotSidebarRow", () => ({
  GoatBotSidebarRow: ({ name }: { name: string }) => <div>{name} Main</div>,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === "governed"
      ? bots.rosterKnown && bots.eligible
      : atom === "unread-count"
        ? 0
        : atom === "current-work"
          ? { eligible: true, list: "ready", work: { running: [], waiting: [], finished: [] } }
          : true,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === channels.createBot ? actions.create : actions.update,
}));
vi.mock("~/localApi", () => {
  const api = () => ({ contextMenu: { show: actions.show } });
  return { readLocalApi: api, ensureLocalApi: api };
});
vi.mock("./goatBotGoverned", () => ({ goatBotGovernedAtom: () => "governed" }));
vi.mock("~/state/channels", () => ({ channelEnvironment: channels }));
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
  useSidebarVisibility: () => true,
  useSidebar: () => ({ setOpenMobile: () => {} }),
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
    bots: bots.supportsMembers ? bots.profiles : undefined,
    botsError: bots.error,
    retryBots: actions.retryBots,
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
import { resetNameRowFocusForTests } from "./goatBotNewBotOpen";
import { resetNavigationHoldsForTests } from "~/lib/navigationHolds";

/** A create answer the test releases when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const decodeProfile = Schema.decodeSync(BotProfile);
const profile = (botId: string, name: string, state?: "deleted") =>
  decodeProfile({
    botId,
    role: "member",
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env-1",
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...(state ? { state } : {}),
  });

function setup() {
  forgetNewBotEnvironment(EnvironmentId.make("env-1"));
  resetNavigationHoldsForTests();
  resetNameRowFocusForTests();
  bots.roster = [{ kind: "main", profile: { name: "Helper" } }];
  bots.profiles = [];
  bots.members = [];
  bots.supportsMembers = false;
  bots.memberShell = null;
  bots.error = null;
  bots.eligible = false;
  bots.rosterKnown = true;
  actions.create.mockReset();
  navigation.pathname = "/";
  navigation.environmentId = "";
  navigation.threadId = "";
  useGlobalAgentStore.getState().setMode("thread");
}

it("Bots tab lists the main bot and its task threads and keeps its selection when a coding thread opens", async () => {
  setup();
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
  setup();
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
  setup();
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
  setup();
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to exercise the roster independently.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByRole("img", { name: "Needs your input" })).toBeInTheDocument();
});

it("opens the task actions with the keyboard and returns focus on Escape", async () => {
  setup();
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

it("keeps New bot disabled until the server offers member bots and its list has loaded", async () => {
  setup();
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to render the roster without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByRole("button", { name: /New bot/ })).toBeDisabled();
  await expect.element(screen.getByText("Coming soon")).toBeVisible();
  bots.supportsMembers = true;
  await screen.rerender(<GoatBotSidebarTabs />);
  await expect.element(screen.getByRole("button", { name: "New bot" })).toBeEnabled();
});

it("one click sends createBot named New bot 2 beside a deleted New bot, with no dialog, and a second click sends nothing", async () => {
  setup();
  bots.supportsMembers = true;
  bots.profiles = [profile("old", "New bot", "deleted")];
  const answer = deferred<object>();
  actions.create.mockReturnValue(answer.promise);
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to render the roster without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  const newBot = screen.getByRole("button", { name: "New bot" });
  await userEvent.click(newBot);
  await expect.element(screen.getByRole("status").getByText("New bot 2")).toBeVisible();
  await expect.element(screen.getByRole("status").getByText("Creating…")).toBeVisible();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(actions.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env-1",
    input: {
      clientRequestId: expect.any(String),
      name: "New bot 2",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    },
  });
  // While it runs the button stays focusable but says it is unavailable, and sends nothing.
  await expect.element(newBot).toHaveAttribute("aria-disabled", "true");
  // Playwright will not click an aria-disabled control; a person's click still reaches it.
  newBot.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(actions.create).toHaveBeenCalledOnce();
  // The create answered before the roster read it: the created row stands in until the list has it.
  const created = profile("made", "New bot 2");
  answer.resolve({ _tag: "Success", value: { bot: created } });
  await expect.element(screen.getByRole("link", { name: "New bot 2" })).toBeVisible();
  await expect.element(newBot).not.toHaveAttribute("aria-disabled", "true");
  bots.profiles = [profile("old", "New bot", "deleted"), created];
  bots.members = [created];
  await screen.rerender(<GoatBotSidebarTabs />);
  await expect
    .element(screen.getByRole("button", { name: "Dismiss New bot 2" }))
    .not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /New bot 2/ }).elements()).toHaveLength(1);
});

it("failure shows the reason, Retry resends the same request, Dismiss frees New bot", async () => {
  setup();
  bots.supportsMembers = true;
  actions.create.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("The server is busy.")),
  });
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to render the roster without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  const newBot = screen.getByRole("button", { name: "New bot" });
  await userEvent.click(newBot);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't create New bot: The server is busy.");
  await expect.element(newBot).toHaveAttribute("aria-disabled", "true");
  const firstId = actions.create.mock.calls[0]?.[0].input.clientRequestId;
  actions.create.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Still busy.")),
  });
  await userEvent.click(screen.getByRole("button", { name: "Retry creating New bot" }));
  await vi.waitFor(() => expect(actions.create).toHaveBeenCalledTimes(2));
  expect(actions.create.mock.calls[1]?.[0].input).toMatchObject({
    clientRequestId: firstId,
    name: "New bot",
  });
  await userEvent.click(screen.getByRole("button", { name: "Dismiss creating New bot" }));
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(newBot).not.toHaveAttribute("aria-disabled", "true");
  expect(newBotSlot(EnvironmentId.make("env-1")).operation).toBeNull();
});

it("a list read that fails after a create keeps New bot enabled, shows the created row and offers Retry", async () => {
  setup();
  bots.supportsMembers = true;
  actions.create.mockResolvedValueOnce({
    _tag: "Success",
    value: { bot: profile("made", "New bot") },
  });
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to render the roster without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await userEvent.click(screen.getByRole("button", { name: "New bot" }));
  await expect.element(screen.getByRole("link", { name: "New bot" })).toBeVisible();
  // The re-read after the create failed; the roster keeps its last good list.
  bots.error = "The environment request failed.";
  await screen.rerender(<GoatBotSidebarTabs />);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't load bots: The environment request failed.");
  await userEvent.click(screen.getByRole("button", { name: "Retry loading bots" }));
  expect(actions.retryBots).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("link", { name: "New bot" })).toBeVisible();
  const newBot = screen.getByRole("button", { name: "New bot", exact: true });
  await expect.element(newBot).toBeEnabled();
  await expect.element(newBot).not.toHaveAttribute("aria-disabled", "true");
});

it("draws a member bot's face from its own session, never the main bot's waiting count", async () => {
  setup();
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

it("removes legacy child rows when eligible and restores them when eligibility is withdrawn", async () => {
  setup();
  bots.eligible = true;
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to inspect the sidebar without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByText("Helper Main")).toBeVisible();
  expect(screen.getByText("Review work").query()).toBeNull();
  expect(screen.getByRole("button", { name: "Actions for Review work" }).query()).toBeNull();
  bots.eligible = false;
  await screen.rerender(<GoatBotSidebarTabs />);
  await expect.element(screen.getByText("Review work")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Actions for Review work" }))
    .toBeVisible();
});

it("keeps legacy child rows while the member roster is unknown, even with every listed bot eligible", async () => {
  setup();
  bots.eligible = true;
  bots.rosterKnown = false;
  useGlobalAgentStore.getState().setMode("bot");
  // The router is mocked to inspect the sidebar without the application route tree.
  await using screen = await render(<GoatBotSidebarTabs />, { router: false });
  await expect.element(screen.getByText("Review work")).toBeVisible();
  bots.rosterKnown = true;
  await screen.rerender(<GoatBotSidebarTabs />);
  await vi.waitFor(() => expect(screen.getByText("Review work").query()).toBeNull());
});
