import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import "../../index.css";

// The timeline renders Markdown through ChatMarkdown, which reads other settings exports.
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

const rows: ReadonlyArray<GoatBotRow> = Array.from({ length: 40 }, (_, index) => ({
  kind: "user",
  sendKey: null,
  requestKey: null,
  id: `message-${index}`,
  text: `Message ${index}`,
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery: { state: "delivered" },
  showReceipt: false,
}));

const scroller = (container: HTMLElement) => {
  const element = container.querySelector<HTMLElement>(".goat-timeline > div");
  if (element === null) throw new Error("expected the timeline scroller");
  return element;
};
const distanceFromBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight;

it("stays on the newest message when a message grows after it rendered", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  document.body.append(host);
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    container: host,
    router: false, // The timeline renders no links that need a router.
  });
  const element = scroller(screen.container);
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // Markdown, code highlighting and images settle after the rows render.
  await act(() => {
    const last = screen.container.querySelector<HTMLElement>("li:last-child");
    if (last) last.style.paddingBottom = "300px";
  });
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  host.remove();
});

it("keeps following when a scroll event from its own move arrives after a message grew", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  document.body.append(host);
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    container: host,
    router: false, // The timeline renders no links that need a router.
  });
  const element = scroller(screen.container);
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // The browser delivers scroll events before resize callbacks: a late scroll event from the
  // timeline's own move to the bottom lands after the message grew, before it is followed.
  await act(() => {
    const last = screen.container.querySelector<HTMLElement>("li:last-child");
    if (last) last.style.paddingBottom = "300px";
    element.dispatchEvent(new Event("scroll"));
  });
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // Scrolling up by hand still stops the following.
  element.scrollTop = 0;
  element.dispatchEvent(new Event("scroll"));
  await act(() => {
    const last = screen.container.querySelector<HTMLElement>("li:last-child");
    if (last) last.style.paddingBottom = "600px";
  });
  await vi.waitFor(() => expect(element.scrollTop).toBe(0));
  host.remove();
});
