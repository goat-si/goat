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
