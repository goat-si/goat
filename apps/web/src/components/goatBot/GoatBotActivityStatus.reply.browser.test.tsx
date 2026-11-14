import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";

vi.mock("./useGoatBotFace", async (original) => ({
  ...(await original<typeof import("./useGoatBotFace")>()),
  useGoatBotReading: (since: string | null) => since !== null,
}));
import { GoatBotActivityStatus } from "./GoatBotActivityStatus";
import { GoatBotReplyStatus } from "./GoatBotReplyStatus";
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
    <GoatBotActivityStatus replyingSince={reading ? "now" : null} />
    <GoatBotReplyStatus
      replyingSince={reading ? "now" : null}
      announcement={reply ? announcement : null}
    />
  </GoatBotActivityContext>
);

it("keeps the reply unchanged across activity transitions", async () => {
  await using screen = await render(view(true));
  const reply = screen.getByRole("status", { name: "New bot reply" });
  await screen.rerender(view(true, true));
  await expect.element(reply).toHaveTextContent("GOAT Bot replied.");
  await screen.rerender(view(false, true));
  await expect.element(reply).toHaveTextContent("GOAT Bot replied.");
  await screen.rerender(view(true, true));
  await expect.element(reply).toHaveTextContent("GOAT Bot replied.");
});

it("clears the reply when the person sends a message", async () => {
  await using screen = await render(view(true));
  const reply = screen.getByRole("status", { name: "New bot reply" });
  await screen.rerender(view(true, true));
  await screen.rerender(view(true, true, true));
  await expect.element(reply).toHaveTextContent("");
});
