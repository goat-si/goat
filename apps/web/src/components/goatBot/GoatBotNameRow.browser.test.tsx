import { BotProfile } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useImperativeHandle, useRef, type Ref } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  update: (_input: unknown): Promise<unknown> => Promise.resolve({ _tag: "Success", value: {} }),
}));
// The edit permission as a store, so a grant arriving later re-renders the row as the atom does.
const permission = vi.hoisted(() => {
  let canEdit = true;
  const listeners = new Set<() => void>();
  return {
    read: () => canEdit,
    set: (next: boolean) => {
      canEdit = next;
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
vi.mock("~/state/channels", () => ({
  channelEnvironment: { updateBot: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => state.update(input),
}));
vi.mock("@effect/atom-react", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("@effect/atom-react")>()),
    useAtomValue: () => useSyncExternalStore(permission.subscribe, permission.read),
  };
});
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { goatBotProfileEdit: true } } },
  }),
}));

import type { GoatBotComposerHandle } from "./GoatBotComposer";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotNameRow } from "./GoatBotNameRow";
import { resetBotNameRowDismissalsForTests } from "./goatBotNameRowDismissed";
import { openNewBotChat, resetNameRowFocusForTests } from "./goatBotNewBotOpen";
import { navigationBlocked } from "~/lib/navigationHolds";

const decodeProfile = Schema.decodeSync(BotProfile);
let nextBot = 0;
const made = new Map<string, BotProfile>();
/** A fresh bot each time, so this browser's dismissals and focus marks never carry over. */
function member(name: string, overrides: { readonly state?: "deleted" } = {}) {
  nextBot += 1;
  const bot = decodeProfile({
    botId: `bot-${nextBot}`,
    role: "member",
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env-name-row",
    sessionThreadId: `thread-${nextBot}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  });
  made.set(bot.botId, bot);
  return bot;
}

function setup() {
  permission.set(true);
  resetNameRowFocusForTests();
  resetBotNameRowDismissalsForTests();
  localStorage.removeItem("goat:bot-name-row-dismissed:v1");
  // The server answers with the bot as it now is.
  const update = vi.fn(async (args: unknown): Promise<unknown> => {
    const { input } = args as { readonly input: { readonly botId: string } };
    const bot = made.get(input.botId);
    return { _tag: "Success", value: { bot: { ...bot, ...input } } };
  });
  state.update = update;
  return { update };
}

function FakeComposer({ ref }: { readonly ref: Ref<GoatBotComposerHandle> }) {
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    addFiles: () => {},
    offerDraft: () => true,
    focus: () => field.current?.focus(),
    field: () => field.current,
  }));
  return <textarea aria-label="Message" ref={field} />;
}

function Chat({ bot }: { readonly bot: BotProfile | null }) {
  const composer = useRef<GoatBotComposerHandle>(null);
  return (
    <GoatBotMemberContext value={bot}>
      <GoatBotNameRow composer={composer} />
      <FakeComposer ref={composer} />
    </GoatBotMemberContext>
  );
}

const nameField = () => page.getByRole("textbox", { name: "Name this bot" });

it("New bot 2 shows Name this bot; Ada, the main bot, a deleted member and a read-only viewer do not", async () => {
  setup();
  {
    await using _screen = await render(<Chat bot={member("New bot 2")} />);
    await expect.element(nameField()).toHaveValue("New bot 2");
  }
  for (const bot of [member("Ada"), null, member("New bot", { state: "deleted" })]) {
    await using screen = await render(<Chat bot={bot} />);
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
    expect(nameField().query()).toBeNull();
  }
  permission.set(false);
  await using screen = await render(<Chat bot={member("New bot 3")} />);
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(nameField().query()).toBeNull();
});

it("Enter saves the typed name, says why a save failed, and moves focus to the message box once named", async () => {
  const { update } = setup();
  const bot = member("New bot");
  await using screen = await render(<Chat bot={bot} />);
  await userEvent.click(nameField());
  // An unchanged name sends nothing.
  await userEvent.keyboard("{Enter}");
  expect(update).not.toHaveBeenCalled();
  update.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Not allowed.")) });
  await userEvent.fill(nameField(), "Ada");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Not allowed.");
  await expect.element(nameField()).toHaveValue("Ada");
  await userEvent.click(nameField());
  await userEvent.keyboard("{Enter}");
  expect(update).toHaveBeenLastCalledWith({
    environmentId: "env-name-row",
    input: { botId: bot.botId, name: "Ada" },
  });
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
});

it("a typed name holds back a New bot open until the chat has that name", async () => {
  setup();
  const bot = member("New bot");
  await using screen = await render(<Chat bot={bot} />);
  await expect.element(nameField()).toHaveValue("New bot");
  expect(navigationBlocked()).toBe(false);
  await userEvent.fill(nameField(), "Ada");
  expect(navigationBlocked()).toBe(true);
  await userEvent.keyboard("{Enter}");
  // The chat reads the saved name, as the member lookup does after a rename.
  await screen.rerender(<Chat bot={{ ...bot, name: "Ada" }} />);
  await expect.element(nameField()).not.toBeInTheDocument();
  expect(navigationBlocked()).toBe(false);
});

it("More opens Edit bot with the typed name, saves that name alone, and returns focus to the message box", async () => {
  const { update } = setup();
  const bot = member("New bot");
  await using screen = await render(<Chat bot={bot} />);
  await userEvent.fill(nameField(), "Scout");
  await userEvent.click(page.getByRole("button", { name: "More settings for New bot" }));
  const dialog = page.getByRole("dialog", { name: "Edit bot" });
  await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Scout");
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await expect.element(dialog).not.toBeInTheDocument();
  expect(update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env-name-row",
    input: { botId: bot.botId, name: "Scout" },
  });
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
});

it("Dismiss hides the row in this browser and moves focus to the message box", async () => {
  setup();
  const bot = member("New bot");
  {
    await using screen = await render(<Chat bot={bot} />);
    await userEvent.click(page.getByRole("button", { name: "Dismiss naming New bot" }));
    await expect.element(nameField()).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  }
  await using screen = await render(<Chat bot={bot} />);
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(nameField().query()).toBeNull();
});

it("the name field takes focus only when New bot opened the chat, on the bot's own thread, and only once", async () => {
  setup();
  const opened = member("New bot");
  await using screen = await render(<Chat bot={null} />, { router: "/" });
  const router = screen.router;
  if (!router) throw new Error("the chat renders under a router");
  // Opened any other way: focus stays where it was.
  await screen.rerender(<Chat bot={member("New bot 2")} />);
  await expect.element(nameField()).not.toHaveFocus();
  await screen.rerender(<Chat bot={null} />);
  await act(() => openNewBotChat(router, opened));
  expect(router.state.location.pathname).toBe(`/${opened.environmentId}/${opened.sessionThreadId}`);
  await screen.rerender(<Chat bot={opened} />);
  await expect.element(nameField()).toHaveFocus();
  // Coming back to the same chat later does not take focus again.
  await screen.rerender(<Chat bot={null} />);
  await screen.rerender(<Chat bot={opened} />);
  await expect.element(nameField()).not.toHaveFocus();
});

it("the focus mark ends when the person goes elsewhere before the chat shows its row", async () => {
  setup();
  const opened = member("New bot");
  await using screen = await render(<Chat bot={null} />, { router: "/" });
  const router = screen.router;
  if (!router) throw new Error("the chat renders under a router");
  await act(() => openNewBotChat(router, opened));
  await act(() => router.navigate({ to: "/fleet" }));
  await screen.rerender(<Chat bot={opened} />);
  await expect.element(nameField()).toBeVisible();
  await expect.element(nameField()).not.toHaveFocus();
});

it("a chat New bot opened without its name row never gives the row focus when it appears later", async () => {
  setup();
  // No edit permission yet: the chat opens without the row.
  permission.set(false);
  const opened = member("New bot");
  await using screen = await render(<Chat bot={null} />, { router: "/" });
  const router = screen.router;
  if (!router) throw new Error("the chat renders under a router");
  await act(() => openNewBotChat(router, opened));
  await screen.rerender(<Chat bot={opened} />);
  const message = screen.getByRole("textbox", { name: "Message" });
  await expect.element(message).toBeVisible();
  expect(nameField().query()).toBeNull();
  await userEvent.click(message);
  await act(() => permission.set(true));
  await expect.element(nameField()).toBeVisible();
  await expect.element(message).toHaveFocus();
});
