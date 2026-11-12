import { forgetNewBotEnvironment, newBotSlot } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { openCommandPalette } from "../../commandPaletteBus";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ToastProvider } from "../ui/toast";
import { disposeGoatBotEnvironment } from "./goatBotEnvironmentLifecycle";
import { resetNameRowFocusForTests } from "./goatBotNewBotOpen";
import { HoldsNavigation, resetNavigationHoldsForTests } from "~/lib/navigationHolds";

const decode = Schema.decodeSync(BotProfile);
const profile = (botId: string, role: "main" | "member", name: string) =>
  decode({
    botId,
    role,
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env-1",
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });

const state = vi.hoisted(() => ({
  send: (_input: unknown): Promise<unknown> => Promise.resolve({}),
  listed: [] as Array<object>,
}));
vi.mock("./goatBotPaletteItems", async (original) => ({
  ...(await original<typeof import("./goatBotPaletteItems")>()),
  useGoatBotPaletteBots: () => [],
  useGoatBotPaletteNewBotSource: () => ({
    environmentId: "env-1",
    listed: state.listed,
    send: (input: unknown) => state.send(input),
  }),
}));
vi.mock("./readGoatBotEnvironmentId", () => ({ readGoatBotEnvironmentId: () => "env-1" }));
import { CommandPalette } from "../CommandPalette";

/** A create answer the test releases when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const environmentId = EnvironmentId.make("env-1");
const made = profile("made", "member", "New bot 2");

function setup() {
  forgetNewBotEnvironment(environmentId);
  resetNavigationHoldsForTests();
  resetNameRowFocusForTests();
  state.listed = [profile("main", "main", "Goaty"), profile("first", "member", "New bot")];
  // The first create waits for `answer`, any later one for `later`.
  const answer = deferred<unknown>();
  const later = deferred<unknown>();
  const send = vi.fn((_input: unknown) =>
    send.mock.calls.length === 1 ? answer.promise : later.promise,
  );
  state.send = send;
  return { send, answer, later };
}

function App({
  dialog = false,
  held = false,
}: {
  readonly dialog?: boolean;
  readonly held?: boolean;
}) {
  return (
    <ToastProvider>
      <CommandPalette>{null}</CommandPalette>
      {/* Like a bot chat's message box with an unsent draft. */}
      {held ? <HoldsNavigation /> : null}
      {/* Like the pull request checkout dialog: unrelated to bots, with a field being edited. */}
      <Dialog open={dialog}>
        <DialogPopup>
          <DialogTitle>Check out a pull request</DialogTitle>
          <input aria-label="Branch" />
        </DialogPopup>
      </Dialog>
    </ToastProvider>
  );
}

async function renderPalette() {
  return render(<App />, { router: "/" });
}

async function runNewBot() {
  await act(() => openCommandPalette({ query: "new bot" }));
  await userEvent.click(page.getByRole("option", { name: /^New bot/ }));
}

const createdInStore = () =>
  vi.waitFor(() =>
    expect(newBotSlot(environmentId).created.map((bot) => bot.botId)).toEqual(["made"]),
  );

it("New bot runs the same create, and a second run while it is pending sends nothing", async () => {
  const { send } = setup();
  await using _screen = await renderPalette();
  await runNewBot();
  expect(send).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env-1",
    input: {
      clientRequestId: expect.any(String),
      name: "New bot 2",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    },
  });
  await act(() => openCommandPalette({ query: "new bot" }));
  const pending = page.getByText("Creating New bot 2…");
  await expect.element(pending).toBeVisible();
  expect(page.getByRole("option", { name: /^New bot/ }).query()).toBeNull();
  await userEvent.click(pending);
  await userEvent.keyboard("{Enter}");
  expect(send).toHaveBeenCalledOnce();
});

it("the palette closes, the create answers before its exit animation ends, and the chat opens", async () => {
  const { answer } = setup();
  // Hold the palette's exit, which Base UI waits out through getAnimations, so the answer arrives
  // while the closing palette is still in the page.
  const getAnimations = Element.prototype.getAnimations;
  const exit = { finished: new Promise<never>(() => {}), effect: null } as unknown as Animation;
  using _hold = vi.spyOn(Element.prototype, "getAnimations").mockImplementation(function (
    this: Element,
    options,
  ) {
    return this.matches("[data-command-palette]") ? [exit] : getAnimations.call(this, options);
  });
  await using screen = await renderPalette();
  await runNewBot();
  await vi.waitFor(() =>
    expect(document.querySelector("[data-command-palette]:not([data-open])")).not.toBeNull(),
  );
  answer.resolve({ _tag: "Success", value: { bot: made } });
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env-1/thread-made"));
});

it.each<[string, (screen: Screen) => Promise<void>]>([
  ["the palette was opened again for something else", () => act(() => openCommandPalette())],
  [
    "the person went somewhere else",
    async (screen) => {
      await act(() => screen.router?.navigate({ to: "/fleet" }));
    },
  ],
  [
    "an unrelated dialog was opened",
    async (screen) => {
      await screen.rerender(<App dialog />);
      await expect
        .element(page.getByRole("dialog", { name: "Check out a pull request" }))
        .toBeVisible();
    },
  ],
  ["a draft holds the open", (screen) => screen.rerender(<App held />)],
])(
  "nothing opens when, before the answer, %s, and a toast says the bot is ready",
  async (_case, move) => {
    const { answer } = setup();
    await using screen = await renderPalette();
    const router = screen.router;
    if (!router) throw new Error("the palette renders under a router");
    await runNewBot();
    await move(screen);
    const before = router.state.location.href;
    using navigate = vi.spyOn(router, "navigate");
    answer.resolve({ _tag: "Success", value: { bot: made } });
    await createdInStore();
    expect(navigate).not.toHaveBeenCalled();
    expect(router.state.location.href).toBe(before);
    await expect.element(page.getByText("New bot 2 is ready")).toBeVisible();
  },
);

it("a failed palette create shows a toast, and the item says to retry from Bots", async () => {
  const { answer } = setup();
  await using _screen = await renderPalette();
  await runNewBot();
  answer.resolve({ _tag: "Failure", cause: Cause.fail(new Error("The server is busy.")) });
  await expect.element(page.getByText("Couldn't create New bot 2")).toBeVisible();
  await expect.element(page.getByText("The server is busy.")).toBeVisible();
  await act(() => openCommandPalette({ query: "new bot" }));
  await expect.element(page.getByText("Couldn't create; open Bots to retry")).toBeVisible();
  expect(page.getByRole("option", { name: /^New bot/ }).query()).toBeNull();
});
it("the environment is removed while a palette create is pending: nothing opens, and its slot is forgotten", async () => {
  const { send, answer, later } = setup();
  await using screen = await renderPalette();
  const router = screen.router;
  if (!router) throw new Error("the palette renders under a router");
  await runNewBot();
  disposeGoatBotEnvironment(environmentId);
  expect(newBotSlot(environmentId).operation).toBeNull();
  using navigate = vi.spyOn(router, "navigate");
  answer.resolve({ _tag: "Success", value: { bot: made } });
  // A later create on the same environment answers after the forgotten one: only it opens.
  await runNewBot();
  expect(send).toHaveBeenCalledTimes(2);
  const next = profile("next", "member", "New bot 2");
  later.resolve({ _tag: "Success", value: { bot: next } });
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-1/thread-next"));
  expect(navigate).toHaveBeenCalledOnce();
  expect(newBotSlot(environmentId).created.map((bot) => bot.botId)).toEqual(["next"]);
});
