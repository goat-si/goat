import { forgetNewBotEnvironment, newBotSlot } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { CommandPaletteDialogFrame } from "../CommandPaletteDialogFrame";
import { CommandDialog } from "../ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Sidebar, SidebarProvider, useSidebar } from "../ui/sidebar";
import { useState } from "react";
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
  readBotArtifact: { permissionAtom: () => null },
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
// The palette's New bot, against the same server and list as the roster.
vi.mock("./goatBotPaletteItems", async (original) => ({
  ...(await original<typeof import("./goatBotPaletteItems")>()),
  useGoatBotPaletteNewBotSource: () => ({
    environmentId: roster.read().environmentId,
    listed: roster.read().bots,
    send: (input: unknown) => state.create(input),
  }),
}));
vi.mock("./readGoatBotEnvironmentId", () => ({
  readGoatBotEnvironmentId: () => roster.read().environmentId,
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
import { GoatBotFileViewer } from "./GoatBotFileViewer";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { resetNameRowFocusForTests } from "./goatBotNewBotOpen";
import { useGoatBotPaletteNewBot } from "./goatBotPaletteNewBot";
import { GoatBotSidebarTabs } from "./GoatBotSidebarTabs";
import { newBotOpenBlocked, resetNewBotOpenHoldsForTests } from "./newBotOpenHolds";

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

/** Something modal the person has open elsewhere in the app. */
type Overlay = "palette" | "dialog" | null;

/** Runs the palette's New bot item, as choosing it in the palette does. */
function PaletteNewBot() {
  const [item] = useGoatBotPaletteNewBot();
  return (
    <button type="button" onClick={() => void item?.run()}>
      Palette New bot
    </button>
  );
}

/** A Library or reply file the chat shows in place of the conversation, with no URL change. */
function OpenFile() {
  const [open, setOpen] = useState(false);
  return open ? (
    <GoatBotFileViewer
      environmentId={EnvironmentId.make("env-1")}
      file={{ relativePath: "notes.md", size: 12, modifiedAt: "2026-11-07T00:00:00.000Z" }}
      onClose={() => setOpen(false)}
    />
  ) : (
    <button type="button" onClick={() => setOpen(true)}>
      Open notes.md
    </button>
  );
}

function Roster({ overlay = null }: { readonly overlay?: Overlay }) {
  return (
    <SidebarProvider>
      {/* The provider lays out a row; the roster gets a sidebar-sized column. */}
      <div className="w-80">
        <SidebarControls />
        <PaletteNewBot />
        <GoatBotSidebarTabs />
        {/* The open chat's own Edit bot, outside the roster. */}
        <GoatBotMemberContext value={ada}>
          <GoatBotEditBotButton />
          <OpenFile />
        </GoatBotMemberContext>
      </div>
      <CommandDialog open={overlay === "palette"}>
        <CommandPaletteDialogFrame mode="command" setOpen={() => {}}>
          <input aria-label="Search commands" />
        </CommandPaletteDialogFrame>
      </CommandDialog>
      {/* Like the pull request checkout dialog: unrelated to bots, with a field being edited. */}
      <Dialog open={overlay === "dialog"}>
        <DialogPopup>
          <DialogTitle>Check out a pull request</DialogTitle>
          <input aria-label="Branch" />
        </DialogPopup>
      </Dialog>
    </SidebarProvider>
  );
}

function setup() {
  forgetNewBotEnvironment(EnvironmentId.make("env-1"));
  forgetNewBotEnvironment(EnvironmentId.make("env-2"));
  resetNewBotOpenHoldsForTests();
  resetNameRowFocusForTests();
  roster.set({ environmentId: "env-1", bots: [ada] });
  const answer = deferred<unknown>();
  const create = vi.fn((_input: unknown) => answer.promise);
  state.create = create;
  useGlobalAgentStore.getState().setMode("bot");
  return { create, answer: () => answer.resolve({ _tag: "Success", value: { bot: made } }) };
}

/** Renders the roster at /bot with the sidebar showing and clicks New bot; the create waits. */
async function clickNewBot() {
  const { create, answer } = setup();
  const screen = await render(<Roster />, { router: "/bot" });
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  await userEvent.click(screen.getByRole("button", { name: "New bot", exact: true }));
  await expect.element(screen.getByRole("status").getByText("Creating…")).toBeVisible();
  return { screen, create, answer };
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
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env-1/thread-made"));
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
  expect(screen.router?.state.location.pathname).toBe("/bot");
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
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env-1/thread-made"));
});

it.each([
  ["the roster", "New bot"],
  ["the palette", "Palette New bot"],
])(
  "a file opened in the chat before a create from %s answers keeps the chat, and the created row stays",
  async (_case, trigger) => {
    const { answer } = setup();
    await using screen = await render(<Roster />, { router: "/bot" });
    await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    await userEvent.click(screen.getByRole("button", { name: trigger, exact: true }));
    await expect.element(screen.getByRole("status").getByText("Creating…")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open notes.md" }));
    await expect.element(screen.getByRole("region", { name: "notes.md" })).toBeVisible();
    const router = screen.router;
    if (!router) throw new Error("the roster renders under a router");
    using navigate = vi.spyOn(router, "navigate");
    answer();
    await createdInStore();
    expect(navigate).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("region", { name: "notes.md" })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "New bot", exact: true })).toBeVisible();
    // Closing the file ends the hold: a later create opens its chat again.
    await userEvent.click(screen.getByRole("button", { name: "Close notes.md" }));
    expect(newBotOpenBlocked()).toBe(false);
  },
);

it.each<[string, Exclude<Overlay, null>, string]>([
  ["the command palette", "palette", "Command palette"],
  ["an unrelated dialog", "dialog", "Check out a pull request"],
])(
  "nothing opens while %s is open when the create answers, and the created row stays",
  async (_case, overlay, title) => {
    const { screen, answer } = await clickNewBot();
    await using _screen = screen;
    await screen.rerender(<Roster overlay={overlay} />);
    await expect.element(page.getByRole("dialog", { name: title })).toBeVisible();
    const router = screen.router;
    if (!router) throw new Error("the roster renders under a router");
    using navigate = vi.spyOn(router, "navigate");
    answer();
    await createdInStore();
    expect(navigate).not.toHaveBeenCalled();
    await screen.rerender(<Roster />);
    await expect.element(screen.getByRole("link", { name: "New bot", exact: true })).toBeVisible();
    expect(router.state.location.pathname).toBe("/bot");
  },
);

it("the roster's New bot opens the chat from the narrow sidebar sheet it lives in, then closes it", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 844);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const { answer } = setup();
  // The app's sidebar, which turns into a sheet on a narrow screen.
  await using screen = await render(
    <SidebarProvider>
      <SidebarControls />
      <Sidebar>
        <GoatBotSidebarTabs />
      </Sidebar>
    </SidebarProvider>,
    { router: "/bot" },
  );
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  const sheet = page.getByRole("dialog", { name: "Sidebar" });
  await userEvent.click(sheet.getByRole("button", { name: "New bot", exact: true }));
  await expect.element(sheet.getByRole("status").getByText("Creating…")).toBeVisible();
  answer();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env-1/thread-made"));
  await expect.element(sheet).not.toBeInTheDocument();
});

it.each([
  ["the roster, then the palette", ["New bot", "Palette New bot"]],
  ["the palette, then the roster", ["Palette New bot", "New bot"]],
])("New bot from %s while the first create runs: one bot is created", async (_case, buttons) => {
  const { create, answer } = setup();
  await using screen = await render(<Roster />, { router: "/bot" });
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  for (const name of buttons)
    // The roster's New bot is aria-disabled while a create runs; the press still reaches it.
    await userEvent.click(screen.getByRole("button", { name, exact: true }), { force: true });
  await expect.element(screen.getByRole("status").getByText("Creating…")).toBeVisible();
  expect(create).toHaveBeenCalledOnce();
  answer();
  await createdInStore();
  expect(create).toHaveBeenCalledOnce();
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
  expect(screen.router?.state.location.pathname).toBe("/bot");
});
