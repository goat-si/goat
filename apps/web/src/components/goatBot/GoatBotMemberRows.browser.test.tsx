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
  listeners: new Set<() => void>(),
  busy: false,
  toasts: [] as Array<{ title: string; description?: string }>,
  latest: {} as Record<string, { text: string; at: string; author: "bot" | "person" }>,
  waiting: {} as Record<string, number>,
}));
const publish = () => {
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
  useAtomValue: () => true,
}));
vi.mock("~/state/channels", () => {
  const command = (tag: string) => ({ tag, permissionAtom: () => null });
  return {
    channelEnvironment: {
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
    waitingCount: server.waiting[bot.botId] ?? 0,
    latest: server.latest[bot.botId],
  }),
  useGoatBotMemberWaitingCount: (bot: BotProfile) => server.waiting[bot.botId] ?? 0,
}));
// The row's face reads its bot status alone: no conversation shell or items are loaded here.
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
  server.bots = [profile("research", "Research")];
  server.busy = false;
  server.toasts = [];
  server.latest = {};
  server.waiting = {};
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
