import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";

vi.mock("./useGoatBotFace", async (original) => ({
  ...(await original<typeof import("./useGoatBotFace")>()),
  useGoatBotReading: (since: string | null) => since !== null,
}));
import { GoatBotActivityStatus } from "./GoatBotActivityStatus";
import { GoatBotActivityContext } from "./GoatBotTimeline";

const row: Extract<GoatBotRow, { kind: "bot" }> = {
  kind: "bot",
  id: "reply",
  text: "Done",
  createdAt: "2026-10-12T09:40:00Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};
const announcement = { sequence: 1, row };
const view = (work: boolean, reply = false, reading = false) => (
  <GoatBotActivityContext value={work ? { state: "working", text: "Tool step" } : null}>
    <GoatBotActivityStatus
      replyingSince={reading ? "now" : null}
      announcement={reply ? announcement : null}
    />
  </GoatBotActivityContext>
);

it("keeps a reply across the first activity change and clears it on the second", async () => {
  await using screen = await render(view(true));
  const status = screen.getByRole("status");
  await screen.rerender(view(true, true));
  await expect.element(status).toHaveTextContent("GOAT Bot is working. GOAT Bot replied.");
  await screen.rerender(view(false, true));
  await expect.element(status).toHaveTextContent("GOAT Bot is done. GOAT Bot replied.");
  await screen.rerender(view(true, true));
  await expect.element(status).toHaveTextContent("GOAT Bot is working");
});

it("clears the reply immediately when the person sends a message", async () => {
  await using screen = await render(view(true));
  const status = screen.getByRole("status");
  await screen.rerender(view(true, true));
  await screen.rerender(view(false, true));
  await expect.element(status).toHaveTextContent("GOAT Bot is done. GOAT Bot replied.");
  await screen.rerender(view(false, true, true));
  await expect.element(status).toHaveTextContent("Reading your message");
});
