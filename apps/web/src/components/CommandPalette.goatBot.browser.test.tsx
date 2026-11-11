import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";

const decode = Schema.decodeSync(BotProfile);
const profile = (botId: string, role: "main" | "member", name: string, state?: "deleted") =>
  decode({
    botId,
    role,
    name,
    avatar: null,
    purpose: role === "member" ? "Reads papers." : "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env-1",
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...(state ? { state } : {}),
  });
const bots = vi.hoisted(() => ({ extra: 0 }));
vi.mock("./goatBot/goatBotPaletteItems", async (original) => ({
  ...(await original<typeof import("./goatBot/goatBotPaletteItems")>()),
  useGoatBotPaletteBots: () => [
    profile("main", "main", "Goaty"),
    profile("research", "member", "Research"),
    ...Array.from({ length: bots.extra }, (_, index) =>
      profile("helper-" + index, "member", "Helper " + index),
    ),
  ],
}));
import { CommandPalette } from "./CommandPalette";

function setup(extraBots = 0) {
  bots.extra = extraBots;
}

it("finds a member bot by name and opens its chat", async () => {
  setup();
  await using screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  await act(() => openCommandPalette({ query: "research" }));
  const item = page.getByRole("option", { name: /Open Research/ });
  await expect.element(item).toBeVisible();
  await userEvent.click(item);
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ bot: "research" }));
  await act(() => openCommandPalette({ query: "goaty" }));
  await expect.element(page.getByRole("option", { name: /Open Goaty/ })).toBeVisible();
});

it("keeps added bots out of the empty palette, however many there are, and finds them by name", async () => {
  // The server allows 50 bots; listing them all would push the palette's own actions down.
  setup(49);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  await act(() => openCommandPalette({ query: "" }));
  await expect.element(page.getByRole("option", { name: /Open Goaty/ })).toBeVisible();
  expect(page.getByRole("option", { name: /Open Research/ }).query()).toBeNull();
  expect(page.getByRole("option", { name: /Open Helper/ }).elements()).toHaveLength(0);
  await act(() => openCommandPalette({ query: "helper 12" }));
  await expect.element(page.getByRole("option", { name: /Open Helper 12/ })).toBeVisible();
});
