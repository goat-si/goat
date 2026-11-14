import { botRosterGroups } from "@goat/client-runtime/goatBot";
import { BotProfile, ChannelGatewayError, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  cloneElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useSyncExternalStore,
} from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import "~/index.css";

const server = vi.hoisted(() => ({
  bots: [] as Array<unknown>,
  version: 0,
  listeners: new Set<() => void>(),
  busy: false,
  toasts: [] as Array<{ title: string; description?: string }>,
  latest: {} as Record<string, { text: string; at: string; author: "bot" | "person" }>,
  waiting: {} as Record<string, number>,
  tasks: {} as Record<string, { active: boolean }>,
  work: {
    eligible: true,
    list: "ready",
    work: { running: [{ row: { unread: true } }], waiting: [], finished: [] },
  } as {
    eligible: boolean;
    list: string;
    work: {
      running: Array<{ row: { unread: boolean } }>;
      waiting: Array<{ row: { unread: boolean } }>;
      finished: Array<{ row: { unread: boolean } }>;
    };
  },
  h2: true,
  memberEligible: true,
  statusPending: false,
  statusAvailable: true,
  connected: true,
  waitingRead: true,
}));
const workAtoms = vi.hoisted(() => ({
  current: vi.fn((_key: readonly [string, string]) => "current-work"),
  unread: vi.fn((_key: readonly [string, string]) => "unread-count"),
}));
const publish = () => {
  server.version++;
  for (const listener of server.listeners) listener();
};

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
  Link: ({
    children,
    params: _params,
    to,
    ...props
  }: ComponentProps<"a"> & { params?: object; to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => {
    useSyncExternalStore(
      (listener) => {
        server.listeners.add(listener);
        return () => {
          server.listeners.delete(listener);
        };
      },
      () => server.version,
    );
    // Home governs an environment only while it is connected, both reads are offered, and every
    // bot on it is eligible.
    if (atom === "governed") return server.h2 && server.connected && server.memberEligible;
    // The bot's unread signal, as channelEnvironment.homeCurrentUnreadAtom derives it.
    if (atom === "unread-count") {
      const { eligible, list, work } = server.work;
      if (!eligible || list === "failed") return "unavailable";
      if (list === "pending") return "pending";
      return [...work.running, ...work.waiting, ...work.finished].filter((task) => task.row.unread)
        .length;
    }
    return atom === "current-work" ? server.work : true;
  },
}));
vi.mock("./goatBotGoverned", () => ({ goatBotGovernedAtom: () => "governed" }));
vi.mock("~/state/channels", () => {
  const command = (tag: string) => ({ tag, permissionAtom: () => null });
  return {
    channelEnvironment: {
      homeCurrentOpenableWorkAtom: workAtoms.current,
      homeCurrentUnreadAtom: workAtoms.unread,
      setBotHidden: command("hide"),
      deleteBot: command("delete"),
      restoreBot: command("restore"),
      updateBot: command("update"),
    },
  };
});
// A fake server: each command changes the stored bots the way channel.* does, and the roster
// re-renders from them, so a test sees the row move the way a person would.
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: { tag: string }) =>
    async ({ input }: { input: { botId: string; hidden?: boolean } }) => {
      const index = server.bots.findIndex((bot) => (bot as BotProfile).botId === input.botId);
      const bot = server.bots[index] as BotProfile;
      if (command.tag === "delete" && server.busy)
        return { _tag: "Failure", cause: new ChannelGatewayError({ reason: "bot_busy" }) };
      const next =
        command.tag === "hide"
          ? { ...bot, hidden: input.hidden }
          : command.tag === "delete"
            ? { ...bot, state: "deleted" as const }
            : command.tag === "restore"
              ? { ...bot, state: "active" as const }
              : bot;
      server.bots = server.bots.with(index, next);
      publish();
      return { _tag: "Success", value: { bot: next } };
    },
}));
vi.mock("@goat/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (toast: { title: string; description?: string }) => server.toasts.push(toast),
  },
}));
vi.mock("./useGoatBotMemberStatus", () => ({
  useGoatBotMemberStatus: (bot: BotProfile) => ({
    // Offline the member's status is not read at all, as useGoatBotMemberStatus does.
    waitingCount: server.connected ? (server.waiting[bot.botId] ?? 0) : 0,
    sidebarWaitingState: server.statusPending
      ? "pending"
      : server.connected && server.waitingRead && server.statusAvailable
        ? "ready"
        : "unavailable",
    sidebarWaitingCount:
      server.connected && server.waitingRead && server.statusAvailable
        ? (server.waiting[bot.botId] ?? 0)
        : undefined,
    latest: server.latest[bot.botId],
    tasks: server.tasks[bot.botId],
  }),
  useGoatBotMemberWaitingCount: (bot: BotProfile) => server.waiting[bot.botId] ?? 0,
}));
// The row's face reads its bot status alone: no conversation shell or items are loaded here.
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({
    connection: { phase: server.connected ? "connected" : "disconnected" },
    serverConfig: {
      environment: {
        capabilities: {
          goatBotTaskThreadsPaged: server.h2,
          goatBotTaskLookupSearch: server.h2,
          goatBotMembers: true,
          goatBotProfiles: true,
          goatBotProfileEdit: true,
          goatBotStatus: true,
          goatBotWaitingRead: server.waitingRead,
        },
      },
    },
  }),
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("./GoatBotModeButton", () => ({ useGoatBotPreferred: () => false }));
vi.mock("./useGoatBotWaitingCount", () => ({ useGoatBotWaitingCount: () => 0 }));
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ render: link, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(link, {}, children),
}));

import { GoatBotMemberRoster } from "./GoatBotMemberRows";

const decodeProfile = Schema.decodeSync(BotProfile);
const environmentId = EnvironmentId.make("env-1");
const profile = (botId: string, name: string) =>
  decodeProfile({
    botId,
    role: "member",
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId,
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });

function Roster() {
  const bots = useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.bots,
  ) as BotProfile[];
  return <GoatBotMemberRoster environmentId={environmentId} groups={botRosterGroups(bots)} />;
}

function setup() {
  workAtoms.current.mockClear();
  workAtoms.unread.mockClear();
  server.bots = [profile("research", "Research")];
  server.busy = false;
  server.toasts = [];
  server.latest = {};
  server.waiting = {};
  server.tasks = {};
  server.work = { eligible: true, list: "ready", work: { running: [], waiting: [], finished: [] } };
  server.h2 = true;
  server.memberEligible = true;
  server.statusPending = false;
  server.statusAvailable = true;
  server.connected = true;
  server.waitingRead = true;
}

it("hides a member under Hidden bots and shows it again", async () => {
  setup();
  await using _screen = await render(<Roster />, { router: false });
  await userEvent.click(page.getByRole("button", { name: "Research options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Hide" }));
  const hidden = page.getByRole("button", { name: "Hidden bots (1)" });
  await expect.element(hidden).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Research" })).not.toBeInTheDocument();
  await userEvent.click(hidden);
  await userEvent.click(page.getByRole("button", { name: "Research options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Show" }));
  await expect.element(page.getByRole("link", { name: "Research" })).toBeVisible();
  await expect.element(page.getByText(/Hidden bots/)).not.toBeInTheDocument();
});

it("asks before deleting and tells the person to stop open tasks when the bot is busy", async () => {
  setup();
  server.busy = true;
  await using _screen = await render(<Roster />, { router: false });
  await userEvent.click(page.getByRole("button", { name: "Research options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Delete" }));
  await expect
    .element(page.getByText("Its conversation is archived; you can restore it."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Delete" }));
  await vi.waitFor(() =>
    expect(server.toasts).toEqual([
      {
        type: "error",
        title: "Couldn't delete Research",
        description: "Stop its open tasks first.",
      },
    ]),
  );
  await expect.element(page.getByRole("link", { name: "Research" })).toBeVisible();
});

it("moves a deleted member to Deleted bots and restores it", async () => {
  setup();
  await using _screen = await render(<Roster />, { router: false });
  await userEvent.click(page.getByRole("button", { name: "Research options" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Delete" }));
  await userEvent.click(page.getByRole("button", { name: "Delete" }));
  const restore = page.getByRole("button", { name: "Restore Research" });
  await expect.element(restore).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Research" })).not.toBeInTheDocument();
  await userEvent.click(restore);
  await expect.element(page.getByRole("link", { name: "Research" })).toBeVisible();
  await expect.element(page.getByText("Deleted bots")).not.toBeInTheDocument();
});

it("a member's row shows its newest message, the person's prefixed with You, else its purpose", async () => {
  setup();
  server.bots = [
    { ...profile("research", "Research"), purpose: "Reads papers." },
    { ...profile("builds", "Builds"), purpose: "Checks builds." },
    { ...profile("fresh", "Fresh"), purpose: "Brand new." },
  ];
  server.latest = {
    research: { text: "Found **three** papers.", at: "2026-11-07T01:00:00.000Z", author: "bot" },
    builds: { text: "is main green?", at: "2026-11-07T01:00:00.000Z", author: "person" },
  };
  await using screen = await render(<Roster />, { router: false });
  await expect.element(screen.getByText("Found three papers.")).toBeVisible();
  await expect.element(screen.getByText("You: is main green?")).toBeVisible();
  await expect.element(screen.getByText("Brand new.")).toBeVisible();
  expect(screen.getByText("Reads papers.").query()).toBeNull();
});

it("a member whose person message is unanswered reads Reading first", async () => {
  setup();
  const now = Date.parse("2026-11-07T01:00:30.000Z");
  using _now = vi.spyOn(Date, "now").mockReturnValue(now);
  server.latest = {
    research: { text: "is main green?", at: "2026-11-07T01:00:00.000Z", author: "person" },
  };
  await using screen = await render(<Roster />, { router: false });
  await expect.element(screen.getByRole("link", { name: /^Reading\s*Research/ })).toBeVisible();
});

it("a working member's row is named Working first", async () => {
  setup();
  server.latest = {
    research: { text: "On it.", at: "2026-11-07T01:00:00.000Z", author: "bot" },
  };
  server.tasks = { research: { active: true } };
  await using screen = await render(<Roster />, { router: false });
  await expect.element(screen.getByRole("link", { name: /^Working\s*Research/ })).toBeVisible();
});

it("says waiting once, with the count, on a member whose tasks wait for the person", async () => {
  setup();
  server.waiting = { research: 2 };
  await using screen = await render(<Roster />, { router: false });
  const link = screen.getByRole("link", { name: /^2 waiting for you\s*Research/ });
  await expect.element(link).toBeVisible();
  await expect.element(link).not.toHaveAccessibleName(/waiting[\s\S]*waiting/i);
});

it("a member row stops reading once the bot answers, and once the reading limit passes", async () => {
  setup();
  const start = Date.parse("2026-11-07T01:00:00.000Z");
  const at = (ms: number) => new Date(start + ms).toISOString();
  using _now = vi.spyOn(Date, "now").mockReturnValue(start + 30_000);
  server.latest = { research: { text: "is main green?", at: at(0), author: "person" } };
  await using screen = await render(<Roster />, { router: false });
  const named = (name: RegExp) => screen.getByRole("link", { name }).query();
  await expect.element(screen.getByRole("link", { name: /^Reading\s*Research/ })).toBeVisible();
  using _timers = fakeTimers();
  vi.setSystemTime(start + 30_000);
  const status = async (latest: (typeof server.latest)[string]) => {
    server.latest = { research: latest };
    server.bots = [...server.bots];
    await act(() => publish());
  };
  // The bot's reply becomes the newest message; the face holds its last state for 1.2 s.
  await status({ text: "Yes, it is green.", at: at(31_000), author: "bot" });
  await act(() => vi.advanceTimersByTime(1_300));
  expect(named(/^Reading/)).toBeNull();
  expect(named(/^Research/)).not.toBeNull();
  // A new message the bot never answers reads until the 90 s limit, then stops.
  await status({ text: "and the nightly?", at: at(32_000), author: "person" });
  await act(() => vi.advanceTimersByTime(1_300));
  expect(named(/^Reading\s*Research/)).not.toBeNull();
  await act(() => vi.advanceTimersByTime(90_000));
  expect(named(/^Reading/)).toBeNull();
  expect(named(/^Research/)).not.toBeNull();
});

it("member row reports recent unread work and marks unavailable signals independently", async () => {
  setup();
  server.waiting = { research: 2 };
  server.work = {
    ...server.work,
    work: { ...server.work.work, running: [{ row: { unread: true } }] },
  };
  await using screen = await render(<Roster />, { router: false });
  await expect
    .element(screen.getByLabelText(/1 unread task.*recent work only; older work may be missing/i))
    .toBeVisible();
  server.work = { ...server.work, list: "failed" };
  server.bots = server.bots.map((bot) => ({ ...(bot as BotProfile) }));
  await act(() => publish());
  await expect.element(screen.getByLabelText(/unread.*unavailable/i)).toBeVisible();
  expect(screen.getByLabelText(/1 unread task/i).query()).toBeNull();
  server.work = { ...server.work, list: "ready" };
  server.statusAvailable = false;
  server.bots = server.bots.map((bot) => ({ ...(bot as BotProfile) }));
  await act(() => publish());
  await expect.element(screen.getByLabelText(/waiting.*unavailable/i)).toBeVisible();
  server.statusAvailable = true;
  server.waitingRead = false;
  await act(() => publish());
  await expect.element(screen.getByLabelText(/waiting.*unavailable/i)).toBeVisible();
  server.connected = false;
  server.bots = server.bots.map((bot) => ({ ...(bot as BotProfile) }));
  await act(() => publish());
  // Offline, Home no longer governs the environment, so the row is the older one with no mark.
  await expect.element(screen.getByRole("link", { name: /^Research/ })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
});

it("keeps legacy waiting and omits new marks on an older server", async () => {
  setup();
  server.h2 = false;
  server.statusAvailable = false;
  server.waiting = { research: 2 };
  server.work = { ...server.work, eligible: false, list: "failed" };
  await using screen = await render(<Roster />, { router: false });
  await expect
    .element(screen.getByRole("link", { name: /^2 waiting for you\s*Research/ }))
    .toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  expect(screen.getByLabelText(/unread task/i).query()).toBeNull();
});
it("leaves first pending signals blank and marks failed or offline signals", async () => {
  setup();
  server.statusPending = true;
  server.statusAvailable = false;
  server.work = { ...server.work, list: "pending" };
  await using screen = await render(<Roster />, { router: false });
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  expect(screen.getByLabelText(/unread task/i).query()).toBeNull();
  server.statusPending = false;
  server.work = { ...server.work, list: "failed" };
  await act(() => publish());
  await expect
    .element(screen.getByLabelText(/unread and waiting unavailable/i))
    .toHaveAttribute("title", "Unread and waiting unavailable");
  server.work = { ...server.work, list: "pending" };
  server.statusPending = true;
  server.connected = false;
  await act(() => publish());
  await expect.element(screen.getByRole("link", { name: /^Research/ })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
});

it("a capable environment Home does not govern keeps the legacy row, and switches with governance", async () => {
  setup();
  server.memberEligible = false;
  server.waitingRead = false;
  server.waiting = { research: 2 };
  server.work = { ...server.work, list: "failed" };
  await using screen = await render(<Roster />, { router: false });
  await expect
    .element(screen.getByRole("link", { name: /^2 waiting for you\s*Research/ }))
    .toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  server.memberEligible = true;
  server.bots = server.bots.map((bot) => ({ ...(bot as BotProfile) }));
  await act(() => publish());
  await expect.element(screen.getByLabelText(/unread and waiting unavailable/i)).toBeVisible();
  expect(screen.getByRole("link", { name: /^2 waiting for you/ }).query()).toBeNull();
  server.memberEligible = false;
  server.bots = server.bots.map((bot) => ({ ...(bot as BotProfile) }));
  await act(() => publish());
  await expect
    .element(screen.getByRole("link", { name: /^2 waiting for you\s*Research/ }))
    .toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
});

it("a row Home does not govern subscribes to none of its bot's work", async () => {
  setup();
  server.memberEligible = false;
  await using screen = await render(<Roster />, { router: false });
  await expect.element(screen.getByRole("link", { name: /Research/ })).toBeVisible();
  expect(workAtoms.current).not.toHaveBeenCalled();
  expect(workAtoms.unread).not.toHaveBeenCalled();
});
