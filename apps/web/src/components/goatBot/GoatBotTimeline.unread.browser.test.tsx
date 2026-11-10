import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
import { GoatBotTimeline } from "./GoatBotTimeline";

const rows: ReadonlyArray<GoatBotRow> = Array.from({ length: 40 }, (_, i) => ({
  kind: "bot",
  id: `bot-${i}`,
  text: `Message ${i}`,
  createdAt: "2026-01-03T00:00:00Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
}));

it("shows unread above the viewport, jumps to it, and dismisses the pill", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:300px;width:360px";
  document.body.append(host);
  await using screen = await render(
    <GoatBotTimeline rows={rows} unreadSince="2026-01-02T00:00:00Z" onRetry={() => {}} />,
    {
      container: host,
      router: false, // This transcript contains no links.
    },
  );
  const divider = screen.getByRole("separator", { name: "New messages" });
  await expect.element(divider).toBeInTheDocument();
  const pill = screen.getByRole("button", { name: "40 new messages" });
  await expect.element(pill).toBeVisible();
  await userEvent.click(pill);
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div");
  if (!scroll) throw new Error("missing scroller");
  await vi.waitFor(() => {
    const marker = screen.container.querySelector<HTMLElement>('[aria-label="New messages"]');
    if (!marker) throw new Error("missing divider");
    expect(marker.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      scroll.getBoundingClientRect().top - 1,
    );
    expect(marker.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroll.getBoundingClientRect().bottom,
    );
  });
  scroll.scrollTop = scroll.scrollHeight;
  await expect.element(pill).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss new messages" }));
  await expect.element(pill).not.toBeInTheDocument();
  host.remove();
});

it("shows no unread marker when all rows were visited", async () => {
  await using screen = await render(
    <GoatBotTimeline rows={rows} unreadSince="2026-01-04T00:00:00Z" onRetry={() => {}} />,
    {
      router: false, // This transcript contains no links.
    },
  );
  await expect
    .element(screen.getByRole("separator", { name: "New messages" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: /new messages/ }))
    .not.toBeInTheDocument();
});
