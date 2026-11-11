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
vi.mock("./goatBot/goatBotPaletteItems", async (original) => ({
  ...(await original<typeof import("./goatBot/goatBotPaletteItems")>()),
  useGoatBotPaletteBots: () => [
    profile("main", "main", "Goaty"),
    profile("research", "member", "Research"),
  ],
}));
import { CommandPalette } from "./CommandPalette";

it("finds a member bot by name and opens its chat", async () => {
  await using screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  await act(() => openCommandPalette({ query: "research" }));
  const item = page.getByRole("option", { name: /Open Research/ });
  await expect.element(item).toBeVisible();
  await userEvent.click(item);
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ bot: "research" }));
  await act(() => openCommandPalette({ query: "goaty" }));
  await expect.element(page.getByRole("option", { name: /Open Goaty/ })).toBeVisible();
});
