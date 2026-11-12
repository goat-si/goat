import { forgetNewBotEnvironment, newBotSlot } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { SidebarProvider, useSidebar } from "../ui/sidebar";
import "~/index.css";

const decodeProfile = Schema.decodeSync(BotProfile);
const profile = (botId: string, name: string, environmentId = "env-1") =>
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

const state = vi.hoisted(() => ({
  create: (() => Promise.resolve({})) as (input: unknown) => Promise<unknown>,
}));
// The roster's list read, as a store, so a changed list or environment re-renders the roster as
// a real read does.
const roster = vi.hoisted(() => {
  type Bot = { readonly botId: string; readonly role: string; readonly state?: string };
  let snapshot = { environmentId: "env-1", bots: [] as ReadonlyArray<Bot> };
  const listeners = new Set<() => void>();
  return {
    read: () => snapshot,
    set: (next: Partial<typeof snapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
const channels = vi.hoisted(() => ({
  createBot: { permissionAtom: () => null },
  updateBot: { permissionAtom: () => null },
  setBotHidden: { permissionAtom: () => null },
  deleteBot: { permissionAtom: () => null },
  restoreBot: { permissionAtom: () => null },
  updateTaskView: { permissionAtom: () => null },
}));
vi.mock("~/state/channels", () => ({ channelEnvironment: channels }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === channels.createBot
      ? (input: unknown) => state.create(input)
      : async () => ({ _tag: "Success", value: {} }),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { goatBotProfileEdit: true } } },
  }),
}));
vi.mock("./useGoatBotHome", () => ({ useGoatBotHome: () => undefined }));
vi.mock("./useGoatBotSession", () => ({ useGoatBotEnabled: () => ({ enabled: true }) }));
vi.mock("./GoatBotNeedsYou", () => ({ GoatBotNeedsYou: () => null }));
vi.mock("./GoatBotSidebarRow", () => ({ GoatBotSidebarRow: () => null }));
vi.mock("./GoatBotAvatar", async (original) => ({
  ...(await original<typeof import("./GoatBotAvatar")>()),
  GoatBotSessionAvatar: () => null,
}));
vi.mock("./useGoatBotMemberStatus", () => ({
  useGoatBotMemberStatus: () => ({ waitingCount: 0, latest: undefined }),
}));
vi.mock("./useBotRoster", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useBotRoster: () => {
      const { environmentId, bots } = useSyncExternalStore(roster.subscribe, roster.read);
      return {
        bots,
        botsError: null,
        retryBots: () => {},
        roster: [{ kind: "main", profile: null }],
        groups: {
          main: null,
          members: bots.filter((bot) => bot.role === "member" && bot.state !== "deleted"),
          hidden: [],
          deleted: [],
        },
        supportsMembers: true,
        rows: [],
        rowsLoaded: true,
        environmentId,
        refresh: () => {},
        slackEnabled: false,
      };
    },
  };
});

import { GoatBotEditBotButton } from "./GoatBotEditBotButton";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotSidebarTabs } from "./GoatBotSidebarTabs";

/** A create answer the test releases when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const ada = profile("ada", "Ada");
const made = profile("made", "New bot");

function SidebarControls() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const show = (open: boolean) => (isMobile ? setOpenMobile(open) : setOpen(open));
  return (
    <>
      <button type="button" onClick={() => show(true)}>
        Show sidebar
      </button>
      <button type="button" onClick={() => show(false)}>
        Hide sidebar
      </button>
    </>
  );
}

function Roster() {
  return (
    <SidebarProvider>
      {/* The provider lays out a row; the roster gets a sidebar-sized column. */}
      <div className="w-80">
        <SidebarControls />
        <GoatBotSidebarTabs />
        {/* The open chat's own Edit bot, outside the roster. */}
        <GoatBotMemberContext value={ada}>
          <GoatBotEditBotButton />
        </GoatBotMemberContext>
      </div>
    </SidebarProvider>
  );
}

function setup() {
  forgetNewBotEnvironment(EnvironmentId.make("env-1"));
  forgetNewBotEnvironment(EnvironmentId.make("env-2"));
  roster.set({ environmentId: "env-1", bots: [ada] });
  const answer = deferred<unknown>();
  state.create = () => answer.promise;
  useGlobalAgentStore.getState().setMode("bot");
  return { answer: () => answer.resolve({ _tag: "Success", value: { bot: made } }) };
}

/** Renders the roster at /bot with the sidebar showing and clicks New bot; the create waits. */
async function clickNewBot() {
  const { answer } = setup();
  const screen = await render(<Roster />, { router: "/bot" });
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  await userEvent.click(screen.getByRole("button", { name: "New bot", exact: true }));
  await expect.element(screen.getByRole("status").getByText("Creating…")).toBeVisible();
  return { screen, answer };
}

const createdInStore = () =>
  vi.waitFor(() =>
    expect(newBotSlot(EnvironmentId.make("env-1")).created.map((bot) => bot.botId)).toEqual([
      "made",
    ]),
  );

it("the create answers while the person is still on the roster: its chat opens", async () => {
  const { screen, answer } = await clickNewBot();
  await using _screen = screen;
  answer();
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ bot: "made" }));
});

it.each<[string, (screen: Screen) => Promise<void>]>([
  [
    "another chat was selected",
    async (screen) => {
      await userEvent.click(screen.getByRole("link", { name: /Ada/ }));
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/env-1/thread-ada"),
      );
    },
  ],
  [
    "the Threads tab was chosen",
    (screen) => userEvent.click(screen.getByRole("tab", { name: "Threads" })),
  ],
  [
    "the sidebar collapsed",
    (screen) => userEvent.click(screen.getByRole("button", { name: "Hide sidebar" })),
  ],
  [
    "a member row menu is open",
    async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Ada options" }));
      await expect.element(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    },
  ],
  [
    "the member Edit dialog is open",
    async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Ada options" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Edit" }));
      await expect.element(page.getByRole("dialog", { name: "Edit bot" })).toBeVisible();
    },
  ],
  [
    "the chat's own Edit bot is open",
    async (screen) => {
      await userEvent.click(screen.getByRole("button", { name: "Edit bot" }));
      await expect.element(page.getByRole("dialog", { name: "Edit bot" })).toBeVisible();
    },
  ],
  ["the environment changed", () => act(() => roster.set({ environmentId: "env-2" }))],
])("nothing opens when, before the create answers, %s", async (_case, act) => {
  const { screen, answer } = await clickNewBot();
  await using _screen = screen;
  await act(screen);
  const router = screen.router;
  if (!router) throw new Error("the roster renders under a router");
  const before = router.state.location.href;
  using navigate = vi.spyOn(router, "navigate");
  answer();
  await createdInStore();
  expect(navigate).not.toHaveBeenCalled();
  expect(router.state.location.href).toBe(before);
});

it("the chat's own Edit bot blocks the open, and the created row stays to open by hand", async () => {
  const { screen, answer } = await clickNewBot();
  await using _screen = screen;
  await userEvent.click(screen.getByRole("button", { name: "Edit bot" }));
  await expect.element(page.getByRole("dialog", { name: "Edit bot" })).toBeVisible();
  answer();
  await createdInStore();
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await expect.element(screen.getByRole("link", { name: "New bot", exact: true })).toBeVisible();
  expect(screen.router?.state.location.search).toEqual({});
});

it("a menu whose row went away while it was open does not block a later open", async () => {
  const { screen, answer } = await clickNewBot();
  await using _screen = screen;
  await userEvent.click(screen.getByRole("button", { name: "Ada options" }));
  await expect.element(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  // Another device deleted Ada: the next list read drops her row, open menu and all.
  await act(() => roster.set({ bots: [] }));
  await expect.element(page.getByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
  answer();
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ bot: "made" }));
});

it("a create outlives the roster: switching to Threads and back shows the created row and frees New bot", async () => {
  const { screen, answer } = await clickNewBot();
  await using _screen = screen;
  await userEvent.click(screen.getByRole("tab", { name: "Threads" }));
  answer();
  await createdInStore();
  await userEvent.click(screen.getByRole("tab", { name: "Bots" }));
  await expect.element(screen.getByRole("link", { name: "New bot", exact: true })).toBeVisible();
  const newBot = screen.getByRole("button", { name: "New bot", exact: true });
  await expect.element(newBot).toBeEnabled();
  await expect.element(newBot).not.toHaveAttribute("aria-disabled", "true");
  expect(screen.router?.state.location.search).toEqual({});
});
