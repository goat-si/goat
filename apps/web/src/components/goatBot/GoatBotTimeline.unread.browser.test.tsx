import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "../../index.css";

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
import { GoatBotTimeline } from "./GoatBotTimeline";

const bot = (i: number, createdAt = "2026-01-03T00:00:00Z"): GoatBotRow => ({
  kind: "bot",
  id: `bot-${i}`,
  text: `Message ${i}`,
  createdAt,
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
const rows: ReadonlyArray<GoatBotRow> = Array.from({ length: 40 }, (_, i) => bot(i));
const card: GoatBotRow = {
  kind: "task",
  id: "task",
  createdAt: "2026-01-01T00:00:00Z",
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task",
    revision: 2,
    updatedAt: "2026-01-03T00:00:00Z",
    title: "Work",
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "None" },
  },
};
const queuedSend: GoatBotRow = {
  kind: "user",
  id: "pending:send-1",
  sendKey: "send-1",
  requestKey: null,
  text: "Are you there?",
  createdAt: "2026-01-04T00:00:00Z",
  delivery: { state: "queued" },
  firstInGroup: true,
  groupPosition: "single",
  showReceipt: true,
};
const visit = "2026-01-02T00:00:00Z";
const timeline = (shown: ReadonlyArray<GoatBotRow>) => (
  <GoatBotTimeline rows={shown} unreadSince={visit} onRetry={() => {}} />
);
it("restores the unread pill when filtered arrivals leave the cue", async () => {
  using host = shortHost();
  await using screen = await render(timeline(rows), { container: host, router: false }); // This transcript contains no links.
  await expect.element(screen.getByRole("button", { name: "40 new messages" })).toBeVisible();
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop -= 200;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(timeline([...rows, bot(40), bot(41)]));
  await expect
    .element(screen.getByRole("button", { name: "Jump to latest (2 new)" }))
    .toBeVisible();
  await screen.rerender(timeline([...rows, bot(41)]));
  await expect.element(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await screen.rerender(timeline(rows));
  await expect.element(screen.getByRole("button", { name: "40 new messages" })).toBeVisible();
});
/** A transcript shorter than its rows, so the New line can sit above what is shown. */
function shortHost(): HTMLElement & Disposable {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:300px;width:360px";
  document.body.append(host);
  return Object.assign(host, { [Symbol.dispose]: () => host.remove() });
}

it("shows unread above the viewport, jumps to it without moving the page, and dismisses the pill", async () => {
  // The page clips a header above the transcript; the jump must not scroll it away.
  const page = document.createElement("div");
  page.style.cssText = "height:300px;width:360px;overflow:hidden";
  const header = document.createElement("div");
  header.style.cssText = "height:60px";
  page.append(header);
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:300px;width:360px";
  page.append(host);
  document.body.append(page);
  await using screen = await render(
    <GoatBotTimeline rows={rows} unreadSince={visit} onRetry={() => {}} />,
    {
      container: host,
      router: false, // This transcript contains no links.
    },
  );
  const divider = screen.getByLabelText("New messages", { exact: true });
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
  expect(page.scrollTop).toBe(0);
  scroll.scrollTop = scroll.scrollHeight;
  await expect.element(pill).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss new messages" }));
  await expect.element(pill).not.toBeInTheDocument();
  page.remove();
});

it("shows no unread marker when all rows were visited", async () => {
  await using screen = await render(
    <GoatBotTimeline rows={rows} unreadSince="2026-01-04T00:00:00Z" onRetry={() => {}} />,
    {
      router: false, // This transcript contains no links.
    },
  );
  await expect
    .element(screen.getByLabelText("New messages", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: /new messages/ }))
    .not.toBeInTheDocument();
});

it("moves focus to the New line on a keyboard jump, so the reader keeps their place", async () => {
  using host = shortHost();
  await using screen = await render(timeline(rows), {
    container: host,
    router: false, // This transcript contains no links.
  });
  const pill = screen.getByRole("button", { name: "40 new messages" });
  await expect.element(pill).toBeVisible();
  (pill.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  // The pill goes away once the line is in view; focus must not fall back to the page.
  await expect.element(pill).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(
      document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
    ).toBe("New messages"),
  );
  const line = screen.getByRole("listitem", { name: "New messages" });
  await expect.element(line).toHaveFocus();
  expect(document.activeElement?.nextElementSibling?.textContent).toContain("Message 0");
});

it("moves the New line past a work card hidden after opening and counts what is left", async () => {
  using host = shortHost();
  const old = Array.from({ length: 10 }, (_, i) => bot(i, "2026-01-01T00:00:00Z"));
  const fresh = Array.from({ length: 29 }, (_, i) => bot(10 + i));
  await using screen = await render(timeline([...old, card, ...fresh]), {
    container: host,
    router: false, // The task chip is mocked; nothing here links.
  });
  await expect.element(screen.getByRole("button", { name: "30 new messages" })).toBeVisible();
  await screen.rerender(timeline([...old, ...fresh]));
  const pill = screen.getByRole("button", { name: "29 new messages" });
  await expect.element(pill).toBeVisible();
  const line = screen.getByLabelText("New messages", { exact: true });
  await expect.element(line).toBeInTheDocument();
  expect(line.element().nextElementSibling?.textContent).toContain("Message 10");
  // The jump reaches the line instead of doing nothing.
  await userEvent.click(pill);
  await expect.element(pill).not.toBeInTheDocument();
});

it("places the New line when a message is sent before the history arrives", async () => {
  await using screen = await render(timeline([queuedSend]), {
    router: false, // This transcript contains no links.
  });
  await expect.element(screen.getByText("Are you there?")).toBeVisible();
  await screen.rerender(timeline([...rows, queuedSend]));
  const line = screen.getByLabelText("New messages", { exact: true });
  await expect.element(line).toBeInTheDocument();
  expect(line.element().nextElementSibling?.textContent).toContain("Message 0");
});
