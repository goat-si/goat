import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";

vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

it("does not read layout or write scroll position for a text-only update", async () => {
  const row = (id: string, text: string): GoatBotRow => ({
    kind: "bot",
    id,
    text,
    createdAt: "2026-10-12T09:40:00Z",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  });
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const view = (rows: ReadonlyArray<GoatBotRow>) => (
    <GoatBotTimeline rows={rows} onRetry={() => {}} />
  );
  await using screen = await render(view([row("one", "First")]), {
    container: host,
    router: false,
  }); // No links in these rows.
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  using reads = vi.spyOn(scroll, "getBoundingClientRect");
  using writes = vi.spyOn(scroll, "scrollTop", "set");
  await screen.rerender(view([row("one", "Changed")]));
  expect(reads).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  await screen.rerender(view([row("one", "Changed"), row("two", "New")]));
  expect(writes).toHaveBeenCalledTimes(1);
});

it("keeps the cue and does no layout work for a text-only update while reading above, without a baseline (the task peek)", async () => {
  const row = (id: string, text: string): GoatBotRow => ({
    kind: "bot",
    id,
    text,
    createdAt: "2026-10-12T09:40:00Z",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  });
  const history = Array.from({ length: 30 }, (_, index) =>
    row(`h${index}`, `Earlier message ${index} with enough text to take a line or two.`),
  );
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:300px;width:360px";
  const view = (rows: ReadonlyArray<GoatBotRow>) => (
    <GoatBotTimeline rows={rows} onRetry={() => {}} />
  );
  await using screen = await render(view(history), { container: host, router: false }); // No links in these rows.
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  await screen.rerender(view([...history, row("new", "A reply is")]));
  const cue = screen.getByRole("button", { name: "Jump to latest", exact: true });
  await expect.element(cue).toBeVisible();
  using reads = vi.spyOn(scroll, "getBoundingClientRect");
  using writes = vi.spyOn(scroll, "scrollTop", "set");
  await screen.rerender(view([...history, row("new", "A reply is streaming in")]));
  await expect.element(cue).toBeVisible();
  expect(reads).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  expect(scroll.scrollTop).toBe(0);
});
